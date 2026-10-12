import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpManager } from "../src/modules/mcp/mcp-manager.js";
import { parseImport, resolveValues } from "../src/modules/mcp/mcp-config.js";
import { mcpToolName, toolResultText } from "../src/modules/mcp/mcp-tools.js";
import { ToolRegistry } from "../src/modules/harness/tool-registry.js";
import { TokenBudget } from "../src/modules/harness/context/tokens.js";
import { loadConfig } from "../src/config/env.js";
import { createApp } from "../src/app.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { createChatAgent } from "../src/bootstrap/chat-agent.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";
import { defineReadOnlyTool } from "../src/modules/harness/define-tool.js";

const logger = { info() {}, error() {} };
const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const config = loadConfig({ NODE_ENV: "test", AGENT_WORKSPACE_ENABLED: "false" });
const tokens = new TokenBudget(config.context);
async function manager() {
    const dir = await mkdtemp(join(tmpdir(), "rag-mcp-"));
    return new McpManager(join(dir, "mcp.json"), logger);
}
const local = (id: string, enabled = true) => ({ id, transport: "stdio", command: process.execPath, args: [fixture], enabled });

test("real stdio MCP paginates, validates nested/optional schema, isolates names and preserves custom tools", async () => {
    const mcp = await manager();
    try {
        await mcp.import({ mcpServers: { alpha: local("alpha"), beta: local("beta"), disabled: local("disabled", false) } });
        const tools = await mcp.tools();
        assert.equal(tools.length, 4);
        assert.equal(new Set(tools.map(t => t.definition.name)).size, 4);
        const view = await mcp.list();
        assert.equal(view[0]!.status, "connected");
        assert.equal(view[0]!.tools.find(t => t.name === "mutate")!.available, false);
        const registry = new ToolRegistry(tokens, 256, 1000, () => {});
        tools.forEach(t => registry.register(t));
        registry.register(defineReadOnlyTool({ name: "lookup", description: "original", parameters: {}, execute: async () => "custom" }));
        assert.equal((await registry.execute({ id: "a", name: "lookup", arguments: {} })).content, "custom");
        const name = mcpToolName("alpha", "lookup");
        assert.match((await registry.execute({ id: "b", name, arguments: { query: "x", options: { tags: ["a"] } } })).content, /evidence:x/);
        assert.match((await registry.execute({ id: "c", name, arguments: { query: "x", options: { tags: ["c"] } } })).content, /INVALID_ARGUMENTS/);
        assert.match((await registry.execute({ id: "d", name: mcpToolName("alpha", "fail"), arguments: {} })).content, /TOOL_FAILED/);
        assert.doesNotMatch((await registry.execute({ id: "e", name: mcpToolName("alpha", "fail"), arguments: {} })).content, /private-server-key/);
        await mcp.update("alpha", { enabled: false });
        assert.match((await registry.execute({ id: "f", name, arguments: { query: "x" } })).content, /ACCESS_DENIED/);
        assert.equal((await mcp.tools()).length, 2);
        await mcp.update("beta", { allowMutations: true });
        const write = (await mcp.tools()).find(t => t.source?.toolName === "mutate")!;
        assert.equal(write.readonly, false); assert.equal(write.idempotent, false);
    } finally { await mcp.close(); }
});

test("catalog imports are atomic, persist across restart and expose no credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rag-mcp-persist-"));
    const file = join(dir, "mcp.json");
    const mcp = new McpManager(file, logger);
    await mcp.import({ id: "remote", url: "http://localhost:1234/mcp", headers: { Authorization: "Bearer secret" } });
    const before = await readFile(file, "utf8");
    await assert.rejects(mcp.import({ mcpServers: { good: { url: "http://localhost/mcp" }, bad: { command: 3 } } }));
    assert.equal(await readFile(file, "utf8"), before);
    const restored = new McpManager(file, logger);
    assert.deepEqual(await restored.list(), await mcp.list());
    assert.doesNotMatch(JSON.stringify(await restored.list()), /Bearer|secret|Authorization/);
    await Promise.all([mcp.update("remote", { enabled: true }), mcp.update("remote", { allowMutations: true })]);
    assert.equal((await mcp.list())[0]!.allowMutations, true);
    await mcp.close(); await restored.close();
});

