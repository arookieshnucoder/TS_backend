import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { AgentHarness } from "../src/modules/harness/agent-harness.js";
import { AskAgent } from "../src/modules/agent/ask-agent.js";
import { recoveryPolicy, RecoveringModel, retryable } from "../src/modules/harness/recovery.js";
import { ToolRegistry } from "../src/modules/harness/tool-registry.js";
import { ToolAccessError } from "../src/modules/harness/tool-contracts.js";
import { defineReadOnlyTool } from "../src/modules/harness/define-tool.js";
import { TokenBudget } from "../src/modules/harness/context/tokens.js";
import { loadConfig } from "../src/config/env.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";
import type { AgentModel } from "../src/modules/agent/model.js";
import type { AgentMessage } from "../src/modules/agent/contracts.js";

const config = loadConfig({ NODE_ENV: "test", AGENT_WORKSPACE_ENABLED: "false" });
const policy = recoveryPolicy({ baseDelayMs: 0, maxDelayMs: 0 });
const transient = () => Object.assign(new Error("private upstream credential"), { status: 503 });
const answer = { content: "answer", toolCalls: [] };

test("transient model requests retry with unchanged inputs and bounded safe events", async () => {
    let calls = 0;
    const events: unknown[] = [];
    const model = new RecoveringModel({ async turn(messages) {
        assert.equal(messages.length, 1); messages.push({ role: "user", content: "mutation" });
        if (++calls < 3) throw transient(); return answer;
    } }, [], policy, (name, fields) => events.push({ name, fields }));
    const messages: AgentMessage[] = [{ role: "user", content: "question" }];
    assert.equal((await model.turn(messages, [])).content, "answer");
    assert.equal(calls, 3); assert.equal(messages.length, 1);
    assert.equal(events.filter((e: any) => e.name === "agent.retry").length, 2);
    assert.doesNotMatch(JSON.stringify(events), /private upstream/);
});

test("fallback preserves completed tool results and remains selected without replaying tools", async () => {
    let primaryCalls = 0, fallbackCalls = 0, toolCalls = 0;
    const events: string[] = [];
    const primary: AgentModel = { async turn() {
        if (++primaryCalls === 1) return { content: "", toolCalls: [{ id: "evidence", name: "lookup", arguments: {} }] };
        throw transient();
    } };
    const fallback: AgentModel = { async turn(messages) {
        fallbackCalls++; assert.equal(messages.at(-1)!.toolCallId, "evidence");
        assert.equal(messages.at(-1)!.content, "verified result"); return answer;
    } };
    const harness = new AgentHarness(primary, new AskAgent(), { system: "test", final: "final" }, config.context,
        { info(name) { events.push(name); }, error() {} }, { recovery: policy, fallbackModels: [{ name: "backup", model: fallback }] });
    const result = await harness.run({ history: [], question: "q", metadata: {}, tools: [defineReadOnlyTool({
        name: "lookup", description: "lookup", parameters: {}, execute: async () => { toolCalls++; return "verified result"; },
    })] });
    assert.equal(result.content, "answer"); assert.equal(toolCalls, 1); assert.equal(primaryCalls, 4); assert.equal(fallbackCalls, 1);
    assert.equal(events.filter(e => e === "agent.fallback").length, 1);
    const recovery = new RecoveringModel({ async turn() { throw transient(); } }, [{ name: "backup", model: fallback }], policy, () => {});
    const input: AgentMessage[] = [{ role: "tool", content: "verified result", toolCallId: "evidence" }];
    await recovery.turn(input, []); await recovery.turn(input, []);
    assert.equal(fallbackCalls, 3);
});

