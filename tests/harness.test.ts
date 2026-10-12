import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatAgent } from "../src/bootstrap/chat-agent.js";
import { ToolRegistry } from "../src/modules/harness/tool-registry.js";
import { defineReadOnlyTool } from "../src/modules/harness/define-tool.js";
import { createWorkspaceTools } from "../src/modules/harness/workspace-tools.js";
import { ContextBuilder } from "../src/modules/harness/context-builder.js";
import { ASK_INSTRUCTIONS, FINAL_INSTRUCTIONS } from "../src/modules/agent/prompt.js";
import { loadHarnessConfig } from "../src/modules/harness/config.js";
import { loadContextConfig } from "../src/modules/harness/context/config.js";
import { TokenBudget } from "../src/modules/harness/context/tokens.js";
import { ContextCompressor } from "../src/modules/harness/context/services.js";
import { LocalMemorySearch } from "../src/infrastructure/llm/memory-search.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";
import { ChatSessionService } from "../src/modules/chat/service/chat-session.service.js";
import type { AgentModel } from "../src/modules/agent/model.js";
import type { ChatSession } from "../src/modules/chat/entity/chat-session.entity.js";
import type { MemorySearch } from "../src/modules/chat/service/memory-search.js";
import type { AgentMessage, ToolCall, ToolRound } from "../src/modules/agent/contracts.js";
import { textModel } from "./helpers.js";

const config = loadContextConfig({ LLM_MAX_INPUT_TOKENS: "4096" });
const tokens = new TokenBudget(config);
const logger = { info() {}, error() {} };
const session = (id = "test"): ChatSession => ({ id, requestId: id, title: "new", createdAt: new Date(), updatedAt: new Date(),
  messages: [], sessionStatus: "finished", sessionError: null });
const question = { id: "q", role: "user" as const, content: "解释项目的答案来源" };
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, arguments: args });
const harness = (model: AgentModel, repository = new InMemoryChatSessionRepository(), search?: MemorySearch) =>
  createChatAgent(repository, model, () => search ?? new LocalMemorySearch(tokens), config, logger, { title: async session => session.title });

test("direct answers retain roles and system instructions without indexing or searching memory", async () => {
  const s = session(); s.messages = [{ id: "1", role: "user", content: "叫我小明" }, { id: "2", role: "assistant", content: "好的" }];
  const model: AgentModel = { async turn(messages) {
    assert.deepEqual(messages.map(m => m.role), ["system", "user", "assistant", "user"]);
    assert.match(messages[0]!.content, /Ask Agent/);
    assert.equal(messages.at(-1)!.content, question.content);
    return { content: "小明，好的。", toolCalls: [] };
  } };
  const unavailable = async (): Promise<never> => { assert.fail("Direct answers must not retrieve"); };
  const result = await harness(model, undefined, { sync: unavailable, titles: unavailable, search: unavailable }).run(s, question);
  assert.equal(result.content, "小明，好的。");
  assert.equal(result.modelTurns, 1); assert.equal(result.toolCalls, 0);
});

test("memory errors become tool results and the agent can correct arguments and continue", async () => {
  let turn = 0, syncs = 0;
  const requests: AgentMessage[][] = [];
  const search: MemorySearch = { async sync() { syncs++; }, async titles() { return []; }, async search() { return []; } };
  const model: AgentModel = { async turn(messages) {
    requests.push(structuredClone(messages));
    if (turn++ === 0) return { content: "", toolCalls: [call("a", "search_session_memory", { query: 12 })] };
    if (turn === 2) return { content: "", toolCalls: [call("b", "search_session_memory", { query: "小明" })] };
    return { content: "尚无记录", toolCalls: [] };
  } };
  const result = await harness(model, undefined, search).run(session(), question);
  assert.equal(result.modelTurns, 3); assert.equal(syncs, 1);
  assert.match(requests[1]!.at(-1)!.content, /INVALID_ARGUMENTS/);
  assert.equal(requests[1]!.at(-1)!.toolCallId, "a");
  assert.equal(requests[2]!.at(-1)!.toolCallId, "b");
});

