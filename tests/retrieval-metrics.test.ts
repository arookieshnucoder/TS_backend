import test from "node:test";
import assert from "node:assert/strict";
import { scoreRetrieval, evaluateRetrieval, validateRetrievalCases } from "../src/modules/evaluation/retrieval-metrics.js";
import { parseSkillExport, readonlySkillStore } from "../src/modules/evaluation/skill-retrieval-catalog.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateSkillCatalog } from "../src/modules/evaluation/skill-retrieval-catalog.js";

test("Recall and Hit use different denominators; duplicates consume ranks", () => {
    const result = scoreRetrieval(["a", "a", "wrong", "b"], ["a", "b", "c", "d"], 3);
    assert.equal(result.recall, .25); assert.equal(result.hit, 1); assert.equal(result.precision, 1 / 3);
    assert.equal(result.recallCeiling, .75); assert.ok(result.ndcg! < 1);
    assert.equal(scoreRetrieval(["wrong", "b"], ["b"], 3).mrr, .5);
    assert.equal(scoreRetrieval(["a"], ["a"], 3).precision, 1 / 3);
    assert.equal(scoreRetrieval(["a"], ["a"], 3).returnedPrecision, 1);
    assert.equal(scoreRetrieval([], [], 3).recall, null);
    assert.throws(() => scoreRetrieval([], [], 0));
});

test("Failed retrieval is a miss, never a correct abstention; gold stays outside retriever", async () => {
    const cases = [
        { id: "positive", subject: "math", category: "paraphrase", query: "positive", relevantIds: ["gold"] },
        { id: "negative", subject: "math", category: "no-answer", query: "negative", relevantIds: [] },
    ];
    const report = await evaluateRetrieval(cases, async input => {
        assert.deepEqual(Object.keys(input).sort(), ["query", "subject"]); throw new Error("Unavailable");
    });
    assert.equal(report.summary.at[3]!.recall, 0);
    assert.equal(report.summary.failureRate.value, 1);
    assert.equal(report.summary.noAnswerCorrectAbstentionRate!.value, 0);
    const clean = await evaluateRetrieval(cases, async () => ({ ids: [], durationMs: 1 }));
    assert.equal(clean.summary.noAnswerCorrectAbstentionRate!.value, 1);
});

test("Judgments reject missing or cross-subject gold and duplicated queries", () => {
    const c = { id: "one", subject: "math", category: "test", query: "query", relevantIds: ["gold"] };
    assert.throws(() => validateRetrievalCases([c], new Map([["gold", "english"]])));
    assert.throws(() => validateRetrievalCases([c, { ...c, id: "two" }], new Map([["gold", "math"]])));
    assert.equal(validateRetrievalCases([c], new Map([["gold", "math"]])).length, 1);
});

test("Export parser fails closed and evaluation store disallows learning", async () => {
    assert.throws(() => parseSkillExport("not a method"));
    await assert.rejects(readonlySkillStore([]).withSubjectLock("math", async () => undefined));
});

test("Frozen catalog round-trips exported methods and its labels match exactly that catalog", async () => {
    const catalog = validateSkillCatalog(JSON.parse(await readFile(new URL("../benchmarks/rag/skills-catalog.json", import.meta.url), "utf8")));
    for (const skill of catalog) assert.deepEqual(parseSkillExport(skill.markdown), skill);
    const judgments = JSON.parse(await readFile(new URL("../benchmarks/rag/skills-queries.json", import.meta.url), "utf8"));
    const content = JSON.stringify([...catalog].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, subject, markdown }) => ({ id, subject, markdown })));
    assert.equal(judgments.catalogContentHash, createHash("sha256").update(content).digest("hex"));
    validateRetrievalCases(judgments.cases, new Map(catalog.map(s => [s.id, s.subject])));
    const store = readonlySkillStore(catalog), first = catalog[0]!;
    const copy = await store.list(first.subject); copy[0]!.description = "changed";
    assert.equal((await store.list(first.subject))[0]!.description, first.description);
});

test("组合经验的ID召回与实际子经验覆盖分别计分", () => {
    const score = scoreRetrieval(["parent"], ["a", "b"], 1, id => id === "parent" ? ["parent", "a", "b"] : [id]);
    assert.equal(score.recall, 0); assert.equal(score.coverageRecall, 1);
    assert.equal(scoreRetrieval([], ["a"], 3).coverageRecall, 0);
});

test("并发评测保持题目顺序、限制请求数，并把故障留在分母中", async () => {
    let active = 0, peak = 0;
    const cases = ["one", "two", "three"].map(id => ({ id, subject: "math", category: "test", query: id, relevantIds: ["gold"] }));
    const result = await evaluateRetrieval(cases, async ({ query }) => {
        peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--;
        if (query === "two") throw new Error("Unavailable");
        return { ids: ["gold"], durationMs: 5 };
    }, [1, 3], undefined, 2);
    assert.equal(peak, 2); assert.deepEqual(result.rows.map(row => row.id), ["one", "two", "three"]);
    assert.equal(result.summary.at[3]!.recall, 2 / 3); assert.equal(result.summary.failureRate.value, 1 / 3);
});