test("harness validates and snapshots the configured model chain before requests", async () => {
    const primary: AgentModel = { async turn() { throw transient(); } };
    const workflow = new AskAgent();
    const instructions = { system: "test", final: "final" };
    const logger = { info() {}, error() {} };
    for (const fallbackModels of [undefined, null, {}, [{ name: "", model: primary }], [{ name: "x".repeat(101), model: primary }], [{ name: "backup", model: {} }]]) {
        assert.throws(() => new AgentHarness(primary, workflow, instructions, config.context, logger, { fallbackModels } as any), TypeError);
    }
    const backup = { name: "configured-backup", model: { async turn() { return answer; } } };
    const fallbackModels = [backup];
    const events: Record<string, unknown>[] = [];
    const harness = new AgentHarness(primary, workflow, instructions, config.context,
        { ...logger, info(name, fields) { if (name === "agent.fallback") events.push(fields!); } },
        { recovery: { ...policy, modelRetries: 0 }, fallbackModels });
    backup.name = "changed-after-assembly";
    fallbackModels.splice(0, 1, { name: "replacement", model: { async turn() { assert.fail("The configured chain must remain stable"); } } });
    assert.equal((await harness.run({ history: [], question: "q", tools: [], metadata: {} })).content, "answer");
    assert.equal(events[0]!.to, "configured-backup");
});

test("authentication, permission, invalid requests and programming failures never retry or fall back", async () => {
    for (const error of [Object.assign(new Error("denied"), { status: 401 }), Object.assign(new Error("bad"), { status: 400 }), new ToolAccessError(), new Error("invalid model response")]) {
        let calls = 0;
        const model = new RecoveringModel({ async turn() { calls++; throw error; } }, [{ name: "backup", model: { async turn() { assert.fail("No fallback for permanent errors"); } } }], policy, () => {});
        await assert.rejects(model.turn([], [])); assert.equal(calls, 1);
    }
});

test("retry exhaustion is finite with and without a backup; classification covers provider and MCP errors", async () => {
    let calls = 0;
    const model: AgentModel = { async turn() { calls++; throw transient(); } };
    const exhausted = new RecoveringModel(model, [{ name: "backup", model }], policy, () => {});
    await assert.rejects(exhausted.turn([], [])); assert.equal(calls, 6);
    calls = 0; await assert.rejects(new RecoveringModel(model, [], policy, () => {}).turn([], [])); assert.equal(calls, 3);
    for (const error of [{ status: 429 }, { code: -32000 }, { code: -32001 }, { cause: { code: "ECONNRESET" } }]) assert.equal(retryable(error), true);
    assert.equal(retryable({ status: 403 }), false);
});

test("caller cancellation during backoff stops further attempts and bypasses fallback", async () => {
    const abort = new AbortController(); let calls = 0;
    const model = new RecoveringModel({ async turn() { calls++; throw transient(); } }, [{ name: "backup", model: { async turn() { assert.fail(); } } }],
        recoveryPolicy({ baseDelayMs: 5000, maxDelayMs: 5000 }), name => { if (name === "agent.retry") abort.abort(); });
    await assert.rejects(model.turn([], [], abort.signal), { name: "AbortError" }); assert.equal(calls, 1);
});

test("per-attempt timeout falls back even when the primary ignores AbortSignal, late completion is ignored", async () => {
    let release!: (value: typeof answer) => void;
    const keepAlive = setTimeout(() => {}, 1000);
    const model = new RecoveringModel({ turn: () => new Promise(resolve => { release = resolve; }) },
        [{ name: "backup", model: { async turn() { return answer; } } }], recoveryPolicy({ modelRetries: 0, modelAttemptTimeoutMs: 10 }), () => {});
    try { assert.equal((await model.turn([], [])).content, "answer"); release({ content: "late", toolCalls: [] }); }
    finally { clearTimeout(keepAlive); }
});

test("idempotent tools retry transient failures; non-idempotent and validation errors execute at most once", async () => {
    const registry = new ToolRegistry(new TokenBudget(config.context), 256, 1000, () => {}, policy);
    let readCalls = 0, writeCalls = 0;
    const read = defineReadOnlyTool({ name: "read", description: "read", parameters: {}, execute: async () => { if (++readCalls === 1) throw transient(); return "ok"; } });
    registry.register(read);
    registry.register({ ...read, readonly: false, idempotent: false, definition: { ...read.definition, name: "write" }, execute: async () => { writeCalls++; throw transient(); } });
    assert.equal((await registry.execute({ id: "r", name: "read", arguments: {} })).content, "ok");
    assert.equal(readCalls, 2);
    assert.match((await registry.execute({ id: "w", name: "write", arguments: {} })).content, /TOOL_FAILED/); assert.equal(writeCalls, 1);
    assert.match((await registry.execute({ id: "bad", name: "read", arguments: { extra: true } })).content, /INVALID_ARGUMENTS/); assert.equal(readCalls, 2);
});

