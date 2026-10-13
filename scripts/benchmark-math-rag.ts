import { writeFile, mkdir } from "node:fs/promises";
import { loadCorpus } from "../src/modules/math/corpus.js";
import { renderQuestion } from "../src/modules/math/contracts.js";
import { MathRag } from "../src/modules/math/rag.js";
import { GlmEmbeddings } from "../src/infrastructure/llm/glm-model.js";
const corpus = await loadCorpus("evals/math/corpus.json");
const rag = await MathRag.open(corpus.knowledge, "data/math/index.json", new GlmEmbeddings({ llmApiKey: process.env.LLM_API_KEY, llmModel: "glm-4.7", llmBaseUrl: "https://open.bigmodel.cn/api/paas/v4", llmTimeoutMs: 120000 }));
const rows = [];
for (const q of corpus.development) {
    const query = `${renderQuestion(q)}\n请用中文给出关键解题步骤，最后单独一行“答案：A”（字母替换为正确选项）。`;
    const dense = await rag.search(query, "dense"), hybrid = await rag.search(query, "hybrid");
    const row = { id: q.id, topic: q.topic, dense: dense.hits.map(h => ({ id: h.question.id, topic: h.question.topic })), hybrid: hybrid.hits.map(h => ({ id: h.question.id, topic: h.question.topic })),
        denseHit: dense.hits.some(h => h.question.topic === q.topic), hybridHit: hybrid.hits.some(h => h.question.topic === q.topic) };
    rows.push(row); console.log(`${q.id} dense=${row.denseHit} hybrid=${row.hybridHit}`);
}
await mkdir("data/evaluations/math-rag-dev-v2", { recursive: true });
await writeFile("data/evaluations/math-rag-dev-v2/retrieval.json", JSON.stringify({ split: "development", rows, denseRecallAt3: rows.filter(r => r.denseHit).length / rows.length, hybridRecallAt3: rows.filter(r => r.hybridHit).length / rows.length }, null, 2));
console.log(`dense=${rows.filter(r => r.denseHit).length}/${rows.length}, hybrid=${rows.filter(r => r.hybridHit).length}/${rows.length}`);
