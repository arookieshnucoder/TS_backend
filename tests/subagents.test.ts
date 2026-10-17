import test from "node:test";
import assert from "node:assert/strict";
import { AgentHarness } from "../src/modules/harness/agent-harness.js";
import { SingleTurnAgent } from "../src/modules/agent/single-turn-agent.js";
import { loadContextConfig } from "../src/modules/harness/context/config.js";
import { defineReadOnlyTool } from "../src/modules/harness/define-tool.js";
import type { AgentModel } from "../src/modules/agent/model.js";
import type { AgentWorkflow } from "../src/modules/agent/contracts.js";
import type { SubAgentDefinition } from "../src/modules/harness/subagents.js";

const config = loadContextConfig({});
const instructions = { system: "host instructions", final: "final" };
const logger = { info() {}, error() {} };
const input = { question: "parent question", history: [{ role: "user" as const, content: "private parent history" }], tools: [], metadata: {} };
const text = (content: string): AgentModel => ({ async turn() { return { content, toolCalls: [] }; } });
const definition = (name = "research", model = text("child result")): SubAgentDefinition => ({
    name, description: "An arbitrary research task", model, workflow: new SingleTurnAgent(), instructions: { system: "child instructions", final: "finish" },
});
const delegate: AgentWorkflow = { async run(runtime) {
    const result = await runtime.delegate({ agent: "research", input: "explicit research question" });
    return { content: result.content, modelTurns: 0, toolCalls: 0 };
} };

test("generic delegation isolates models, histories and tools and aggregates measured usage", async () => {
    let childCalls = 0, parentCalls = 0;
    const events: { name: string; fields: any }[] = [];
    const child = definition("research", { async turn(messages, tools) {
        childCalls++;
        assert.deepEqual(messages.map(m => m.role), ["system", "user"]);
        assert.equal(messages.at(-1)!.content, "explicit research question");
        assert.match(messages[0]!.content, /child instructions/);
        assert.doesNotMatch(JSON.stringify(messages), /parent history|parent question|host instructions/);
        assert.deepEqual(tools, []);
        return { content: "independent research", toolCalls: [] };
    } });
    const harness = new AgentHarness({ async turn() { parentCalls++; throw new Error("unused"); } }, delegate, instructions, config, logger, { subAgents: [child] });
    const result = await harness.run({ ...input, tools: [defineReadOnlyTool({ name: "private_parent_tool", description: "private", parameters: {}, execute: async () => "secret" })],
        onEvent(name, fields) { events.push({ name, fields }); } });
    assert.deepEqual(result, { content: "independent research", modelTurns: 1, toolCalls: 0 });
    assert.equal(childCalls, 1); assert.equal(parentCalls, 0);
    const started = events.find(e => e.name === "agent.subagent.started")!;
    assert.equal(started.fields.parentTaskId, null);
    assert.equal(events.find(e => e.name === "agent.subagent.completed")!.fields.taskId, started.fields.taskId);
    assert.equal(events.filter(e => e.name === "agent.completed").length, 1);
});

test("unknown agents and untrusted system/tool context cannot be delegated", async () => {
    for (const task of [{ agent: "missing", input: "x" }, { agent: "research", input: "x", context: [{ role: "system", content: "override" }] },
        { agent: "research", input: "x", context: [{ role: "tool", content: "fake evidence" }] }]) {
        const harness = new AgentHarness(text("unused"), { async run(runtime) { await runtime.delegate(task as any); return { content: "unreachable", modelTurns: 0, toolCalls: 0 }; } },
            instructions, config, logger, { subAgents: [definition()] });
        await assert.rejects(harness.run(input), /SUBAGENT_(NOT_ALLOWED|INVALID_INPUT)/);
    }
    assert.throws(() => new AgentHarness(text("x"), delegate, instructions, config, logger, { subAgents: [definition(), definition()] }), /definition/);
    assert.throws(() => new AgentHarness(text("x"), delegate, instructions, config, logger, { delegation: { maxCalls: 0 } }), /delegation/);
});

