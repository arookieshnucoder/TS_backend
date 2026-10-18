import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { RunTraceStore } from "../src/modules/observability/run-trace.js";
import { redact } from "../src/common/logging/redaction.js";
import { ChatSessionService } from "../src/modules/chat/service/chat-session.service.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";
import { createChatAgent } from "../src/bootstrap/chat-agent.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { defineReadOnlyTool } from "../src/modules/harness/define-tool.js";
import { AgentHarness } from "../src/modules/harness/agent-harness.js";
import { AskAgent } from "../src/modules/agent/ask-agent.js";
import { loadConfig } from "../src/config/env.js";
import { createApp } from "../src/app.js";

const logger = { info() {}, error() {} };
const config = loadConfig({ NODE_ENV: "test", AGENT_WORKSPACE_ENABLED: "false" });
const instructions = { system: "test", final: "answer" };
async function store(max = 512) {
    const dir = await mkdtemp(join(tmpdir(), "rag-trace-"));
    return { dir, runs: new RunTraceStore(dir, logger, ["bare-private-key"], max) };
}

test("complete per-question trace orders discovery, model, tool, answer, title and persistence with call IDs", async () => {
    const { runs, dir } = await store();
    const repo = new InMemoryChatSessionRepository();
    const agent = createChatAgent(repo, { async turn(messages) {
        if (!messages.some(m => m.role === "tool")) return { content: "", toolCalls: [{ id: "call-1", name: "lookup", arguments: {} }] };
        return { content: "answer with bare-private-key", toolCalls: [] };
    } }, () => { throw new Error("unused"); }, config.context, logger, {
        title: async s => s.title, tools: async () => [defineReadOnlyTool({ name: "lookup", description: "lookup", parameters: {}, execute: async () => "evidence Bearer tool-private-secret" })],
    });
    const service = new ChatSessionService(repo, agent, undefined, 1000, runs);
    const session = await service.create("t", "request");
    const completed = await service.send(session.id, "question", undefined, "question-request");
    const listed = await runs.list(session.id); assert.equal(listed.runs.length, 1);
    const trace = await runs.get(session.id, listed.runs[0]!.id);
    assert.equal(trace.status, "success"); assert.equal(trace.requestId, "question-request");
    assert.equal(trace.userMessageId, completed.messages[0]!.id); assert.equal(trace.assistantMessageId, completed.messages[1]!.id);
    const names = trace.events.map(e => e.name);
    const chain = ["run.started", "session.pending", "agent.started", "tools.discovery.started", "tools.discovery.completed", "agent.context", "agent.model.started", "agent.model.completed", "agent.tool.started", "agent.tool", "answer.ready", "session.saved", "title.started", "title.completed", "run.success"];
    let last = -1; for (const name of chain) { const index = names.indexOf(name); assert.ok(index > last, `Expected ordered ${name}`); last = index; }
    assert.deepEqual(trace.events.map(e => e.sequence), trace.events.map((_e, i) => i + 1));
    assert.equal(trace.events.find(e => e.name === "agent.tool")!.fields.callId, "call-1");
    assert.equal(trace.events.filter(e => e.name === "agent.model.started")[1]!.fields.modelCallId, "model-2");
    const persisted = await readFile(join(dir, session.id, `${trace.id}.json`), "utf8");
    assert.doesNotMatch(persisted, /bare-private-key|tool-private-secret/); assert.match(persisted, /REDACTED/);
    assert.deepEqual(await new RunTraceStore(dir, logger).get(session.id, trace.id), trace);
});

test("failed and cancelled questions remain inspectable without committing partial chat history", async () => {
    for (const cancel of [false, true]) {
        const { runs } = await store(); const repo = new InMemoryChatSessionRepository(); const abort = new AbortController();
        const service = new ChatSessionService(repo, { async run() {
            if (cancel) abort.abort(); throw new Error("private raw exception");
        }, async titleFor(s) { return s.title; } }, undefined, 1000, runs);
        const session = await service.create("t", "req");
        assert.equal((await service.send(session.id, "failed question", abort.signal)).sessionStatus, "failure");
        const list = await runs.list(session.id); const run = await runs.get(session.id, list.runs[0]!.id);
        assert.equal(run.status, cancel ? "cancelled" : "failure"); assert.equal(run.question, "failed question");
        assert.equal(run.events.at(-1)!.name, `run.${run.status}`);
        assert.deepEqual((await service.getById(session.id)).messages, []);
        assert.doesNotMatch(JSON.stringify(run), /private raw exception/);
    }
});

