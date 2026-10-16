import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHarness } from "../src/modules/harness/agent-harness.js";
import { AskAgent } from "../src/modules/agent/ask-agent.js";
import type { AgentModel } from "../src/modules/agent/model.js";
import { defineReadOnlyTool, stringParameter } from "../src/modules/harness/define-tool.js";
import { loadContextConfig } from "../src/modules/harness/context/config.js";
import { createWorkspaceTools } from "../src/modules/harness/workspace-tools.js";
import { taskPlanTool } from "../src/modules/harness/task-tools.js";
import { GlmModel } from "../src/infrastructure/llm/glm-model.js";

const config = loadContextConfig({});
const logger = { info() {}, error() {} };
const instructions = { system: "Use supplied tools for evidence", final: "Answer now" };
const input = (tools: ReturnType<typeof defineReadOnlyTool>[]) => ({ history: [], question: "q", metadata: {}, tools });

test("an invalid batch is repaired atomically, retains the real question and counts the extra model invocation", async () => {
    let turns = 0, executions = 0;
    const tool = defineReadOnlyTool({ name: "lookup", description: "lookup", parameters: {},
        execute: async () => { executions++; return "verified"; } });
    const model: AgentModel = { async turn(messages) {
        turns++;
        if (turns === 1) return { content: "", toolCalls: [{ id: "valid", name: "lookup", arguments: {} }, { id: "bad", name: "invented", arguments: {} }] };
        if (turns === 2) {
            assert.equal(executions, 0);
            assert.match(messages.at(-1)!.content, /UNKNOWN_TOOL.*no tools/);
            assert.equal(messages.find(m => m.role === "user")!.content, "q");
            assert.equal(messages.some(m => m.toolCalls), false, "invalid exchanges never enter context");
            return { content: "", toolCalls: [{ id: "fixed", name: "lookup", arguments: {} }] };
        }
        assert.equal(messages.at(-1)!.toolCallId, "fixed");
        return { content: "verified answer", toolCalls: [] };
    } };
    const result = await new AgentHarness(model, new AskAgent(), instructions, config, logger, { maxProtocolRepairs: 1 }).run(input([tool]));
    assert.equal(executions, 1);
    assert.deepEqual(result, { content: "verified answer", modelTurns: 3, toolCalls: 1 });
});

test("protocol repair has a run-wide limit and host-supplied invalid definitions cannot trigger it", async () => {
    const tool = defineReadOnlyTool({ name: "lookup", description: "lookup", parameters: {}, execute: async () => "ok" });
    for (const repairs of [0, 1, 2]) {
        let turns = 0;
        const harness = new AgentHarness({ async turn() { turns++; return { content: "", toolCalls: [{ id: "x", name: "invented", arguments: {} }] }; } },
            new AskAgent(), instructions, config, logger, { maxProtocolRepairs: repairs });
        await assert.rejects(harness.run(input([tool])), { code: "UNKNOWN_TOOL" });
        assert.equal(turns, repairs + 1);
    }
    let invoked = false;
    const harness = new AgentHarness({ async turn() { invoked = true; return { content: "ok", toolCalls: [] }; } },
        { async run(runtime) { await runtime.complete([], [{ ...runtime.tools[0]!, description: "altered" }]); throw new Error("unreachable"); } }, instructions, config, logger);
    await assert.rejects(harness.run(input([tool])), { code: "UNKNOWN_TOOL" });
    assert.equal(invoked, false);
});

test("cancellation during protocol repair stops the next invocation and never executes a rejected call", async () => {
    const abort = new AbortController();
    let turns = 0, executions = 0;
    const tool = defineReadOnlyTool({ name: "lookup", description: "lookup", parameters: {}, execute: async () => { executions++; return "ok"; } });
    const harness = new AgentHarness({ async turn() {
        turns++; return { content: "", toolCalls: [{ id: "invalid", name: "unknown", arguments: {} }] };
    } }, new AskAgent(), instructions, config, logger, { maxProtocolRepairs: 1 });
    await assert.rejects(harness.run({ ...input([tool]), onEvent(name) { if (name === "agent.protocol_repair") abort.abort(); } }, abort.signal), { name: "AbortError" });
    assert.equal(turns, 1); assert.equal(executions, 0);
});

