import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateEnglish } from "../src/modules/evaluation/english-runner.js";
import { englishFixture } from "./english-fixtures.js";
const setup = async () => ({ out: join(await mkdtemp(join(tmpdir(), "english-eval-")), "report"), corpus: englishFixture(), split: "all" as const,
    variants: ["full", "extractive", "adaptive"] as const, limit: 500, concurrency: 2, maxInputTokens: 8192, contextTokens: 1000, workflow: "direct" as const });

test("English evaluation groups a passage once, grades all choices independently, and never exposes references", async () => {
    const options = await setup(); let calls = 0;
    const report = await evaluateEnglish({ ...options, variants: [...options.variants], modelFactory: () => ({ async turn(messages) {
        calls++; assert.doesNotMatch(JSON.stringify(messages), /"answer"\s*:|"expected"\s*:/);
        return { content: "先送药[P1]。\n第1题答案：A\n第2题答案：B", toolCalls: [], usage: { inputTokens: 100, outputTokens: 10 } };
    } }) });
    assert.equal(calls, 3); assert.equal(report.manifest.questionCount, 2); assert.equal(report.manifest.passageCount, 1);
    assert.equal(report.manifest.review, "not_configured"); assert.equal(report.manifest.model, "glm-4.5-air");
    assert.ok(report.rows.every(row => row.accuracy?.successes === 2 && row.accuracy?.total === 2 && row.inputTokens === 100 && row.modelCalls === 1));
    const manifest = JSON.parse(await readFile(join(options.out, "manifest.json"), "utf8")); assert.equal(manifest.mode, "offline");
    await assert.rejects(evaluateEnglish({ ...options, variants: ["adaptive"], modelFactory: () => ({ async turn() { throw new Error("unused"); } }) }), /new English evaluation output/);
});

test("missing, conflicting and failed answers remain in the English accuracy denominator", async () => {
    for (const fail of [false, true]) {
        const options = await setup();
        const report = await evaluateEnglish({ ...options, variants: ["adaptive"], modelFactory: () => ({ async turn() {
            if (fail) throw new Error("fixture failure");
            return { content: "第1题答案：A\n第1题答案：B", toolCalls: [] };
        } }) });
        assert.equal(report.rows[0]!.accuracy?.successes, 0); assert.equal(report.rows[0]!.accuracy?.total, 2);
        assert.equal(report.rows[0]!.failures, fail ? 1 : 0);
    }
});

test("English evaluator rejects unsafe budgets and absent credentials before making requests", async () => {
    const options = await setup();
    for (const change of [{ limit: 501 }, { concurrency: 5 }, { split: "listening" }, { variants: ["unknown"] }, { maxInputTokens: 1024 }])
        await assert.rejects(evaluateEnglish({ ...options, ...change } as any), /Invalid English evaluation/);
    const saved = process.env.LLM_API_KEY; delete process.env.LLM_API_KEY;
    try { await assert.rejects(evaluateEnglish({ ...options, variants: ["adaptive"] }), /LLM_API_KEY/); }
    finally { if (saved === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = saved; }
});

test("grounded evaluator includes delegated model usage exactly once and keeps strict per-question grading", async () => {
    const options = await setup();
    const report = await evaluateEnglish({ ...options, variants: ["adaptive"], workflow: "grounded", modelFactory: () => ({ async turn(messages) {
        const number = messages.some(m => m.role === "tool") ? 0 : Number(messages.at(-1)!.content.match(/第(\d+)题（/)![1]);
        return { content: number ? `第${number}题答案：${number === 1 ? "A" : "B"}` : "第1题答案：A\n第2题答案：B", toolCalls: [], usage: { inputTokens: 150, outputTokens: 20 } };
    } }) });
    assert.equal(report.rows[0]!.modelCalls, 3); assert.equal(report.rows[0]!.modelAttempts, 3);
    assert.equal(report.rows[0]!.inputTokens, 450); assert.equal(report.rows[0]!.outputTokens, 60);
    assert.equal(report.rows[0]!.accuracy?.successes, 2);
});
