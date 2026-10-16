import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateReading } from "../src/modules/evaluation/reading-runner.js";
import { readingFixture } from "./reading-fixtures.js";
import { ModelProtocolError } from "../src/modules/agent/model.js";

test("reading comparison separates exact choices and subjective scores, stores original evidence and omits gold from all model calls", async () => {
    const corpus = readingFixture(); corpus.test = corpus.knowledge; corpus.knowledge = [];
    const directory = await mkdtemp(join(tmpdir(), "reading-eval-"));
    let judged = 0;
    const report = await evaluateReading({ out: join(directory, "report"), split: "test", variants: ["full", "extractive", "adaptive"],
        limit: 2, concurrency: 1, maxInputTokens: 8192, contextTokens: 500, corpus,
        modelFactory: () => ({ async turn(messages) {
            assert.doesNotMatch(JSON.stringify(messages), /GOLD_PRIVATE_REFERENCE/);
            return { content: messages.some(message => message.content.includes("第1题")) ? "根据[P1]，第1题正确。\n第1题答案：A" : "第2题答案：他先送药，才回家。[P1]", toolCalls: [] };
        } }), judge: async (question, answer) => { judged++; assert.match(question.answer, /GOLD_PRIVATE_REFERENCE/); assert.match(answer, /先送药/); return 1; } });
    assert.equal(report.manifest.mode, "offline"); assert.equal(report.rows.length, 3); assert.equal(judged, 3);
    for (const row of report.rows) { assert.equal(row.choiceAccuracy!.value, 1); assert.equal(row.meanOpenScore, 1); assert.equal(row.failures, 0); }
    const trial = JSON.parse(await readFile(join(directory, "report", "trials", "fixture-q2-full.json"), "utf8"));
    assert.match(trial.reference, /GOLD_PRIVATE_REFERENCE/); assert.ok(trial.solveMs >= 0); assert.ok(trial.judgeMs >= 0);
});

test("reading grading does not reward a wrong choice or accept an invalid evaluation contract", async () => {
    const corpus = readingFixture(); corpus.test = [corpus.knowledge[0]!]; corpus.knowledge = [];
    const directory = await mkdtemp(join(tmpdir(), "reading-wrong-"));
    const options = { out: join(directory, "report"), split: "test" as const, variants: ["full" as const], limit: 1, concurrency: 1,
        maxInputTokens: 8192, contextTokens: 500, corpus, modelFactory: () => ({ async turn() { return { content: "第1题答案：B", toolCalls: [] }; } }) };
    const report = await evaluateReading(options); assert.equal(report.rows[0]!.choiceAccuracy!.value, 0);
    await assert.rejects(evaluateReading({ ...options, out: join(directory, "invalid"), contextTokens: 0 }), /Invalid reading/);
});

test("reading evaluation reports protocol fallback and failed model attempts separately from completed calls", async () => {
    const corpus = readingFixture(); corpus.passages[0]!.paragraphs = corpus.passages[0]!.paragraphs.map((text, index) => index < 2 ? text.repeat(120) : text);
    corpus.test = [corpus.knowledge[1]!]; corpus.knowledge = [];
    const directory = await mkdtemp(join(tmpdir(), "reading-fallback-"));
    const report = await evaluateReading({ out: join(directory, "report"), split: "test", variants: ["adaptive"], limit: 1, concurrency: 1,
        maxInputTokens: 4096, contextTokens: 256, corpus, judge: async () => 1,
        modelFactory: () => ({ async turn(_messages, tools) {
            if (tools.length) throw new ModelProtocolError("INVALID_RESPONSE");
            return { content: "第2题答案：先送药，再回家。[P3]", toolCalls: [] };
        } }) });
    assert.equal(report.rows[0]!.failures, 0); assert.equal(report.rows[0]!.protocolFallbacks, 1);
    assert.equal(report.rows[0]!.avgModelCalls, 1); assert.equal(report.rows[0]!.avgModelAttempts, 2);
    const trial = JSON.parse(await readFile(join(directory, "report", "trials", "fixture-q2-adaptive.json"), "utf8"));
    assert.ok(trial.events.some((event: { name: string }) => event.name === "reading.protocol_fallback"));
});
