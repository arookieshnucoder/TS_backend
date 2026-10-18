import assert from "node:assert/strict";
import test from "node:test";
import { createDependencies, type DependencyOverrides } from "../src/bootstrap/container.js";
import { createChatAgent, type ChatAgentOptions } from "../src/bootstrap/chat-agent.js";
import { loadConfig } from "../src/config/env.js";
import { AgentHarness } from "../src/modules/harness/agent-harness.js";
import { defineReadOnlyTool } from "../src/modules/harness/define-tool.js";
import type { AgentModel } from "../src/modules/agent/model.js";
import type { AgentRuntime, AgentWorkflow } from "../src/modules/agent/contracts.js";
import type { ChatAgent } from "../src/modules/chat/service/chat-agent.js";
import { ChatSessionService } from "../src/modules/chat/service/chat-session.service.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";
import { ElasticsearchMemorySearch, LocalMemorySearch } from "../src/infrastructure/llm/memory-search.js";
import { TokenBudget } from "../src/modules/harness/context/tokens.js";
import { HarnessChatAgent } from "../src/modules/chat/service/harness-chat-agent.js";

const config = loadConfig({ NODE_ENV: "test", AGENT_WORKSPACE_ENABLED: "false" });
const logger = { info() {}, error() {} };
const instructions = { system: "A custom research workflow", final: "Return the verified result" };

test("dependency injection rejects obsolete, misspelled, null and conflicting overrides before using a default provider", () => {
  const agent: ChatAgent = { async run() { return { content: "injected" }; }, async titleFor(s) { return s.title; } };
  for (const overrides of [
    { chatModel: { reply() {} } }, { contextHarness: null }, { agentModle: {} },
    { agentModel: null }, { agentModel: undefined }, { agentModel: false }, { agentModel: { reply() {} } },
    { agentHarness: null }, { agentHarness: false }, { agentHarness: { run() {} } },
    { agentHarness: agent, agentModel: { turn() {} } },
  ]) assert.throws(() => createDependencies(overrides as unknown as DependencyOverrides, config), TypeError);
  const isolated = { ...config, get context(): never { throw new Error("Default model/harness must not be assembled"); } };
  assert.equal(createDependencies({ agentHarness: agent }, isolated).agentHarness, agent);
});

test("generic harness runs an injected workflow with custom instructions and tools without chat or Ask wiring", async () => {
  let modelCalls = 0, toolCalls = 0;
  const workflow: AgentWorkflow = { async run(runtime) {
    assert.deepEqual(runtime.tools.map(tool => tool.name), ["custom_lookup"]);
    const tool = await runtime.execute({ id: "lookup", name: "custom_lookup", arguments: {} });
    assert.equal(tool.content, "verified evidence");
    const messages = await runtime.prepare([], true);
    assert.equal(messages[0]!.content, `${instructions.system}\n${instructions.final}`);
    assert.equal(messages.at(-1)!.content, "question");
    const answer = await runtime.complete(messages, []);
    return { content: answer.content, modelTurns: 1, toolCalls: 1 };
  } };
  const model: AgentModel = { async turn() { modelCalls++; return { content: "custom answer", toolCalls: [] }; } };
  const harness = new AgentHarness(model, workflow, instructions, config.context, logger);
  const result = await harness.run({ history: [], question: "question", metadata: {}, tools: [defineReadOnlyTool({
    name: "custom_lookup", description: "Custom lookup", parameters: {},
    async execute() { toolCalls++; return "verified evidence"; },
  })] });
  assert.deepEqual(result, { content: "custom answer", modelTurns: 1, toolCalls: 1 });
  assert.equal(modelCalls, 1); assert.equal(toolCalls, 1);
});

test("chat run metadata preserves missing request IDs and records message identity separately", async () => {
  const metadata: Record<string, unknown>[] = [];
  const agent = new HarnessChatAgent({ async run(input) {
    metadata.push(input.metadata); return { content: "answer", modelTurns: 1, toolCalls: 0 };
  } }, async () => [], async s => s.title);
  const session = { id: "session", requestId: "created", title: "title", createdAt: new Date(), updatedAt: new Date(),
    messages: [], sessionStatus: "finished" as const, sessionError: null, modelRequestId: null as string | null };
  const message = { id: "message", role: "user" as const, content: "question" };
  await agent.run(session, message);
  assert.equal(metadata[0]!.requestId, null);
  assert.equal(metadata[0]!.messageId, "message");
  session.modelRequestId = "actual-request";
  await agent.run(session, message);
  assert.equal(metadata[1]!.requestId, "actual-request");
});

