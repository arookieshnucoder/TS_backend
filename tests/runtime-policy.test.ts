import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHarness } from "../src/modules/harness/agent-harness.js";
import { defineReadOnlyTool } from "../src/modules/harness/define-tool.js";
import { loadContextConfig } from "../src/modules/harness/context/config.js";
import { JsonChatSessionRepository } from "../src/infrastructure/persistence/json/json-chat-session.repository.js";
import { failureCode } from "../src/modules/harness/recovery.js";
import type { AgentWorkflow } from "../src/modules/agent/contracts.js";

const config = { ...loadContextConfig({}), maxToolSteps: 1 };
const instructions = { system: "test", final: "final" };
const logger = { info() {}, error() {} };
const answer = { content: "answer", modelTurns: 1, toolCalls: 0 };

test("custom workflows cannot bypass batch validation or execute a valid prefix of an invalid batch", async () => {
    let executions = 0;
    for (const calls of [
        [{ id: "a", name: "lookup", arguments: {} }, { id: "a", name: "lookup", arguments: {} }],
        [{ id: "a", name: "lookup", arguments: {} }, { id: "b", name: "unknown", arguments: {} }],
        Array.from({ length: 3 }, (_, i) => ({ id: String(i), name: "lookup", arguments: {} })),
    ]) {
        const workflow: AgentWorkflow = { async run(runtime) { await runtime.executeBatch(calls); return answer; } };
        const harness = new AgentHarness({ async turn() { throw new Error("unused"); } }, workflow, instructions, config, logger, { maxCallsPerStep: 2 });
        await assert.rejects(harness.run({ history: [], question: "q", metadata: {}, tools: [defineReadOnlyTool({ name: "lookup", description: "lookup", parameters: {}, execute: async () => { executions++; return "ok"; } })] }));
    }
    assert.equal(executions, 0);
});

test("custom workflows cannot bypass model turn, tool total or altered-definition limits", async () => {
    const tool = defineReadOnlyTool({ name: "lookup", description: "lookup", parameters: {}, execute: async () => "ok" });
    for (const workflow of [
        { async run(runtime: any) { for (let i = 0; i < 3; i++) await runtime.complete([], []); return answer; } },
        { async run(runtime: any) { for (let i = 0; i < 3; i++) await runtime.execute({ id: String(i), name: "lookup", arguments: {} }); return answer; } },
        { async run(runtime: any) { await runtime.complete([], [{ ...runtime.tools[0], description: "altered" }]); return answer; } },
    ]) {
        const harness = new AgentHarness({ async turn() { return { content: "ok", toolCalls: [] }; } }, workflow, instructions, config, logger, { maxCallsPerStep: 2 });
        await assert.rejects(harness.run({ history: [], question: "q", metadata: {}, tools: [tool] }), { name: "HarnessPolicyError" });
    }
});

test("JSON persistence rejects obsolete or missing states without rewriting files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strict-session-"));
    const file = join(dir, "session.json"); const repo = new JsonChatSessionRepository(dir);
    const value = { id: "s", requestId: "r", title: "t", createdAt: new Date(), updatedAt: new Date(), messages: [], sessionStatus: "finished", sessionError: null };
    for (const invalid of [{ ...value, sessionStatus: "generating" }, { ...value, sessionStatus: undefined }, { ...value, sessionError: undefined }]) {
        await writeFile(file, JSON.stringify(invalid)); await assert.rejects(repo.findAll());
    }
    await writeFile(file, JSON.stringify(value)); assert.equal((await repo.findAll())[0]!.sessionStatus, "finished");
});

test("error classification terminates on cyclic causes without guessing a recovery", () => {
    const a: any = {}, b: any = {}; a.cause = b; b.cause = a;
    assert.equal(failureCode(a), "UNKNOWN");
});