test("tool retry shares one timeout budget and cancellation cannot leak a successful result", async () => {
    let calls = 0;
    const registry = new ToolRegistry(new TokenBudget(config.context), 256, 10, () => {}, recoveryPolicy({ baseDelayMs: 100, maxDelayMs: 100 }));
    registry.register(defineReadOnlyTool({ name: "read", description: "read", parameters: {}, execute: async () => { calls++; throw transient(); } }));
    const keepAlive = setTimeout(() => {}, 1000);
    try { assert.match((await registry.execute({ id: "r", name: "read", arguments: {} })).content, /TOOL_TIMEOUT/); assert.equal(calls, 1); }
    finally { clearTimeout(keepAlive); }
});

test("fallback settings reject accidental credential forwarding and invalid retry budgets", () => {
    assert.equal(loadConfig({ LLM_FALLBACK_MODEL: "", LLM_FALLBACK_BASE_URL: "", LLM_FALLBACK_API_KEY: "" }).llmFallback, undefined);
    assert.throws(() => loadConfig({ LLM_API_KEY: "primary-secret", LLM_FALLBACK_MODEL: "backup", LLM_FALLBACK_BASE_URL: "https://different.example" }), /requires LLM_FALLBACK_API_KEY/);
    const configured = loadConfig({ LLM_API_KEY: "primary-secret", LLM_FALLBACK_API_KEY: "backup-secret", LLM_FALLBACK_MODEL: "backup", LLM_FALLBACK_BASE_URL: "https://different.example" });
    assert.equal(configured.llmFallback?.apiKey, "backup-secret");
    for (const env of [{ AGENT_MODEL_RETRIES: "6" }, { AGENT_TOOL_RETRIES: "-1" }, { AGENT_MODEL_ATTEMPT_TIMEOUT_MS: "0" }, { AGENT_RETRY_BASE_DELAY_MS: "100", AGENT_RETRY_MAX_DELAY_MS: "50" }]) assert.throws(() => loadConfig(env));
});

test("configured real LangChain primary retries HTTP 503 then uses the explicit backup model", async () => {
    const requests: string[] = [];
    const http = createServer(async (req, res) => {
        let raw = ""; for await (const part of req) raw += part;
        const body = JSON.parse(raw); requests.push(body.model);
        res.setHeader("Content-Type", "application/json");
        if (body.model === "primary") { res.statusCode = 503; res.end(JSON.stringify({ error: { message: "temporary" } })); return; }
        res.end(JSON.stringify({ id: "test", object: "chat.completion", created: 1, model: "backup", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "real backup answer" } }] }));
    }).listen(0, "127.0.0.1"); await once(http, "listening");
    const cfg = loadConfig({ NODE_ENV: "test", LLM_API_KEY: "test-key", LLM_BASE_URL: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
        LLM_MODEL: "primary", LLM_FALLBACK_MODEL: "backup", AGENT_RETRY_BASE_DELAY_MS: "0", AGENT_RETRY_MAX_DELAY_MS: "0", AGENT_WORKSPACE_ENABLED: "false" });
    const deps = createDependencies({ logger: { info() {}, error() {} }, chatSessionRepository: new InMemoryChatSessionRepository() }, cfg);
    try {
        const result = await deps.agentHarness.run({ id: "s", requestId: "r", title: "t", createdAt: new Date(), updatedAt: new Date(), messages: [], sessionStatus: "finished", sessionError: null }, { id: "q", role: "user", content: "q" });
        assert.equal(result.content, "real backup answer");
        assert.deepEqual(requests, ["primary", "primary", "primary", "backup"]);
    } finally { await deps.mcp.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
});