test("unavailable MCP leaves the original custom tool and answer usable; cancellation propagates", async () => {
    const mcp = await manager();
    await mcp.import({ id: "bad", command: "definitely-nonexistent-mcp-executable", enabled: true });
    const repo = new InMemoryChatSessionRepository();
    let turns = 0;
    const agent = createChatAgent(repo, { async turn(messages, tools) {
        if (turns++ === 0) { assert.deepEqual(tools.map(t => t.name), ["original"]); return { content: "", toolCalls: [{ id: "call", name: "original", arguments: {} }] }; }
        assert.equal(messages.at(-1)!.content, "old tool works");
        return { content: "answer", toolCalls: [] };
    } }, () => { throw new Error("unused"); }, config.context, logger, {
        tools: async () => [defineReadOnlyTool({ name: "original", description: "original", parameters: {}, execute: async () => "old tool works" })],
        additionalTools: (_session, signal) => mcp.tools(signal), title: async s => s.title,
    });
    try {
        const result = await agent.run({ id: "s", requestId: "r", title: "t", createdAt: new Date(), updatedAt: new Date(), messages: [], sessionStatus: "finished", sessionError: null }, { id: "q", role: "user", content: "q" });
        assert.equal(result.content, "answer");
        assert.equal((await mcp.list())[0]!.status, "error");
        const abort = new AbortController(); abort.abort();
        await assert.rejects(mcp.tools(abort.signal), { name: "AbortError" });
    } finally { await mcp.close(); }
});

test("config parsing and text conversion handle credentials, binary content and malformed settings", () => {
    assert.deepEqual(resolveValues({ KEY: "${TOKEN}" }, { TOKEN: "value" }), { KEY: "value" });
    assert.throws(() => resolveValues({ KEY: "${TOKEN}" }, {}));
    for (const value of [{ id: "a", url: "file:///secret" }, { id: "a", url: "https://u:p@host/mcp" }, { id: "a", command: "node", args: [1] }, { id: "a", command: "node", enabled: "yes" }, { id: "../a", command: "node" }]) assert.throws(() => parseImport(value));
    assert.doesNotMatch(toolResultText({ content: [{ type: "image", data: "secret-base64", mimeType: "image/png" }] }), /secret-base64/);
});

for (const mode of ["http", "sse"] as const) test(`real ${mode} MCP transport initializes and executes through the registry`, async () => {
    const sdk = new Server({ name: "http-fixture", version: "1" }, { capabilities: { tools: {} } });
    sdk.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "lookup", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }));
    sdk.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "http evidence" }] }));
    const app = express(); app.use(express.json());
    let transport: StreamableHTTPServerTransport | SSEServerTransport;
    if (mode === "http") {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => "fixture-session" });
        await sdk.connect(transport);
        app.all("/mcp", async (req, res) => { await (transport as StreamableHTTPServerTransport).handleRequest(req, res, req.body); });
    } else {
        app.get("/sse", async (_req, res) => { transport = new SSEServerTransport("/messages", res); await sdk.connect(transport); });
        app.post("/messages", async (req, res) => { await (transport as SSEServerTransport).handlePostMessage(req, res, req.body); });
    }
    const http = app.listen(0, "127.0.0.1"); await once(http, "listening");
    const mcp = await manager();
    try {
        await mcp.import({ id: "remote", transport: mode, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/${mode === "http" ? "mcp" : "sse"}`, enabled: true });
        const tools = await mcp.tools(); assert.equal(tools.length, 1, JSON.stringify(await mcp.list()));
        const registry = new ToolRegistry(tokens, 256, 1000, () => {}); registry.register(tools[0]!);
        assert.equal((await registry.execute({ id: "x", name: tools[0]!.definition.name, arguments: {} })).content, "http evidence");
    } finally { await mcp.close(); await sdk.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
});

test("management HTTP requires a token/allowed origin and validates import and switches", async () => {
    const mcp = await manager();
    const app = createApp({ ...config, mcp: { configFile: "unused", adminToken: "admin-secret", timeoutMs: 1000 } },
        createDependencies({ mcp, logger, chatSessionRepository: new InMemoryChatSessionRepository(), agentModel: { async turn() { return { content: "answer", toolCalls: [] }; } } }, config));
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/servers`;
    const headers = { Authorization: "Bearer admin-secret", "Content-Type": "application/json" };
    try {
        assert.equal((await fetch(base)).status, 401);
        assert.equal((await fetch(base, { headers: { ...headers, Origin: "https://evil.example" } })).status, 403);
        assert.equal((await fetch(`${base}/import`, { method: "POST", headers, body: JSON.stringify(local("test", false)) })).status, 201);
        assert.equal((await fetch(`${base}/test`, { method: "PATCH", headers, body: JSON.stringify({ enabled: "yes" }) })).status, 400);
        assert.equal((await fetch(`${base}/test/test`, { method: "POST", headers, body: "{}" })).status, 409);
        assert.equal((await fetch(`${base}/test`, { method: "PATCH", headers, body: JSON.stringify({ enabled: true }) })).status, 200);
        const response = await fetch(`${base}/test/test`, { method: "POST", headers, body: "{}" });
        assert.equal((await response.json() as any).data.status, "connected");
    } finally { await mcp.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
