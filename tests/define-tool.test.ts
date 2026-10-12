import assert from "node:assert/strict";
import test from "node:test";
import { defineReadOnlyTool, integerParameter, stringParameter } from "../src/modules/harness/define-tool.js";
import { ToolInputError, ToolRegistry } from "../src/modules/harness/tool-registry.js";
import { TokenBudget } from "../src/modules/harness/context/tokens.js";
import { loadContextConfig } from "../src/modules/harness/context/config.js";
import { createWorkspaceTools } from "../src/modules/harness/workspace-tools.js";

const registry = () => new ToolRegistry(new TokenBudget(loadContextConfig({})), 2048, 1000, () => {});

test("parameter declarations advertise matching schema and execute with typed values and signal", async () => {
    const abort = new AbortController();
    const tool = defineReadOnlyTool({
        name: "lookup", description: "Lookup evidence",
        parameters: { query: stringParameter(10, "Search text"), limit: integerParameter(1, 5) },
        async execute({ query, limit }, signal) {
            assert.equal(signal, abort.signal);
            // 这两个操作也用于确认参数推导为 string / number，而不是 unknown。
            return query.toUpperCase().repeat(limit);
        },
    });
    assert.equal(tool.readonly, true);
    assert.deepEqual(tool.definition.parameters, {
        type: "object", additionalProperties: false, required: ["query", "limit"],
        properties: { query: { type: "string", minLength: 1, maxLength: 10, description: "Search text" },
            limit: { type: "integer", minimum: 1, maximum: 5 } },
    });
    assert.equal(await tool.execute({ query: " a ", limit: 2 }, abort.signal), " A  A ");
});

test("invalid arguments never execute business code and are returned as INVALID_ARGUMENTS", async () => {
    let executions = 0;
    const tool = defineReadOnlyTool({
        name: "lookup", description: "lookup", parameters: { query: stringParameter(3), count: integerParameter(1, 2) },
        async execute() { executions++; return "ok"; },
    });
    const tools = registry().register(tool);
    const invalid = [
        {}, { query: "abc" }, { query: "abc", count: 1, extra: true },
        ...[undefined, null, 1, "", "  ", "abcd"].map(query => ({ query, count: 1 })),
        ...[undefined, null, "1", 0, 3, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(count => ({ query: "a", count })),
        Object.create({ query: "a", count: 1 }) as Record<string, unknown>,
    ];
    for (const input of invalid) {
        assert.throws(() => tool.validate(input), ToolInputError);
        await assert.rejects(tool.execute(input), ToolInputError);
        const result = await tools.execute({ id: "call", name: "lookup", arguments: input });
        assert.equal(JSON.parse(result.content).error, "INVALID_ARGUMENTS");
        assert.equal(result.toolCallId, "call");
    }
    assert.equal(executions, 0);
    assert.equal((await tools.execute({ id: "ok", name: "lookup", arguments: { query: "abc", count: 2 } })).content, "ok");
    assert.equal(executions, 1);
});

test("cross-field validation rejects invalid read ranges before accessing the filesystem", async () => {
    const tool = createWorkspaceTools("nonexistent-test-workspace").find(tool => tool.definition.name === "read_file")!;
    tool.validate({ path: "file.ts", startLine: 1, endLine: 200 });
    tool.validate({ path: "file.ts", startLine: 2, endLine: 2 });
    for (const [startLine, endLine] of [[2, 1], [1, 201], [0, 1], [1.5, 2], [1, Infinity]]) {
        await assert.rejects(tool.execute({ path: "file.ts", startLine, endLine }), ToolInputError);
    }
});

test("zero-argument tools, cancellation and execution errors preserve the registry contract", async () => {
    let executions = 0;
    const tool = defineReadOnlyTool({ name: "fail", description: "fail", parameters: {},
        async execute() { executions++; throw new Error("private-credential"); } });
    assert.deepEqual(tool.definition.parameters, { type: "object", properties: {}, required: [], additionalProperties: false });
    const abort = new AbortController(); abort.abort();
    await assert.rejects(tool.execute({}, abort.signal), { name: "AbortError" });
    assert.equal(executions, 0);
    const tools = registry().register(tool);
    assert.throws(() => tools.register(tool), /duplicate/);
    const result = await tools.execute({ id: "a", name: "fail", arguments: {} });
    assert.equal(JSON.parse(result.content).error, "TOOL_FAILED");
    assert.doesNotMatch(result.content, /private-credential/);
    assert.equal(executions, 1);
});

test("invalid declarations fail immediately and schemas do not share mutable objects", () => {
    for (const max of [0, -1, 1.5, Infinity]) assert.throws(() => stringParameter(max), TypeError);
    for (const bounds of [[2, 1], [NaN, 2], [1, Infinity]]) assert.throws(() => integerParameter(bounds[0]!, bounds[1]!), TypeError);
    const query = stringParameter(10);
    const make = () => defineReadOnlyTool({ name: "lookup", description: "lookup", parameters: { query }, async execute() { return "ok"; } });
    const first = make(), second = make();
    (first.definition.parameters.properties as Record<string, Record<string, unknown>>).query!.maxLength = 999;
    assert.equal((second.definition.parameters.properties as Record<string, Record<string, unknown>>).query!.maxLength, 10);
    assert.throws(() => first.validate({ query: "x".repeat(11) }), ToolInputError);
});
