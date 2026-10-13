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
import { loadCorpus, validateCorpus } from "../src/modules/math/corpus.js";
import { MathRag, buildIndex, validateIndex, type VectorIndex } from "../src/modules/math/rag.js";
import { MathSubmissions } from "../src/modules/math/submissions.js";
import { createMathProfile } from "../src/modules/math/profile.js";
import type { MathCorpus } from "../src/modules/math/contracts.js";
import { MATH_VARIANTS } from "../src/modules/math/contracts.js";
import { loadConfig } from "../src/config/env.js";
import { errorHandler } from "../src/common/http/error-handler.js";
import { redact } from "../src/common/logging/redaction.js";
import { mathEmbeddingConfig } from '../src/bootstrap/math-chat-agent.js';
import { examples, fixture, question } from "./math-fixtures.js";
const logger = { info() {}, error() {} };
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
test("corpus loading validates self-contained data and rejects split leakage and invalid answers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "math-corpus-")), path = join(dir, "corpus.json");
    const input: MathCorpus = { version: 1, id: "test-fixture", knowledge: examples,
        development: [question("dev", "测试题：求x+1=3")], test: [question("test", "最终题：求x-1=1")], excluded: [] };
    await writeFile(path, JSON.stringify(input));
    const c = await loadCorpus(path);
    assert.deepEqual(c, input);
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
test("redaction preserves complete long solutions and legitimate Basic Concepts topics", () => {
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