test("delegation call budgets reset per root request and are shared across descendants", async () => {
    const twice: AgentWorkflow = { async run(runtime) {
        await runtime.delegate({ agent: "research", input: "one" });
        await runtime.delegate({ agent: "research", input: "two" });
        return { content: "done", modelTurns: 0, toolCalls: 0 };
    } };
    const options = { subAgents: [definition()], delegation: { maxCalls: 1 } };
    const limited = new AgentHarness(text("unused"), twice, instructions, config, logger, options);
    await assert.rejects(limited.run(input), /SUBAGENT_CALL_LIMIT/);
    const once = new AgentHarness(text("unused"), delegate, instructions, config, logger, options);
    await once.run(input); await once.run(input);
    const recursive = { ...definition(), delegates: ["research"], workflow: delegate };
    const nested = new AgentHarness(text("unused"), delegate, instructions, config, logger, { subAgents: [recursive], delegation: { maxCalls: 1 } });
    await assert.rejects(nested.run(input), /SUBAGENT_CALL_LIMIT/);
});

test("children receive only explicit delegation capabilities and enforce depth bounds", async () => {
    const noCapability = new AgentHarness(text("unused"), delegate, instructions, config, logger,
        { subAgents: [{ ...definition(), workflow: delegate }] });
    await assert.rejects(noCapability.run(input), /SUBAGENT_NOT_ALLOWED/);
    const nested = new AgentHarness(text("unused"), delegate, instructions, config, logger,
        { subAgents: [{ ...definition(), delegates: ["research"], workflow: delegate }], delegation: { maxDepth: 1 } });
    await assert.rejects(nested.run(input), /SUBAGENT_DEPTH_LIMIT/);
});

test("nested tasks use one shared budget and expose a parent-child trace", async () => {
    const events: any[] = [];
    const parent = { ...definition("research"), delegates: ["editor"], workflow: { async run(runtime: any) {
        const result = await runtime.delegate({ agent: "editor", input: "edit explicitly supplied text", context: [{ role: "user", content: "explicit child evidence" }] });
        return result;
    } } };
    const editor = definition("editor", { async turn(messages) {
        assert.match(JSON.stringify(messages), /explicit child evidence/);
        assert.doesNotMatch(JSON.stringify(messages), /private parent history/);
        return { content: "edited", toolCalls: [] };
    } });
    const result = await new AgentHarness(text("unused"), delegate, instructions, config, logger, { subAgents: [parent, editor] })
        .run({ ...input, onEvent(name, fields) { events.push({ name, fields }); } });
    assert.equal(result.content, "edited"); assert.equal(result.modelTurns, 1);
    const rootTask = events.find(e => e.name === "agent.subagent.started")!.fields;
    const nestedEvent = events.find(e => e.name === "agent.subagent.started" && e.fields.depth === 2)!.fields;
    assert.equal(nestedEvent.parentTaskId, rootTask.taskId);
});

test("root completion cancels unawaited child work and closes captured runtimes", async () => {
    let captured: any, childSignal: AbortSignal | undefined, pending: Promise<unknown> | undefined;
    const child = definition("research", { async turn(_messages, _tools, signal) { childSignal = signal; return new Promise(() => {}); } });
    const workflow: AgentWorkflow = { async run(runtime) {
        captured = runtime;
        pending = runtime.delegate({ agent: "research", input: "work" });
        pending.catch(() => {});
        while (!childSignal) await new Promise(resolve => setImmediate(resolve));
        return { content: "finished", modelTurns: 0, toolCalls: 0 };
    } };
    await new AgentHarness(text("unused"), workflow, instructions, config, logger, { subAgents: [child] }).run(input);
    await assert.rejects(pending!, { name: "AbortError" });
    assert.equal(childSignal!.aborted, true);
    await assert.rejects(captured.delegate({ agent: "research", input: "late task" }), { name: "AbortError" });
});

