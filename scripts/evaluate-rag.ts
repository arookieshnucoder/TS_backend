import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { loadConfig } from "../src/config/env.js";
import { GlmEmbeddings, GlmModel } from "../src/infrastructure/llm/glm-model.js";
import { modelSkillSelector } from "../src/modules/harness/skills/matching.js";
import { skillClosure } from "../src/modules/harness/skills/document.js";
import { SolutionSkillLibrary } from "../src/modules/harness/skills/library.js";
import type { SkillEmbeddings } from "../src/modules/harness/skills/contracts.js";
import { evaluateRetrieval, validateRetrievalCases } from "../src/modules/evaluation/retrieval-metrics.js";
import { readSkillExports, readonlySkillStore, validateSkillCatalog } from "../src/modules/evaluation/skill-retrieval-catalog.js";

const usage = `npm run eval:rag -- [--source snapshot|files|postgres] [--embedding lexical|live] [--matching ranked|semantic] [--concurrency 1..4]
  --queries <judgments.json> [--catalog <catalog.json>] [--skills-dir data/solution-skills]
  [--out data/evaluations/rag-<new>]
Defaults: current exported skills, lexical matching, no API requests or database writes.
Judgments must be supplied explicitly; snapshot additionally requires --catalog.
postgres uses a read-only transaction; live uses the configured skill embedding endpoint.`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const percentage = (value: number | null | undefined) => value == null ? "N/A" : `${(value * 100).toFixed(2)}%`;

