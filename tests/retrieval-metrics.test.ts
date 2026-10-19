import test from "node:test";
import assert from "node:assert/strict";
import { scoreRetrieval, evaluateRetrieval, validateRetrievalCases } from "../src/modules/evaluation/retrieval-metrics.js";
import { parseSkillExport, readonlySkillStore, validateSkillCatalog } from "../src/modules/evaluation/skill-retrieval-catalog.js";
import { renderSkill } from "../src/modules/harness/skills/document.js";

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

test("当前经验导出保留版本与子经验引用，评测存储隔离外部修改", async () => {
    // 单测只构造当前协议需要的最小经验，不依赖本地评测目录或真实题库。
    const child = parseSkillExport(renderSkill({ id: "00000000-0000-4000-8000-000000000001", subject: "math",
        name: "linear-equation-solving", description: "通过移项与合并同类项求解一元一次方程，并将所得解代回原方程检验。",
        applicability: ["一元一次方程，未知数系数非零"], steps: ["移项并合并同类项", "除以未知数系数后代回检验"],
        checks: ["代回原方程等式成立"], exclusions: ["未知数系数为零时需先讨论退化情况"], keywords: ["一次方程", "移项"] }));
    const parent = parseSkillExport(renderSkill({ ...child, id: "00000000-0000-4000-8000-000000000002",
        name: "linear-equation-workflow", revision: 2, componentIds: [child.id] }));
    const catalog = validateSkillCatalog([child, parent]);
    for (const skill of catalog) assert.deepEqual(parseSkillExport(skill.markdown), skill);
    assert.equal(parent.revision, 2); assert.deepEqual(parent.componentIds, [child.id]);
    assert.throws(() => validateSkillCatalog([parent]), /COMPONENT_REFERENCE/);
    assert.throws(() => validateSkillCatalog([child, child]), /Duplicate catalog ID/);
    validateRetrievalCases([{ id: "one", subject: "math", category: "test", query: "解一元一次方程", relevantIds: [child.id] }],
        new Map(catalog.map(skill => [skill.id, skill.subject])));
    const store = readonlySkillStore(catalog), copy = await store.list("math");
    copy[0]!.description = "changed"; copy[0]!.steps.push("changed"); copy[1]!.componentIds!.push(child.id);
    assert.deepEqual(await store.list("math"), catalog); assert.deepEqual(await store.list("english"), []);
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
