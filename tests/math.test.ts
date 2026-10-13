import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { createMathModule } from "../src/modules/math/math.module.js";
import { normalizeMath } from "../src/modules/math/normalize.js";
import { hash, loadCorpus, validateCorpus } from "../src/modules/math/corpus.js";
import { MathRag, buildIndex, validateIndex, corpusDigest, type VectorIndex } from "../src/modules/math/rag.js";
import { MathSubmissions } from "../src/modules/math/submissions.js";
import { createMathProfile } from "../src/modules/math/profile.js";
import type { Embeddings, MathQuestion, MathCorpus } from "../src/modules/math/contracts.js";
import { MATH_VARIANTS } from "../src/modules/math/contracts.js";
import { extractMathAnswer, evaluateMath, permuteQuestion } from "../src/modules/evaluation/math-runner.js";
import { loadConfig } from "../src/config/env.js";
import { errorHandler } from "../src/common/http/error-handler.js";
import { redact } from "../src/common/logging/redaction.js";
import { mathEmbeddingConfig } from '../src/bootstrap/math-chat-agent.js';
const logger = { info() {}, error() {} };
const question = (id: string, text: string, topic = "algebra"): MathQuestion => ({ id, question: text, topic, options: ["1", "2", "3", "4"], answer: "B",
    source: { url: "https://example.com/public-math", row: 1, sha256: hash(text), dataset: "test-only" }, solution: "这是测试解析，使用代入原方程的方法进行核验。" });