async function main() {
    const args = process.argv.slice(2), options = new Map<string, string>();
    if (args.includes("--help")) { console.log(usage); return; }
    for (let i = 0; i < args.length; i += 2) {
        const key = args[i]?.replace(/^--/, ""), value = args[i + 1];
        if (!args[i]?.startsWith("--") || !key || !["source", "embedding", "matching", "concurrency", "catalog", "skills-dir", "queries", "out"].includes(key) || !value || value.startsWith("--") || options.has(key)) throw new Error("Invalid CLI options");
        options.set(key, value);
    }
    const source = options.get("source") ?? "files", embeddingMode = options.get("embedding") ?? "lexical";
    const matching = options.get("matching") ?? "ranked";
    const concurrency = Number(options.get("concurrency") ?? 1);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Invalid concurrency");
    if (!["snapshot", "files", "postgres"].includes(source) || !["lexical", "live"].includes(embeddingMode) || !["ranked", "semantic"].includes(matching)) throw new Error("Invalid evaluation mode");
    if (!options.has("queries") || source === "snapshot" && !options.has("catalog")) {
        console.error(`评测须显式传入 --queries；snapshot 模式还须传入 --catalog。\n${usage}`);
        process.exitCode = 1; return;
    }
    if (embeddingMode === "live" && source === "files") throw new Error("Export files lack embeddings; use a complete snapshot or postgres for live evaluation");
    const config = source === "postgres" || embeddingMode === "live" || matching === "semantic" ? loadConfig() : undefined;
    const catalog = await (async () => {
        if (source === "files") return readSkillExports(resolve(options.get("skills-dir") ?? "data/solution-skills"));
        if (source === "snapshot") return validateSkillCatalog(JSON.parse(await readFile(resolve(options.get("catalog")!), "utf8")));
        // 不调用会初始化表和索引的存储适配器，评测读取严格保持只读。
        const pool = new Pool({ connectionString: config!.skills.databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
        try {
            const client = await pool.connect();
            try {
                await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
                const result = await client.query("SELECT document FROM solution_skills ORDER BY subject, id");
                await client.query("ROLLBACK");
                return validateSkillCatalog(result.rows.map(row => row.document));
            } finally { client.release(); }
        } finally { await pool.end(); }
    })();
    const judgmentText = await readFile(resolve(options.get("queries")!), "utf8");
    const judgments = JSON.parse(judgmentText);
    if (judgments.version !== 1 || typeof judgments.scope !== "string" || !judgments.scope.trim()) throw new Error("Invalid judgment dataset");
    const contentHash = hash(JSON.stringify([...catalog].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, subject, markdown }) => ({ id, subject, markdown }))));
    if (judgments.catalogContentHash && judgments.catalogContentHash !== contentHash) throw new Error("Catalog content changed: relabel judgments before evaluating");
    const cases = validateRetrievalCases(judgments.cases, new Map(catalog.map(skill => [skill.id, skill.subject])));
    const embeddingStats = { calls: 0, failures: 0, comparableDocuments: 0 };
    let embeddings: SkillEmbeddings | undefined;
    if (embeddingMode === "live") {
        if (!config!.skills.embeddingApiKey) throw new Error("Configured skill embedding API key is required");
        const provider = new GlmEmbeddings({ ...config!, llmBaseUrl: config!.skills.embeddingBaseUrl, llmApiKey: config!.skills.embeddingApiKey });
        embeddingStats.comparableDocuments = catalog.filter(skill => skill.embedding?.model === provider.model && skill.embedding.vector.length === provider.dimensions).length;
        if (!embeddingStats.comparableDocuments) throw new Error("Catalog has no comparable embeddings; lexical evaluation is available");
        embeddings = { model: provider.model, async embed(texts, signal) {
            embeddingStats.calls++;
            try { return await provider.embed(texts, signal); }
            catch (error) { embeddingStats.failures++; throw error; }
        } };
    }
    const modelStats = { requests: 0, inputTokens: 0, outputTokens: 0, decisions: [] as { inputHash: string; response: string }[] };
    const model = matching === "semantic" ? new GlmModel({ ...config!, llmModel: config!.verification.model, llmApiKey: config!.verification.apiKey,
        llmBaseUrl: config!.verification.baseUrl, llmTimeoutMs: config!.verification.timeoutMs }) : undefined;
    if (model && !config!.llmApiKey) throw new Error("LLM_API_KEY is required for semantic matching");
    const selector = model ? modelSkillSelector({ async turn(...args) {
        modelStats.requests++; const turn = await model.turn(...args);
        modelStats.inputTokens += turn.usage?.inputTokens ?? 0; modelStats.outputTokens += turn.usage?.outputTokens ?? 0;
        modelStats.decisions.push({ inputHash: hash(args[0].at(-1)?.content ?? ""), response: turn.content }); return turn;
    } }) : undefined;
    const library = new SolutionSkillLibrary(readonlySkillStore(catalog), resolve("data/evaluation-unused-skill-exports"), embeddings);
    let completed = 0;
    const result = await evaluateRetrieval(cases, async ({ query, subject }) => {
        const started = performance.now();
        const found = await library.search(subject, query, undefined, selector);
        console.log(`retrieval ${++completed}/${cases.length}: ${found.matches.length} matched`);
        return { ids: found.matches.map(hit => hit.skill.id), durationMs: performance.now() - started };
    }, [1, 3], id => skillClosure(catalog, id).map(skill => skill.id), concurrency);
    const implementationFiles = ["scripts/evaluate-rag.ts", "src/modules/evaluation/retrieval-metrics.ts", "src/modules/evaluation/skill-retrieval-catalog.ts", "src/modules/harness/skills/library.ts", "src/modules/harness/skills/document.ts", "src/modules/harness/skills/matching.ts"];
    const implementationHashes = Object.fromEntries(await Promise.all(implementationFiles.map(async path => [path, hash(await readFile(path, "utf8"))])));
    const report = { version: 1, createdAt: new Date().toISOString(), scope: judgments.scope,
        provenance: { source, embeddingMode, matching, concurrency, matcherModel: model ? config!.verification.model : null, modelStats, datasetHash: hash(judgmentText), catalogContentHash: contentHash, catalogHash: hash(JSON.stringify([...catalog].sort((a, b) => a.id.localeCompare(b.id)))),
            implementationHashes, catalogSize: catalog.length, questionShapeAvailable: catalog.every(skill => skill.questionShape !== "unavailable-in-export"), embeddingStats,
            retrievalLimit: 3, autoLoadedLimit: selector ? 3 : 1, modelGenerationRequests: 0, databaseWrites: 0 },
        ...result };
    const rows = [["全部", result.summary] as const, ...Object.entries(result.bySubject)];
    const table = rows.flatMap(([name, summary]) => [1, 3].map(k => {
        const m = summary.at[k]!;
        return `| ${name} | ${summary.positive}/${summary.noAnswer} | ${k} | ${percentage(m.recall)} | ${percentage(m.hit?.value)} | ${percentage(m.precision)} | ${m.mrr?.toFixed(4) ?? "N/A"} | ${m.ndcg?.toFixed(4) ?? "N/A"} | ${percentage(summary.noAnswerFalsePositiveRate?.value)} |`;
    }));
    const markdown = `# Skills 检索评测\n\n${report.scope}\n\n来源：${source}；embedding：${embeddingMode}；匹配：${matching}；方法数：${catalog.length}。不运行答案生成或学习入库。\n\n` +
        `| 分组 | 有方法/无方法题数 | K | Recall@K | Hit@K | Precision@K | MRR@K | nDCG@K | 无方法误召回率 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${table.join("\n")}\n\n` +
        `Recall 的分母为全部标注相关方法；Precision 的分母为 K，返回不足 K 不补位。若只有一个相关方法，Precision@3 的最高值就是 33.33%，不能把它直接解释成内容质量差；JSON 另存以实际返回条数为分母的 returnedPrecision。空相关集不纳入正例宏平均，单独统计误召回。失败按漏召回计分且不算正确拒绝。Hit 和二项比率的 Wilson 95% 区间保存在 JSON。\n\n` +
        `语义匹配后最多加载3个互补经验，普通排名模式默认加载首个。Hit@1/MRR 衡量首项相关性，Recall@3 衡量多方法覆盖。\n\n` +
        `JSON另存coverageRecall：依照load使用的依赖图展开子经验引用后的结构覆盖率，与原始ID召回分别报告；不测量工具输出截断后的逐字证据保留情况。\n\n` +
        `questionShape 可用：${report.provenance.questionShapeAvailable}。SKILL.md 导出缺少原问题指纹和向量。embedding 失败 ${embeddingStats.failures}/${embeddingStats.calls} 次，故障显式计分；匹配模型调用 ${modelStats.requests} 次，输入/输出token为 ${modelStats.inputTokens}/${modelStats.outputTokens}。\n\n` +
        `样本为开发或固定回归题，尚未经独立教师复标，不代表学生真实分布、未见题泛化或最终答题质量。检索并发为${concurrency}；耗时含首次初始化，不是服务负载指标。\n\n` +
        `## 失败与误召回样本\n\n` + result.rows.filter(r => r.failed || (r.relevantIds.length ? r.at[1]!.hit === 0 : r.ids.length > 0)).map(r => `- ${r.id} (${r.subject}/${r.category}): ${r.failed ? "检索失败" : r.relevantIds.length ? "首条未命中" : "无适用方法但返回了结果"}；返回 ${r.ids.join(", ") || "空"}`).join("\n") + "\n";
    const out = resolve(options.get("out") ?? `data/evaluations/rag-skills-${Date.now()}`);
    await mkdir(resolve(out, ".."), { recursive: true }); await mkdir(out);
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    await writeFile(join(out, "report.md"), markdown);
    console.log(markdown);
    console.log(`Report: ${out}`);
    if (result.summary.failureRate.successes || embeddingStats.failures) process.exitCode = 1;
}

main().catch(() => { console.error("RAG evaluation failed. Check CLI options, dataset/catalog consistency, and configured database/embedding availability. No secrets are included in this error."); process.exitCode = 1; });
