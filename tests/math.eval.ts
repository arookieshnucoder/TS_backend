import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus } from "../src/modules/math/corpus.js";
import { MATH_VARIANTS, type MathCorpus } from "../src/modules/math/contracts.js";
import { extractMathAnswer, evaluateMath, permuteQuestion } from "../src/modules/evaluation/math-runner.js";
import { examples, fixture, question } from "./math-fixtures.js";

// Dataset snapshots and evaluation-platform checks run only via npm run test:eval.
test("corpus is 100/12/30, source attributed, and excludes corrupted statements", async () => {
    const c = await loadCorpus("evals/math/corpus.json");
    assert.deepEqual([c.knowledge.length, c.development.length, c.test.length], [100, 12, 30]);
    assert.equal(c.excluded.length, 6);
    assert.ok(c.knowledge.every(q => q.source.dataset.includes("MathBench")));
});

test("grader reads the explicit final conclusion and rejects conflicting answers and letters in reasoning", () => {
    assert.equal(extractMathAnswer("A选项不对\n答案：C"), "C");
    assert.equal(extractMathAnswer("**答案：** B。"), "B");
    assert.equal(extractMathAnswer("参考例题答案A，所以选择B"), null);
    assert.equal(extractMathAnswer("答案：A\n答案：B"), null);
    assert.equal(extractMathAnswer("答案：BCD"), null);
});

test("choice rotation changes letters while preserving the correct option content", () => {
    for (const repeat of [1, 2, 3, 4, 5]) {
        const q = examples[0]!, p = permuteQuestion(q, repeat);
        assert.equal(p.options["ABCD".indexOf(p.answer)], q.options["ABCD".indexOf(q.answer)]);
    }
});

test("math evaluation reuses standard JSON/HTML reports and rejects reusing an output directory", async () => {
    const f = fixture(), dir = await mkdtemp(join(tmpdir(), "math-eval-")), path = join(dir, "corpus.json");
    const c: MathCorpus = { version: 1, id: "test-fixture", knowledge: examples,
        development: [question("dev", "测试题：求x+1=3")], test: [question("test", "最终题：求x-1=1")], excluded: [] };
    await writeFile(path, JSON.stringify(c));
    const options = { out: join(dir, "run"), split: "development" as const, variants: MATH_VARIANTS, repeats: 1, seed: 1,
        timeoutMs: 1000, concurrency: 1, thinking: "disabled" as const, corpusPath: path, rag: f.rag,
        modelFactory: () => ({ async turn() { return { content: "推导得到2。\n答案：B", toolCalls: [] }; } }) };
    const result = await evaluateMath(options);
    assert.equal(result.rows.length, 4); assert.ok(result.rows.every(r => r.correct === 1));
    assert.match(await readFile(join(options.out, "combined", "report.html"), "utf8"), /初中数学/);
    await assert.rejects(() => evaluateMath(options), /Output already exists/);
});