test("timeout records a terminal event and drops late model completions", async () => {
    const { runs } = await store(); const repo = new InMemoryChatSessionRepository();
    let release!: (value: { content: string; toolCalls: [] }) => void;
    const agent = createChatAgent(repo, { turn: () => new Promise(resolve => { release = resolve; }) }, () => { throw new Error("unused"); }, config.context, logger,
        { tools: async () => [], title: async s => s.title });
    const service = new ChatSessionService(repo, agent, undefined, 30, runs);
    const session = await service.create("t", "req"); const keepAlive = setTimeout(() => {}, 1000);
    try {
        await service.send(session.id, "slow");
        const summary = (await runs.list(session.id)).runs[0]!;
        const before = await runs.get(session.id, summary.id); assert.equal(before.status, "timed_out");
        release({ content: "late", toolCalls: [] }); await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(await runs.get(session.id, summary.id), before);
    } finally { clearTimeout(keepAlive); }
});

test("concurrent questions isolate repeated call IDs and retry/fallback events", async () => {
    const { runs } = await store(); const repo = new InMemoryChatSessionRepository();
    const agent = createChatAgent(repo, { async turn() { throw Object.assign(new Error("temporary"), { status: 503 }); } }, () => { throw new Error("unused"); }, config.context, logger,
        { tools: async () => [], title: async s => s.title, recovery: { modelRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
            fallbackModels: [{ name: "backup", model: { async turn(messages) { return { content: messages.at(-1)!.content, toolCalls: [] }; } } }] });
    const service = new ChatSessionService(repo, agent, undefined, 1000, runs);
    const [a, b] = await Promise.all([service.create("a", "a"), service.create("b", "b")]);
    await Promise.all([service.send(a.id, "alpha"), service.send(b.id, "beta")]);
    for (const [session, question] of [[a, "alpha"], [b, "beta"]] as const) {
        const run = await runs.get(session.id, (await runs.list(session.id)).runs[0]!.id);
        assert.equal(run.question, question); assert.equal(run.status, "success");
        assert.equal(run.events.filter(e => e.name === "agent.retry").length, 1);
        assert.equal(run.events.filter(e => e.name === "agent.fallback").length, 1);
        assert.equal(run.events.find(e => e.name === "answer.ready")!.fields.content, question);
    }
});

test("event limits preserve terminal status; restart marks pending traces interrupted; list supports cursors", async () => {
    const { runs, dir } = await store(4);
    const recorder = (await runs.start({ sessionId: "session", requestId: "r", userMessageId: "q", question: "q" }))!;
    for (let i = 0; i < 20; i++) recorder.event("many", { i });
    await runs.finish(recorder, "success");
    const run = await runs.get("session", recorder.id); assert.equal(run.events.length, 4); assert.ok(run.droppedEvents > 0);
    assert.equal(run.events.at(-1)!.name, "run.success");
    const pending = (await runs.start({ sessionId: "session", requestId: "r2", userMessageId: "q2", question: "pending" }))!;
    await pending.flush();
    const restarted = new RunTraceStore(dir, logger);
    assert.equal((await restarted.get("session", pending.id)).status, "interrupted");
    const page = await restarted.list("session", 1); assert.equal(page.runs.length, 1); assert.ok(page.nextCursor);
    assert.equal((await restarted.list("session", 1, page.nextCursor)).runs[0]!.id, recorder.id);
    await assert.rejects(restarted.get("../escape", recorder.id), { code: "TRACE_INVALID_ID" });
    await assert.rejects(restarted.list("session", 51), { code: "TRACE_INVALID_QUERY" });
});

test("trace I/O failures and observer errors never change successful answers; persistence failures are recorded", async () => {
    const { dir } = await store(); const file = join(dir, "not-a-directory"); await writeFile(file, "file");
    const badStore = new RunTraceStore(file, logger);
    const repo = new InMemoryChatSessionRepository();
    const service = new ChatSessionService(repo, { async run() { return { content: "answer" }; }, async titleFor(s) { return s.title; } }, undefined, 1000, badStore);
    const session = await service.create("t", "r"); assert.equal((await service.send(session.id, "q")).sessionStatus, "finished");
    const harness = new AgentHarness({ async turn() { return { content: "answer", toolCalls: [] }; } }, new AskAgent(), instructions, config.context, logger);
    assert.equal((await harness.run({ history: [], question: "q", tools: [], metadata: {}, onEvent() { throw new Error("broken observer"); } })).content, "answer");
    const { runs } = await store();
    const failing = new ChatSessionService(repo, { async run() { return { content: "answer" }; }, async titleFor(s) { return s.title; } }, undefined, 1000, runs);
    const save = repo.save.bind(repo); let saves = 0;
    repo.save = async s => { if (++saves === 2) throw new Error("private persistence error"); await save(s); };
    await assert.rejects(failing.send(session.id, "q"));
    const trace = await runs.get(session.id, (await runs.list(session.id)).runs[0]!.id);
    assert.equal(trace.status, "failure"); assert.equal(trace.events.at(-1)!.fields.code, "PERSISTENCE_ERROR");
});

test("redaction handles secret keys, JSON text, bearer tokens, URLs, known values and size bounds", () => {
    const value = redact({ inputTokens: 12, apiKey: "key", nested: { password: "password", query: "Bearer bearer-private" },
        result: '{"apiKey":"json-private","url":"https://user:pass@host?token=url-private"}', auth: "Authorization: Basic cHJpdmF0ZQ==", other: "bare-private-key", huge: "x".repeat(100000) }, ["bare-private-key"]);
    assert.equal((value as any).inputTokens, 12);
    assert.doesNotMatch(JSON.stringify(value), /bearer-private|json-private|url-private|bare-private-key|user:pass|cHJpdmF0ZQ==/);
    assert.ok(JSON.stringify(value).length < 8192);
});

test("production APIs require a session even behind a loopback proxy; health remains public", async () => {
    const cfg = loadConfig({ NODE_ENV: "production", AGENT_WORKSPACE_ENABLED: "false", AGENT_TRACE_ENABLED: "false" });
    const deps = createDependencies({ logger, chatSessionRepository: new InMemoryChatSessionRepository(),
        agentHarness: { async run() { return { content: "answer" }; }, async titleFor(s) { return s.title; } } }, cfg);
    const server = createApp(cfg, deps).listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        for (const path of ["/api/mcp/servers", "/api/observability/sessions/s/runs"]) {
            const response = await fetch(`${base}${path}`); assert.equal(response.status, 401);
            assert.equal((await response.json() as any).error.code, "AUTH_REQUIRED");
        }
        assert.equal((await fetch(`${base}/api/chat/sessions`)).status, 401);
        assert.equal((await fetch(`${base}/api/health`)).status, 200);
    } finally { await deps.auth?.store.close(); await deps.mcp.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("observability HTTP requires administrator access, provides summaries/details and supports disabling", async () => {
    const { runs } = await store();
    const recorder = (await runs.start({ sessionId: "s", requestId: "r", userMessageId: "q", question: "q" }))!; await runs.finish(recorder, "success");
    const cfg = { ...config, mcp: { configFile: "unused", adminToken: "admin-token", timeoutMs: 1000 } };
    const deps = createDependencies({ runs, logger, agentHarness: { async run() { return { content: "answer" }; }, async titleFor(s) { return s.title; } } }, cfg);
    const server = createApp(cfg, deps).listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/observability/sessions/s/runs`;
    const headers = { Authorization: "Bearer admin-token" };
    try {
        assert.equal((await fetch(base)).status, 401);
        const list = await (await fetch(base, { headers })).json() as any; assert.equal(list.data.runs[0].eventCount, 2); assert.equal(list.data.runs[0].events, undefined);
        assert.equal((await (await fetch(`${base}/${recorder.id}`, { headers })).json() as any).data.events.length, 2);
        assert.equal((await fetch(`${base}?limit=999`, { headers })).status, 400);
        assert.equal((await fetch(`${base}/missing`, { headers })).status, 404);
        assert.equal(loadConfig({ AGENT_TRACE_ENABLED: "false" }).observability?.enabled, false);
    } finally { await deps.mcp.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