test("argument errors expose the existing schema, allowing a corrected call without redefining the tool", async () => {
    let turns = 0, executions = 0;
    const tool = defineReadOnlyTool({ name: "lookup", description: "lookup", parameters: { query: stringParameter(20) },
        execute: async ({ query }) => { executions++; return query; } });
    const model: AgentModel = { async turn(messages) {
        turns++;
        if (turns === 1) return { content: "", toolCalls: [{ id: "bad", name: "lookup", arguments: { query: 1 } }] };
        if (turns === 2) {
            const failure = JSON.parse(messages.at(-1)!.content);
            assert.equal(failure.error, "INVALID_ARGUMENTS");
            assert.deepEqual(failure.expectedArguments, tool.definition.parameters);
            return { content: "", toolCalls: [{ id: "fixed", name: "lookup", arguments: { query: "evidence" } }] };
        }
        return { content: messages.at(-1)!.content, toolCalls: [] };
    } };
    assert.equal((await new AgentHarness(model, new AskAgent(), instructions, config, logger).run(input([tool]))).content, "evidence");
    assert.equal(executions, 1);
});

test("MCP discovery activates only authorized tools, fits context, and does not leak across runs", async () => {
    const local = defineReadOnlyTool({ name: "local", description: "local", parameters: {}, execute: async () => "local" });
    const external = ["alpha", "weather"].map(name => ({ ...local,
        source: { type: "mcp" as const, serverId: "catalog", toolName: name },
        definition: { ...local.definition, name, description: name }, execute: async () => name }));
    const supplied = [local, ...external];
    let turns = 0;
    const model: AgentModel = { async turn(messages, tools) {
        turns++;
        if (turns === 1) {
            assert.equal(tools.some(tool => tool.name === "weather"), false);
            return { content: "", toolCalls: [{ id: "discover", name: "tool_search", arguments: { query: "weather" } }] };
        }
        assert.equal(tools.filter(tool => tool.name === "weather").length, 1);
        assert.ok(JSON.stringify(tools).length < config.maxInputTokens);
        if (turns === 2) return { content: "", toolCalls: [{ id: "weather", name: "weather", arguments: {} }] };
        return { content: messages.at(-1)!.content, toolCalls: [] };
    } };
    const harness = new AgentHarness(model, new AskAgent(), instructions, config, logger, { maxMcpTools: 1 });
    for (let run = 0; run < 2; run++) {
        turns = 0;
        assert.equal((await harness.run(input(supplied))).content, "weather");
        assert.equal(supplied.length, 3);
    }
});

test("a late discovery miss does not expose arbitrary tools", async () => {
    const local = defineReadOnlyTool({ name: "local", description: "local", parameters: {}, execute: async () => "local" });
    const external = ["alpha", "weather"].map(name => ({ ...local, source: { type: "mcp" as const, toolName: name },
        definition: { ...local.definition, name, description: name } }));
    let turns = 0;
    const harness = new AgentHarness({ async turn(messages, tools) {
        if (turns++ === 0) return { content: "", toolCalls: [{ id: "miss", name: "tool_search", arguments: { query: "zebra" } }] };
        assert.deepEqual(JSON.parse(messages.at(-1)!.content).tools, []);
        assert.equal(tools.some(tool => tool.name === "weather"), false);
        return { content: "unavailable", toolCalls: [] };
    } }, new AskAgent(), instructions, config, logger, { maxMcpTools: 1 });
    assert.equal((await harness.run(input(external))).content, "unavailable");
});

test("math batch tool factories replace an existing bundle exactly once", async () => {
    const { OptimizedMathHarness } = await import("../src/modules/math/optimized.js");
    const { fixture } = await import("./math-fixtures.js");
    const duplicate = defineReadOnlyTool({ name: "math_search_batch", description: "old", parameters: {}, execute: async () => "old" });
    let tools: any[] = [];
    const wrapped = new OptimizedMathHarness({ async run(request) {
        tools = typeof request.tools === "function" ? await request.tools({ compression: { async execute() { return ""; } } }) : request.tools;
        return { content: "ok", modelTurns: 0, toolCalls: 0 };
    } }, fixture().rag, "adaptive");
    await wrapped.run({ ...input([]), tools: async () => [duplicate] });
    assert.equal(tools.length, 1); assert.notEqual(tools[0]!.definition.description, "old");
});