test("registry bounds output, sanitizes execution errors, times out and never swallows cancellation", async () => {
  const registry = new ToolRegistry(tokens, 128, 10, () => {});
  for (const [name, execute] of [
    ["large", async () => "内容😀".repeat(1000)],
    ["fail", async () => { throw new Error("Bearer secret-credential"); }],
    ["hang", () => new Promise<string>(() => {})],
  ] as const) registry.register(defineReadOnlyTool({ name, description: name, parameters: {}, execute }));
  const large = await registry.execute(call("1", "large", {}));
  assert.ok(tokens.count(large.content) <= 128); assert.match(large.content, /truncated/); assert.doesNotMatch(large.content, /�/);
  const error = await registry.execute(call("2", "fail", {}));
  assert.match(error.content, /TOOL_FAILED/); assert.doesNotMatch(error.content, /secret-credential/);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.match((await registry.execute(call("3", "hang", {}))).content, /TOOL_TIMEOUT/);
    const abort = new AbortController();
    const pending = registry.execute(call("4", "hang", {}), abort.signal);
    abort.abort();
    await assert.rejects(pending, { name: "AbortError" });
  } finally { clearTimeout(keepAlive); }
});

test("empty tool results remain empty in both observations and returned messages", async () => {
  const observed: Record<string, unknown>[] = [];
  const registry = new ToolRegistry(tokens, 128, 1000, (name, fields) => { if (name === "agent.tool") observed.push(fields); });
  registry.register(defineReadOnlyTool({ name: "empty", description: "Returns an empty text result", parameters: {}, execute: async () => "" }));
  assert.deepEqual(await registry.execute(call("empty-result", "empty", {})), { role: "tool", toolCallId: "empty-result", content: "" });
  assert.equal(observed[0]!.status, "success");
  assert.equal(observed[0]!.result, "");
});

test("workspace tools search then read evidence with paths and lines, rejecting traversal, secrets and junctions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ask-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "ask-outside-"));
  await mkdir(join(root, "src")); await mkdir(join(root, "data")); await mkdir(join(root, "private-sessions"));
  await writeFile(join(root, "src", "answer.ts"), "// source\nexport const answer = 42;\n");
  await writeFile(join(root, ".env"), "LLM_API_KEY=hidden-key");
  await writeFile(join(root, "data", "session.json"), "hidden-key");
  await writeFile(join(root, "private-sessions", "session.json"), "hidden-key");
  await writeFile(join(root, "credentials.json"), "hidden-key");
  await writeFile(join(outside, "outside.txt"), "outside-secret");
  await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  const registry = new ToolRegistry(tokens, 1024, 1000, () => {});
  for (const tool of createWorkspaceTools(root, [join(root, "private-sessions")])) registry.register(tool);
  const invoke = (name: string, args: Record<string, unknown>) => registry.execute(call("c", name, args));
  const search = JSON.parse((await invoke("search_workspace", { path: "src", query: "ANSWER" })).content);
  assert.deepEqual(search.matches, [{ path: "src/answer.ts", line: 2, text: "export const answer = 42;" }]);
  assert.match((await invoke("read_file", { path: "src/answer.ts", startLine: 2, endLine: 2 })).content, /2: export const answer = 42/);
  for (const path of ["../outside.txt", "..\\outside.txt", join(outside, "outside.txt"), ".env", "credentials.json", "escape/outside.txt", "data/session.json", "data./session.json", "private-sessions/session.json", "src/answer.ts:stream"]) {
    assert.match((await invoke("read_file", { path, startLine: 1, endLine: 20 })).content, /ACCESS_DENIED/, path);
  }
  assert.match((await invoke("read_file", { path: "src/answer.ts", startLine: 1, endLine: 201 })).content, /INVALID_ARGUMENTS/);
  assert.match((await invoke("read_file", { path: "src/answer.ts", startLine: 1, endLine: 2, extra: true })).content, /INVALID_ARGUMENTS/);
  assert.doesNotMatch((await invoke("search_workspace", { path: ".", query: "hidden-key" })).content, /"text"/);
  const list = JSON.parse((await invoke("list_directory", { path: "." })).content);
  assert.deepEqual(list.entries, ["src/"]);
});