const examples = [question("quadratic", "解一元二次方程x^2-3x+2=0", "quadratic"), question("statistics", "计算数据的众数和中位数", "statistics"), question("circle", "求圆的面积", "geometry")];
function fixture() {
    let calls = 0;
    const embeddings: Embeddings = { model: "test-only", dimensions: 3, async embed(texts, signal) { calls++; signal?.throwIfAborted(); return texts.map(text => /中位数|众数/.test(text) ? [0, 1, 0] : /圆/.test(text) ? [0, 0, 1] : [1, 0, 0]); } };
    const index: VectorIndex = { version: 1, corpusHash: corpusDigest(examples), model: embeddings.model, dimensions: 3, ids: examples.map(q => q.id), vectors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
    return { embeddings, index, rag: new MathRag(examples, index, embeddings), calls: () => calls };
}
test("math normalization keeps distinctions needed for solving and exact-match isolation", () => {
    assert.equal(normalizeMath("﹣３ ≤ x\n $\\dfrac{1}{2}$"), "-3 ≤ x \\frac{1}{2}");
    assert.notEqual(normalizeMath("x>1"), normalizeMath("x≥1"));
    assert.notEqual(normalizeMath("x^2-2"), normalizeMath("x^2+2"));
    assert.equal(normalizeMath("x²+x₁"), "x^{2}+x_{1}");
});
test('embedding credentials stay on their configured endpoint unless an explicit separate key is supplied',()=>{
    const config=loadConfig({NODE_ENV:'test',MATH_AGENT_VARIANT:'combined',LLM_BASE_URL:'https://example.com/v1',LLM_API_KEY:'test-private-key'});
    assert.throws(()=>mathEmbeddingConfig(config),/EMBEDDING_API_KEY/);
    config.context.embeddingApiKey='test-embedding-key';assert.equal(mathEmbeddingConfig(config).llmApiKey,'test-embedding-key');
});
test("corpus is 100/12/30, source attributed, and excludes corrupted statements", async () => {
    const c = await loadCorpus("evals/math/corpus.json");
    assert.deepEqual([c.knowledge.length, c.development.length, c.test.length], [100, 12, 30]);
    assert.equal(c.excluded.length, 6);
    assert.ok(c.knowledge.every(q => q.source.dataset.includes("MathBench")));
    const copy = structuredClone(c); copy.test[0]!.question = copy.knowledge[0]!.question;
    assert.throws(() => validateCorpus(copy), /leakage/);
    const malformed = structuredClone(c); malformed.knowledge[0]!.answer = "E";
    assert.throws(() => validateCorpus(malformed), /Invalid/);
});
test("vector index rejects changed solutions, reordered IDs, incompatible embedding models and NaN", () => {
    const f = fixture();
    validateIndex(f.index, examples, f.embeddings);
    for (const modify of [(i: VectorIndex) => { i.model = "other"; }, (i: VectorIndex) => { i.vectors[0]![0] = NaN; }, (i: VectorIndex) => { i.ids.reverse(); }]) {
        const index = structuredClone(f.index); modify(index); assert.throws(() => validateIndex(index, examples, f.embeddings));
    }
    const changed = structuredClone(examples); changed[0]!.solution += " changed";
    assert.throws(() => validateIndex(f.index, changed, f.embeddings));
});
test("real index persistence can reopen and rank the correct concept; cancelled queries never embed", async () => {
    const f = fixture(), dir = await mkdtemp(join(tmpdir(), "math-index-")), file = join(dir, "vectors.json");
    await buildIndex(examples, f.embeddings, file);
    const rag = await MathRag.open(examples, file, f.embeddings);
    assert.equal((await rag.search("求中位数", "dense")).hits[0]!.question.id, "statistics");
    const before = f.calls(); await assert.rejects(() => rag.search("求圆面积", "dense", AbortSignal.abort()), /abort/i); assert.equal(f.calls(), before);
});
test("hybrid cache is bounded by normalized question and isolated between variants; evidence is copied", async () => {
    const f = fixture();
    const first = await f.rag.search("求中位数", "hybrid"), second = await f.rag.search("求中位数", "hybrid");
    assert.equal(first.cacheHit, false); assert.equal(second.cacheHit, true); assert.equal(f.calls(), 1);
    second.hits[0]!.question.answer = "D";
    assert.equal((await f.rag.search("求中位数", "hybrid")).hits[0]!.question.answer, "B");
    assert.equal((await f.rag.fork().search("求中位数", "hybrid")).cacheHit, false);
    await f.rag.search("求中位数", "dense"); await f.rag.search("求中位数", "dense"); assert.equal(f.calls(), 4);
    assert.match(f.rag.evidence(first, true), /独立核对/);
    await assert.rejects(() => f.rag.tool("hybrid").execute({ query: " " }));
});
test("four profiles run the production harness and specialized workflow uses one solve turn", async () => {
    for (const variant of MATH_VARIANTS) {
        const f = fixture(), config = loadConfig({ NODE_ENV: "test" }), events: string[] = [], prompts: string[] = [];
        const model = { async turn(messages: { content: string }[]) { prompts.push(messages.map(m => m.content).join("\n")); return { content: "推导并核验，答案：B", toolCalls: [] }; } };
        const profile = createMathProfile(variant, f.rag, model, config.context, logger);
        const result = await profile.harness.run({ question: "求中位数", history: [], tools: [f.rag.tool(profile.mode)], metadata: {}, onEvent(name) { events.push(name); } });
        assert.equal(result.modelTurns, 1);
        assert.equal(result.toolCalls, variant === "agent" ? 1 : 0);
        if (variant !== "baseline") assert.match(prompts[0]!, /statistics/);
        if (variant === "combined" || variant === "agent") assert.match(prompts[0]!, /专门面向中国初中/);
        assert.ok(events.includes("agent.completed"));
    }
});
test("complex math runs an independent second review and returns the reviewed answer with real turn counts", async () => {
    const f = fixture(), config = loadConfig({ NODE_ENV: "test" });
    let turns = 0;
    const model = { async turn(messages: {content:string}[]) { turns++; if(turns===2) assert.match(messages.at(-1)!.content,/独立复核/);
        return { content: turns===1 ? "草稿答案：A" : "复核后已纠错。\n答案：B", toolCalls: [] }; } };
    const profile = createMathProfile("combined", f.rag, model, config.context, logger);
    const result = await profile.harness.run({ question:"去掉两个数据后中位数是否改变？",history:[],tools:[f.rag.tool(profile.mode)],metadata:{} });
    assert.equal(result.modelTurns,2); assert.equal(turns,2); assert.match(result.content,/答案：B/);
    assert.doesNotMatch(result.content,/草稿/);
});
test("grader reads the explicit final conclusion and rejects conflicting answers and letters in reasoning", () => {
    assert.equal(extractMathAnswer("A选项不对\n答案：C"), "C");
    assert.equal(extractMathAnswer("**答案：** B。"), "B");
    assert.equal(extractMathAnswer("参考例题答案A，所以选择B"), null);
    assert.equal(extractMathAnswer("答案：A\n答案：B"), null);
    assert.equal(extractMathAnswer("答案：BCD"), null);
});
test("choice rotation changes letters while preserving the correct option content", () => {
    for (const repeat of [1, 2, 3, 4, 5]) { const q = examples[0]!, p = permuteQuestion(q, repeat);
        assert.equal(p.options["ABCD".indexOf(p.answer)], q.options["ABCD".indexOf(q.answer)]); }
});
test("evaluation redaction preserves complete long solutions and legitimate Basic Concepts topics", () => {
    assert.equal(redact("Basic Concepts of Geometry"), "Basic Concepts of Geometry");
    assert.equal(redact("Basic dXNlcjpwYXNz"), "Basic [REDACTED]");
    const answer = "推导".repeat(700) + "\n答案：C";
    assert.equal(redact(answer, [], { maxStringLength: 16384, maxCharacters: 65536 }), answer);
    assert.equal(redact("key=known-private-key", ["known-private-key"]), "key=[REDACTED]");
});
test("new question text and its vector persist separately; solved model answers remain untrusted", async () => {
    const f = fixture(), dir = await mkdtemp(join(tmpdir(), "math-submit-"));
    const submission = await new MathSubmissions(dir, f.embeddings).ingest("x² − 3x = 0");
    const path = join(dir, `${submission.record.id}.json`);
    assert.equal(JSON.parse(await readFile(path, "utf8")).status, "pending");
    await submission.finish("答案为0或3");
    const record = JSON.parse(await readFile(path, "utf8"));
    assert.equal(record.status, "solved_unverified"); assert.equal(record.trusted, false); assert.equal(record.vector.length, 3);
    assert.equal(f.rag.questions.length, 3);
});
test("math evaluation reuses standard JSON/HTML reports and rejects reusing an output directory", async () => {
    const f = fixture(), dir = await mkdtemp(join(tmpdir(), "math-eval-")), path = join(dir, "corpus.json");
    const c: MathCorpus = { version: 1, id: "test-fixture", knowledge: examples, development: [question("dev", "测试题：求x+1=3")], test: [question("test", "最终题：求x-1=1")], excluded: [] };
    await writeFile(path, JSON.stringify(c));
    const options = { out: join(dir, "run"), split: "development" as const, variants: MATH_VARIANTS, repeats: 1, seed: 1, timeoutMs: 1000, concurrency: 1, thinking: "disabled" as const,
        corpusPath: path, rag: f.rag, modelFactory: () => ({ async turn() { return { content: "推导得到2。\n答案：B", toolCalls: [] }; } }) };
    const result = await evaluateMath(options);
    assert.equal(result.rows.length, 4); assert.ok(result.rows.every(r => r.correct === 1));
    assert.match(await readFile(join(options.out, "combined", "report.html"), "utf8"), /初中数学/);
    await assert.rejects(() => evaluateMath(options), /Output already exists/);
});
test("OCR endpoint reserves explicit 501; configured provider passes typed bytes and flags low confidence", async () => {
    for (const configured of [false, true]) {
        let recognized = 0;
        const app = express(); app.use(express.json());
        app.use("/api/math", createMathModule("combined", configured ? { async recognize(input, signal) {
            assert.equal(input.mimeType, "image/png"); assert.ok(signal); recognized++;
            return { text: "x² − 3x = 0", regions: [{ text: "x²", confidence: .8 }], warnings: [] };
        } } : undefined)); app.use(errorHandler(logger));
        const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
        try {
            const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            const response = await fetch(`${base}/api/math/ocr`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mimeType: "image/png", base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") }) });
            assert.equal(response.status, configured ? 200 : 501);
            if (configured) { assert.equal((await response.json()).data.needsConfirmation, true); assert.equal(recognized, 1); }
        } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    }
});