test("task lists execute in order, reject ambiguous state, and remain isolated per run", async () => {
    const first = taskPlanTool(), second = taskPlanTool();
    const todos = [{ id: 1, title: "Read", status: "in-progress" }, { id: 2, title: "Verify", status: "not-started" }];
    const harness = new AgentHarness({ async turn() { return { content: "ok", toolCalls: [] }; } }, { async run(runtime) {
        const results = await runtime.executeBatch([
            { id: "write", name: "manage_todo_list", arguments: { operation: "write", todos } },
            { id: "read", name: "manage_todo_list", arguments: { operation: "read", todos: [] } },
        ]);
        assert.deepEqual(JSON.parse(results[1]!.content).todos, todos);
        return { content: "ok", modelTurns: 0, toolCalls: 2 };
    } }, instructions, config, logger);
    await harness.run(input([first]));
    assert.deepEqual(JSON.parse(await second.execute({ operation: "read", todos: [] })).todos, []);
    for (const invalid of [[todos[0], todos[0]], [todos[0], { ...todos[1], status: "in-progress" }], [{ ...todos[0], status: "done" }]])
        await assert.rejects(first.execute({ operation: "write", todos: invalid }));
    assert.deepEqual(JSON.parse(await first.execute({ operation: "read", todos: [] })).todos, todos);
});

test("find_files shares workspace exclusions, pattern roots and cancellation with text search", async () => {
    const root = await mkdtemp(join(tmpdir(), "find-files-"));
    await mkdir(join(root, "src")); await mkdir(join(root, "private")); await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "src", "agent.ts"), "export const n = 2;");
    await writeFile(join(root, "private", "hidden.ts"), "private");
    await writeFile(join(root, "node_modules", "dependency.ts"), "dependency");
    await writeFile(join(root, ".env"), "credential");
    const tool = createWorkspaceTools(root, [join(root, "private")]).find(tool => tool.definition.name === "find_files")!;
    assert.deepEqual(JSON.parse(await tool.execute({ path: "src", pattern: "**/*.ts" })).matches, ["src/agent.ts"]);
    assert.deepEqual(JSON.parse(await tool.execute({ path: ".", pattern: "**/*" })).matches, ["src/agent.ts"]);
    await assert.rejects(tool.execute({ path: "..", pattern: "**/*" }));
    await assert.rejects(tool.execute({ path: ".", pattern: "../**/*" }));
    await assert.rejects(tool.execute({ path: ".", pattern: "**/*" }, AbortSignal.abort()), { name: "AbortError" });
});

test("real GLM HTTP protocol repairs malformed JSON and preserves tool reasoning within the run only", async () => {
    const bodies: any[] = [];
    const upstream = createServer(async (req, res) => {
        let raw = ""; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); bodies.push(body);
        const message = bodies.length < 3 ? { role: "assistant", content: null, reasoning_content: "private reasoning", tool_calls: [
            { id: `call-${bodies.length}`, type: "function", function: { name: "lookup", arguments: bodies.length === 1 ? "{broken" : "{}" } },
        ] } : { role: "assistant", content: "verified", reasoning_content: "final private reasoning" };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20 } }));
    }).listen(0, "127.0.0.1");
    await once(upstream, "listening");
    try {
        const model = new GlmModel({ llmApiKey: "fixture-key", llmModel: "glm-4.5-air", llmTimeoutMs: 10000,
            llmBaseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` }, "enabled");
        const tool = defineReadOnlyTool({ name: "lookup", description: "lookup", parameters: {}, execute: async () => "verified" });
        const result = await new AgentHarness(model, new AskAgent(), instructions, config, logger, { maxProtocolRepairs: 1 }).run(input([tool]));
        assert.equal(result.modelTurns, 3); assert.equal(result.toolCalls, 1);
        assert.equal(bodies[0].tool_choice, "auto"); assert.equal(bodies[0].max_tokens, 8192);
        assert.equal(bodies[2].messages.find((m: any) => m.tool_calls)?.reasoning_content, "private reasoning");
        assert.equal(bodies[2].messages.at(-1).tool_call_id, "call-2");
        assert.doesNotMatch(JSON.stringify(result), /reasoning|broken|fixture-key/);
        await model.turn([{ role: "user", content: "Generate a short title" }], [], undefined, 96);
        assert.equal(bodies[3].thinking.type, "disabled"); assert.equal(bodies[3].max_tokens, 96);
        assert.equal(bodies[3].tools, undefined);
        await assert.rejects(new AgentHarness(model, new AskAgent(), instructions, config, logger).run(input([tool]), AbortSignal.abort()), { name: "AbortError" });
        assert.equal(bodies.length, 4);
    } finally { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