test("complete tool exchanges compact without duplicating the question or losing tool IDs", async () => {
  const summaryInputs: string[] = [];
  const compression = new ContextCompressor(textModel(async messages => { summaryInputs.push(messages[0]!.content); return "Found source src/a.ts:1 and source src/b.ts:2."; }), tokens, config);
  const builder = new ContextBuilder([], question.content, config, tokens, compression, () => {},
    { system: ASK_INSTRUCTIONS, final: FINAL_INSTRUCTIONS });
  const round = (id: string, content: string): ToolRound => ({ assistant: { role: "assistant", content: "", toolCalls: [call(id, "read_file", { path: "src/a.ts" })] },
    results: [{ role: "tool", toolCallId: id, content }] });
  const rounds = [round("a", "Large old evidence ".repeat(1000)), round("b", "src/b.ts:2 newest exact evidence")];
  const messages = await builder.build(rounds, [], false);
  assert.ok(summaryInputs.length > 0);
  assert.equal(messages.filter(m => m.content === question.content).length, 1);
  assert.equal(messages.at(-1)!.toolCallId, "b");
  assert.equal(messages.at(-2)!.toolCalls![0]!.id, "b");
  assert.equal(messages.some(m => m.toolCallId === "a"), false);
  assert.ok(builder.size(messages, []) <= config.maxInputTokens * config.compressionTrigger);
  const summaries = summaryInputs.length;
  await builder.build([...rounds, round("c", "another short result")], [], false);
  assert.equal(summaryInputs.length, summaries, "old rounds are not repeatedly summarized");
  const huge = await builder.build([...rounds, round("c", "new evidence ".repeat(3000))], [], false);
  assert.ok(builder.size(huge, []) <= config.maxInputTokens * config.compressionTrigger);
  assert.equal(huge.some(m => m.role === "tool"), false, "oversized latest exchange is summarized atomically");
});

test("duplicate IDs across rounds and unadvertised tools fail before any second-batch execution", async () => {
  for (const secondCall of [call("same", "search_session_memory", { query: "x" }), call("other", "execute_shell", {})]) {
    let turns = 0, searches = 0;
    const model: AgentModel = { async turn() {
      return { content: "", toolCalls: [turns++ === 0 ? call("same", "search_session_memory", { query: "x" }) : secondCall] };
    } };
    const search: MemorySearch = { async sync() {}, async titles() { return []; }, async search() { searches++; return []; } };
    await assert.rejects(harness(model, undefined, search).run(session(), question), /Duplicate|Unknown/);
    assert.equal(searches, 1);
  }
});

test("last turn disables tools and asks for a supported final answer", async () => {
  const localConfig = { ...config, maxToolSteps: 1 };
  let turns = 0;
  const model: AgentModel = { async turn(messages, tools) {
    if (turns++ === 0) { assert.ok(tools.length); return { content: "", toolCalls: [call("a", "search_session_memory", { query: "x" })] }; }
    assert.equal(tools.length, 0); assert.match(messages[0]!.content, /Research budget exhausted/);
    return { content: "现有证据不足。", toolCalls: [] };
  } };
  const agent = createChatAgent(new InMemoryChatSessionRepository(), model, () => new LocalMemorySearch(tokens), localConfig, logger);
  assert.equal((await agent.run(session(), question)).content, "现有证据不足。");
});

test("timeout releases a session even if the provider ignores cancellation; late answers cannot persist", async () => {
  const repo = new InMemoryChatSessionRepository();
  let release!: (value: string) => void;
  let slow = true;
  const model = textModel(async () => slow ? new Promise(resolve => { release = resolve; }) : "retry answer");
  const service = new ChatSessionService(repo, harness(model, repo), undefined, 30);
  const s = await service.create("new", "req");
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.equal((await service.send(s.id, "hello")).sessionStatus, "failure");
    slow = false;
    assert.equal((await service.send(s.id, "retry")).sessionStatus, "finished");
    release("late answer");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual((await service.getById(s.id)).messages.map(m => m.content), ["retry", "retry answer"]);
  } finally { clearTimeout(keepAlive); }
});