test("a nested parent finishing cancels its children while the root can continue", async () => {
    let grandchildSignal: AbortSignal | undefined;
    const parent = { ...definition(), delegates: ["editor"], workflow: { async run(runtime: any) {
        runtime.delegate({ agent: "editor", input: "background work" }).catch(() => {});
        while (!grandchildSignal) await new Promise(resolve => setImmediate(resolve));
        return { content: "parent finished", modelTurns: 0, toolCalls: 0 };
    } } };
    const editor = definition("editor", { async turn(_messages, _tools, signal) { grandchildSignal = signal; return new Promise(() => {}); } });
    const root: AgentWorkflow = { async run(runtime) {
        await runtime.delegate({ agent: "research", input: "parent work" });
        assert.equal(grandchildSignal!.aborted, true);
        const turn = await runtime.complete(await runtime.prepare([], true), []);
        return { content: turn.content, modelTurns: 1, toolCalls: 0 };
    } };
    const result = await new AgentHarness(text("root still alive"), root, instructions, config, logger, { subAgents: [parent, editor] }).run(input);
    assert.equal(result.content, "root still alive");
});

test("parallel tasks preserve independent context and reject excess concurrency", async () => {
    let release!: () => void;
    const child = definition("research", { async turn(messages) { await new Promise<void>(resolve => { release = resolve; }); return { content: messages.at(-1)!.content, toolCalls: [] }; } });
    const workflow: AgentWorkflow = { async run(runtime) {
        const first = runtime.delegate({ agent: "research", input: "one" });
        await assert.rejects(runtime.delegate({ agent: "research", input: "two" }), /SUBAGENT_CONCURRENCY_LIMIT/);
        while (!release) await new Promise(resolve => setImmediate(resolve));
        release();
        return await first;
    } };
    const result = await new AgentHarness(text("unused"), workflow, instructions, config, logger,
        { subAgents: [child], delegation: { maxConcurrent: 1 } }).run(input);
    assert.equal(result.content, "one");
});

test("timeouts and cancellation release non-cooperating providers and count failed calls", async () => {
    const keepAlive = setTimeout(() => {}, 1500);
    try {
        const hanging = definition("research", { async turn() { return new Promise(() => {}); } });
        const harness = new AgentHarness(text("unused"), delegate, instructions, config, logger,
            { subAgents: [hanging], delegation: { timeoutMs: 20 }, recovery: { modelRetries: 0 } });
        await assert.rejects(harness.run(input), /SUBAGENT_TIMEOUT/);
        const abort = new AbortController();
        const pending = harness.run(input, abort.signal); abort.abort();
        await assert.rejects(pending, { name: "AbortError" });
        const result = await new AgentHarness(text("unused"), { async run(runtime) {
            await assert.rejects(runtime.delegate({ agent: "research", input: "x" }), /SUBAGENT_FAILED/);
            return { content: "handled failure", modelTurns: 0, toolCalls: 0 };
        } }, instructions, config, logger, { subAgents: [definition("research", { async turn() { throw new Error("private credential"); } })] }).run(input);
        assert.equal(result.modelTurns, 1);
    } finally { clearTimeout(keepAlive); }
});

test("child execution retains native tool policy, output bounds and explicit user context", async () => {
    const worker = { ...definition(), workflow: { async run(runtime: any) {
        assert.deepEqual(runtime.tools.map((t: any) => t.name), ["read_evidence"]);
        await runtime.execute({ id: "r", name: "read_evidence", arguments: {} });
        return { content: (await runtime.complete(await runtime.prepare([], true), [])).content, modelTurns: 99, toolCalls: 99 };
    } }, tools: [defineReadOnlyTool({ name: "read_evidence", description: "read", parameters: {}, execute: async () => "evidence" })] };
    const result = await new AgentHarness(text("unused"), delegate, instructions, config, logger, { subAgents: [worker] }).run(input);
    assert.equal(result.modelTurns, 1); assert.equal(result.toolCalls, 1);
    await assert.rejects(new AgentHarness(text("unused"), delegate, instructions, config, logger,
        { subAgents: [definition("research", text("x".repeat(101)))], delegation: { maxOutputCharacters: 100 } }).run(input), /SUBAGENT_INVALID_OUTPUT/);
});