test("chat assembly rejects removed flags and invalid strategies instead of selecting defaults", () => {
  const model: AgentModel = { async turn() { throw new Error("must not run"); } };
  for (const options of [{ generateTitles: false }, { tools: null }, { tools: undefined }, { title: false },
    { profile: null }, { profile: { workflow: {}, instructions } }]) {
    assert.throws(() => createChatAgent(new InMemoryChatSessionRepository(), model,
      () => { throw new Error("must not construct memory"); }, config.context, logger, options as unknown as ChatAgentOptions), TypeError);
  }
});

test("failed custom workflow propagates without switching to Ask or calling the model directly", async () => {
  let modelCalls = 0;
  const model: AgentModel = { async turn() { modelCalls++; return { content: "must not be used", toolCalls: [] }; } };
  const harness = new AgentHarness(model, { async run() { throw new Error("workflow unavailable"); } }, instructions, config.context, logger);
  await assert.rejects(harness.run({ history: [], question: "question", metadata: {}, tools: [] }), /workflow unavailable/);
  assert.equal(modelCalls, 0);
});

test("runtime methods retain cancellation even when a custom workflow omits its signal", async () => {
  const abort = new AbortController();
  let runtime!: AgentRuntime;
  let models = 0, executions = 0;
  const model: AgentModel = { async turn() { models++; return { content: "unused", toolCalls: [] }; } };
  const harness = new AgentHarness(model, { async run(value) {
    runtime = value; abort.abort();
    return { content: "late answer", modelTurns: 0, toolCalls: 0 };
  } }, instructions, config.context, logger);
  await assert.rejects(harness.run({ history: [], question: "question", metadata: {}, tools: [defineReadOnlyTool({
    name: "lookup", description: "lookup", parameters: {},
    async execute() { executions++; return "unused"; },
  })] }, abort.signal), { name: "AbortError" });
  await assert.rejects(runtime.prepare([], false), { name: "AbortError" });
  await assert.rejects(runtime.complete([], []), { name: "AbortError" });
  await assert.rejects(runtime.execute({ id: "late", name: "lookup", arguments: {} }), { name: "AbortError" });
  assert.equal(models, 0); assert.equal(executions, 0);
});

test("custom chat tool wiring does not read the default repository or construct a memory adapter", async () => {
  const repository = new InMemoryChatSessionRepository();
  const noDefault = (): never => { throw new Error("Default memory wiring must not be used"); };
  repository.findAll = noDefault;
  const agent = createChatAgent(repository, { async turn() { return { content: "answer", toolCalls: [] }; } }, noDefault,
    config.context, logger, { tools: async () => [], title: async s => s.title,
      profile: { instructions, workflow: { async run(runtime) {
        assert.deepEqual(runtime.tools, []);
        const messages = await runtime.prepare([], false);
        assert.equal(messages[0]!.content, instructions.system);
        return { content: (await runtime.complete(messages, [])).content, modelTurns: 1, toolCalls: 0 };
      } } } });
  const session = { id: "s", requestId: "r", title: "title", createdAt: new Date(), updatedAt: new Date(),
    messages: [], sessionStatus: "finished" as const, sessionError: null };
  assert.equal((await agent.run(session, { id: "q", role: "user", content: "question" })).content, "answer");
});

test("failed title generation preserves the actual existing title instead of manufacturing a placeholder", async () => {
  const repository = new InMemoryChatSessionRepository();
  let titleCalls = 0;
  const agent = createChatAgent(repository, { async turn(messages) {
    if (messages[0]!.content.startsWith("Generate")) { titleCalls++; return { content: "bad", toolCalls: [] }; }
    return { content: "answer", toolCalls: [] };
  } }, () => new LocalMemorySearch(new TokenBudget(config.context)), config.context,
  logger);
  const service = new ChatSessionService(repository, agent);
  const session = await service.create("用户自定标题", "request");
  const result = await service.send(session.id, "question");
  assert.equal(result.sessionStatus, "finished");
  assert.equal(result.title, session.title);
  assert.equal(result.messages.length, 2);
  assert.equal(titleCalls, 2);
  // 标题端口应传播异常，由会话服务负责保留已提交答案。
  await assert.rejects(agent.titleFor(result), /invalid session title twice/);
});