test("concurrent runs isolate retrieval snapshots, rounds and call IDs", async () => {
  const repo = new InMemoryChatSessionRepository();
  for (const id of ["first", "second"]) {
    const s = session(id); s.messages = [{ id: "old", role: "user", content: `${id} fact` }]; await repo.save(s);
  }
  const scopes: string[][] = [];
  const model: AgentModel = { async turn(messages) {
    const results = messages.filter(m => m.role === "tool");
    return results.length ? { content: results[0]!.content, toolCalls: [] } : { content: "", toolCalls: [call("same-id", "search_session_memory", { query: "fact" })] };
  } };
  const agent = createChatAgent(repo, model, () => ({ async sync() {}, async titles() { return []; }, async search(_query, ids) {
    scopes.push(ids); await new Promise(resolve => setImmediate(resolve));
    return [{ id: "chunk", sessionId: ids[0]!, title: "test", text: `${ids[0]} evidence` }];
  } }), config, logger);
  const [first, second] = await Promise.all([agent.run((await repo.findById("first"))!, question), agent.run((await repo.findById("second"))!, question)]);
  assert.match(first.content, /first evidence/); assert.doesNotMatch(first.content, /second evidence/);
  assert.match(second.content, /second evidence/); assert.deepEqual(scopes.sort(), [["first"], ["second"]]);
});

test("harness configuration validates execution limits and can disable workspace access", () => {
  assert.equal(loadHarnessConfig({ AGENT_WORKSPACE_ENABLED: "false" }).workspaceRoot, undefined);
  for (const env of [{ AGENT_WORKSPACE_ENABLED: "yes" }, { AGENT_TOOL_TIMEOUT_MS: "0" }, { AGENT_TOOL_OUTPUT_TOKENS: "1" }, { AGENT_MAX_CALLS_PER_STEP: "9" }])
    assert.throws(() => loadHarnessConfig(env));
});

test("multiple tools in one round return exactly one matching result each before the next decision", async () => {
  let turns = 0, syncs = 0;
  const search: MemorySearch = { async sync() { syncs++; }, async titles() { return []; }, async search() { return []; } };
  const model: AgentModel = { async turn(messages) {
    if (turns++ === 0) return { content: "查找历史", toolCalls: [call("local", "search_session_memory", { query: "项目" }), call("shared", "search_shared_memory", { query: "项目" })] };
    const results = messages.filter(message => message.role === "tool");
    assert.deepEqual(results.map(result => result.toolCallId), ["local", "shared"]);
    assert.deepEqual(messages.at(-3)!.toolCalls!.map(tool => tool.id), ["local", "shared"]);
    return { content: "没有相关记忆", toolCalls: [] };
  } };
  const result = await harness(model, undefined, search).run(session(), question);
  assert.equal(result.toolCalls, 2); assert.equal(result.modelTurns, 2); assert.equal(syncs, 1);
});

test("invalid tool batches execute nothing and cannot commit a partial chat", async () => {
  for (const calls of [
    [call("same", "search_session_memory", { query: "x" }), call("same", "search_session_memory", { query: "x" })],
    [call("good", "search_session_memory", { query: "x" }), call("bad", "write_file", {})],
    [call("", "search_session_memory", { query: "x" })],
    Array.from({ length: 5 }, (_, i) => call(String(i), "search_session_memory", { query: "x" })),
  ]) {
    let executions = 0;
    const repo = new InMemoryChatSessionRepository();
    const search: MemorySearch = { async sync() { executions++; }, async titles() { return []; }, async search() { return []; } };
    const model: AgentModel = { async turn() { return { content: "not a final answer", toolCalls: calls }; } };
    const service = new ChatSessionService(repo, harness(model, repo, search));
    const s = await service.create("test", "request");
    const result = await service.send(s.id, "hello");
    assert.equal(result.sessionStatus, "failure"); assert.equal(result.messages.length, 0); assert.equal(executions, 0);
  }
});

test("cancelling during a tool prevents remaining tools and subsequent model calls", async () => {
  const abort = new AbortController();
  let models = 0, executions = 0;
  const model: AgentModel = { async turn() {
    models++;
    return { content: "", toolCalls: [call("a", "search_session_memory", { query: "x" }), call("b", "search_session_memory", { query: "y" })] };
  } };
  const search: MemorySearch = { async sync() {}, async titles() { return []; }, async search() { executions++; abort.abort(); return []; } };
  await assert.rejects(harness(model, undefined, search).run(session(), question, abort.signal), { name: "AbortError" });
  assert.equal(models, 1); assert.equal(executions, 1);
});

test("a provider without turn is rejected at assembly rather than falling back to a legacy text method", () => {
  let legacyCalls = 0;
  const unsupported = { async reply() { legacyCalls++; return "must not become an answer"; } };
  const repo = new InMemoryChatSessionRepository();
  assert.throws(() => harness(unsupported as unknown as AgentModel, repo), /must implement turn/);
  assert.equal(legacyCalls, 0);
});