test("title errors and cancellation preserve the already committed answer", async () => {
  for (const cancel of [false, true]) {
    const repository = new InMemoryChatSessionRepository();
    const abort = new AbortController();
    let first = true;
    const agent = createChatAgent(repository, { async turn() { return { content: "answer", toolCalls: [] }; } },
      () => new LocalMemorySearch(new TokenBudget(config.context)), config.context, logger, { title: async s => {
        const saved = await repository.findById(s.id);
        assert.equal(saved!.sessionStatus, "finished");
        assert.deepEqual(saved!.messages, s.messages);
        if (first) {
          first = false;
          if (!cancel) throw new Error("title failed");
          abort.abort();
          return new Promise<string>(() => {});
        }
        return s.title;
      } });
    const service = new ChatSessionService(repository, agent);
    const session = await service.create("title", "request");
    const completed = await service.send(session.id, "first", abort.signal);
    assert.equal(completed.sessionStatus, "finished");
    assert.deepEqual(completed.messages.map(m => m.content), ["first", "answer"]);
    const retry = await service.send(session.id, "retry");
    assert.equal(retry.sessionStatus, "finished");
    assert.deepEqual(retry.messages.map(m => m.content), ["first", "answer", "retry", "answer"]);
  }
});

test("configured Elasticsearch failure is propagated without invoking local retrieval", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  try {
    const search = new ElasticsearchMemorySearch(new TokenBudget(config.context), { ...config.context, elasticsearchUrl: "http://unused.invalid" });
    assert.equal(search instanceof LocalMemorySearch, false);
    await assert.rejects(search.sync([]), /Memory index unavailable/);
    await assert.rejects(search.search("question", ["session"], 1), /Memory index request failed/);
  } finally { globalThis.fetch = originalFetch; }
});

test("title timeout preserves the answer and ignores a non-cooperating provider's late result", async () => {
  const repository = new InMemoryChatSessionRepository();
  let release!: (title: string) => void;
  let pendingTitle = true;
  const agent = createChatAgent(repository, { async turn() { return { content: "answer", toolCalls: [] }; } },
    () => new LocalMemorySearch(new TokenBudget(config.context)), config.context, logger, { title: async s =>
      pendingTitle ? new Promise(resolve => { release = resolve; }) : s.title });
  const service = new ChatSessionService(repository, agent, undefined, 30);
  const session = await service.create("original", "request");
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const completed = await service.send(session.id, "first");
    assert.equal(completed.sessionStatus, "finished");
    assert.deepEqual(completed.messages.map(m => m.content), ["first", "answer"]);
    pendingTitle = false;
    assert.equal((await service.send(session.id, "retry")).sessionStatus, "finished");
    release("late title");
    await new Promise(resolve => setImmediate(resolve));
    const stored = await service.getById(session.id);
    assert.equal(stored.title, "original");
    assert.deepEqual(stored.messages.map(m => m.content), ["first", "answer", "retry", "answer"]);
  } finally { clearTimeout(keepAlive); }
});

test("title persistence failure leaves the committed answer and actual original title intact", async () => {
  const repository = new InMemoryChatSessionRepository();
  const agent: ChatAgent = { async run() { return { content: "answer" }; }, async titleFor() { return "new title"; } };
  const service = new ChatSessionService(repository, agent);
  const session = await service.create("original", "title-persistence");
  const save = repository.save.bind(repository);
  let writes = 0;
  repository.save = async value => { if (++writes === 3) throw new Error("title write failed"); await save(value); };
  const completed = await service.send(session.id, "question");
  assert.equal(completed.sessionStatus, "finished");
  assert.equal(completed.title, "original");
  assert.equal(completed.messages.length, 2);
  assert.deepEqual(await repository.findById(session.id), completed);
});
