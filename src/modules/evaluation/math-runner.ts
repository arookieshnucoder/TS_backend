import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../../config/env.js";
import type { AgentModel } from "../agent/model.js";
import type { EvalEvent, EvalReport, Trial } from "./contracts.js";
import { sourceHash, digest } from "./runner.js";
import { summarize, compare, percentile, rate } from "./statistics.js";
import { writeReport } from "./report.js";
import { GlmModel, GlmEmbeddings } from "../../infrastructure/llm/glm-model.js";
import { loadCorpus, hash } from "../math/corpus.js";
import { MathRag } from "../math/rag.js";
import { createMathProfile } from "../math/profile.js";
import { MATH_VARIANTS, renderQuestion, type MathVariant, type MathQuestion } from "../math/contracts.js";
import { redact, environmentSecrets } from "../../common/logging/redaction.js";
export function extractMathAnswer(answer: string): string | null {
    const matches = [...answer.matchAll(/(?:^|\n)\s*(?:\*\*)?(?:最终答案|答案)\s*[：:]\s*(?:\*\*)?\s*([A-D])(?:\b|[。．.\s*]|$)/g)];
    // Conflicting final answers fail closed; letters in reasoning and retrieved examples are ignored.
    return matches.length && new Set(matches.map(m => m[1])).size === 1 ? matches[0]![1]! : null;
}
/** Rotate choices without changing the problem. Gold remains exclusively in the grading side. */
export function permuteQuestion(q: MathQuestion, repeat: number): MathQuestion {
    const shift = (repeat - 1) % 4;
    return { ...q, options: [...q.options.slice(shift), ...q.options.slice(0, shift)], answer: "ABCD"[("ABCD".indexOf(q.answer) - shift + 4) % 4]! };
}
/** 数学评测配置，指定题库、模型、实验策略和结果输出。 */
export interface MathEvalOptions {
    split: "development" | "test"; out: string; repeats: number; seed: number; variants: MathVariant[];
    timeoutMs: number; concurrency: number; thinking: "enabled" | "disabled";
    corpusPath?: string; indexPath?: string; modelFactory?: () => AgentModel; rag?: MathRag;
    progress?(done: number, total: number, variant: MathVariant, trial: Trial): void;
}
async function mathTrial(q: MathQuestion, variant: MathVariant, repeat: number, options: MathEvalOptions, rag: MathRag): Promise<Trial> {
    q = permuteQuestion(q, repeat);
    const start = performance.now(), events: EvalEvent[] = [];
    const event = (name: string, fields: Record<string, unknown> = {}) => { events.push({ name, elapsedMs: performance.now() - start, fields: structuredClone(fields) }); };
    const config = loadConfig({ ...process.env, AGENT_WORKSPACE_ENABLED: "false", LLM_MODEL: process.env.LLM_MODEL ?? "glm-4.6v", LLM_BASE_URL: process.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4" });
    const model = options.modelFactory?.() ?? new GlmModel(config, options.thinking);
    const profile = createMathProfile(variant, rag, model, config.context, { info() {}, error() {} }, {
        ...config.harness, recovery: { ...config.harness.recovery, modelAttemptTimeoutMs: options.timeoutMs, modelRetries: 1 }, toolOutputTokens: 4096,
    });
    let answer = "", outcome: Trial["outcome"] = "success", errorCode: string | undefined;
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(new DOMException("Math evaluation timeout", "TimeoutError")), options.timeoutMs);
    try {
        const result = await profile.harness.run({ history: [], question: `${renderQuestion(q)}\n请用中文给出关键解题步骤，最后单独一行“答案：A”（字母替换为正确选项）。`,
            tools: [rag.tool(profile.mode, event)], metadata: { caseId: q.id, variant, repeat }, onEvent: event }, abort.signal);
        answer = result.content;
    } catch (error) { outcome = abort.signal.aborted ? "timed_out" : "failure"; errorCode = error instanceof Error ? error.name : "UNKNOWN"; }
    finally { clearTimeout(timer); }
    const extracted = extractMathAnswer(answer), correct = extracted === q.answer;
    const completed = events.filter(e => e.name === "agent.model.completed"), started = events.filter(e => e.name === "agent.model.started");
    const usage = completed.map(e => e.fields.usage as { inputTokens: number; outputTokens: number } | undefined);
    const noModelNeeded=started.length===0&&events.some(e=>e.name==='math.native_verified');
    const fullUsage = noModelNeeded || (usage.length > 0 && usage.every(Boolean));
    const retrievals = events.filter(e => e.name === "math.retrieval");
    const hits = retrievals.flatMap(e => e.fields.topics as string[]), topicRecall = retrievals.length ? Number(hits.includes(q.topic)) : 0;
    const sources = new Set(retrievals.flatMap(e => e.fields.ids as string[]));
    const cited = [...sources].filter(id => answer.includes(id));
    const secrets = environmentSecrets();
    const limits = { maxStringLength: 16384, maxCharacters: 65536 };
    return { caseId: q.id, category: q.topic, kind: "task", repeat, seed: options.seed + repeat, outcome, errorCode, answer: redact(answer, secrets, limits) as string,
        events: events.map(e => ({ ...e, fields: redact(e.fields, secrets, limits) as Record<string, unknown> })),
        grade: { passed: correct && outcome === "success", failures: [...(outcome !== "success" ? [outcome] : []), ...(!extracted ? ["missing_final_answer"] : !correct ? ["wrong_answer"] : [])],
            factCoverage: Number(correct), evidenceCoverage: topicRecall, citationCoverage: sources.size ? Number(cited.length > 0) : null,
            toolPrecision: null, toolRecall: null, argumentValidity: null, forbiddenMatches: 0, policyCompliant: true },
        metrics: { durationMs: performance.now() - start, setupMs: 0, agentMs: performance.now() - start,
            modelAttempts: started.length, modelTurns: new Set(started.map(e => e.fields.modelCallId)).size,
            toolCalls: events.filter(e => e.name === "agent.tool.started").length, toolAttempts: events.filter(e => e.name === "agent.tool").reduce((s, e) => s + Number(e.fields.attempts ?? 0), 0),
            retries: events.filter(e => e.name === "agent.retry").length, fallbacks: 0, compressions: events.filter(e => e.name === "context.compressed").length,
            estimatedInputTokens: events.filter(e => e.name === "agent.context").reduce((s, e) => s + Number(e.fields.inputTokens), 0),
            reportedInputTokens: fullUsage ? usage.reduce((s, u) => s + u!.inputTokens, 0) : null,
            reportedOutputTokens: fullUsage ? usage.reduce((s, u) => s + u!.outputTokens, 0) : null, usageCoverage: completed.length ? usage.filter(Boolean).length / completed.length : null, costUsd: null } };
}
export async function evaluateMath(options: MathEvalOptions) {
    if (!Number.isInteger(options.repeats) || options.repeats < 1 || options.repeats > 10 || !Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4 ||
        !options.variants.length || new Set(options.variants).size !== options.variants.length || options.variants.some(v => !MATH_VARIANTS.includes(v)) || !["development", "test"].includes(options.split) ||
        !Number.isSafeInteger(options.seed) || !Number.isFinite(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 600000 || !["enabled", "disabled"].includes(options.thinking)) throw new Error("Invalid math evaluation options");
    if (!process.env.LLM_API_KEY && !options.modelFactory) throw new Error("Live math evaluation requires LLM_API_KEY; no fixture fallback");
    const out = resolve(options.out);
    try { await stat(join(out, "manifest.json")); throw new Error("Output already exists; choose a new run directory"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const corpusPath = options.corpusPath ?? "evals/math/corpus.json", indexPath = options.indexPath ?? "data/math/index.json";
    const corpus = await loadCorpus(corpusPath), questions = corpus[options.split];
    if (!questions.length) throw new Error("Empty evaluation split");
    const modelName = process.env.LLM_MODEL ?? "glm-4.6v";
    const rag = options.rag ?? await MathRag.open(corpus.knowledge, indexPath, new GlmEmbeddings({ llmApiKey: process.env.LLM_API_KEY, llmModel: modelName, llmBaseUrl: process.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4", llmTimeoutMs: options.timeoutMs }));
    if (rag.questions.length !== corpus.knowledge.length || hash(JSON.stringify(rag.questions)) !== hash(JSON.stringify(corpus.knowledge))) throw new Error("Evaluation RAG does not match trusted knowledge split");
    const variantRags = new Map(options.variants.map(v => [v, rag.fork()]));
    await mkdir(out, { recursive: true });
    const datasetHash = hash(JSON.stringify(questions)), systemHash = await sourceHash(resolve("src"));
    const graderHash = hash(await readFile("src/modules/evaluation/math-runner.ts", "utf8"));
    const manifest = { corpusHash: hash(await readFile(corpusPath, "utf8")), datasetHash, systemHash, graderHash, split: options.split,
        repeats: options.repeats, seed: options.seed, variants: options.variants, model: modelName, thinking: options.thinking, temperature: 0,
        maxOutputTokens: options.thinking === "enabled" ? 8192 : 2048,
        outputBudget: options.thinking === "enabled" ? "8192" : "2048; long or multiple inputs 4096",
        concurrency: options.concurrency, knowledgeCount: corpus.knowledge.length, questionCount: questions.length, startedAt: new Date().toISOString(),
        evaluationScope: options.split === "test" ? "fixed regression benchmark of GLM plus deterministic math routes; failure types inspected during iteration, not pure LLM or unseen generalization capability" : "development",
        textAudits: questions.filter(q => q.textAudit).map(q => ({ id: q.id, ...q.textAudit })),
        grading: "final choice exact match; repeat r rotates choices by (r-1)%4; evidenceCoverage = matching annotated knowledge topic at top3, not semantic solution correctness", costNote: "Token counts exclude embeddings; monetary cost not estimated without verified pricing" };
    await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
    const trials = new Map(options.variants.map(v => [v, [] as Trial[]]));
    const jobs = Array.from({ length: options.repeats }, (_, repeat) => questions.flatMap(q => options.variants.map(variant => ({ q, variant, repeat: repeat + 1 })))).flat();
    let random = options.seed >>> 0;
    for (let i = jobs.length - 1; i > 0; i--) { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; const j = random % (i + 1); [jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!]; }
    let cursor = 0, done = 0;
    await Promise.all(Array.from({ length: options.concurrency }, async () => {
        while (cursor < jobs.length) {
            const job = jobs[cursor++]!;
            const trial = await mathTrial(job.q, job.variant, job.repeat, options, variantRags.get(job.variant)!);
            trials.get(job.variant)!.push(trial);
            await writeFile(join(out, `${job.variant}-${job.q.id}-${job.repeat}.json`), JSON.stringify(trial, null, 2));
            options.progress?.(++done, jobs.length, job.variant, trial);
        }
    }));
    const reports: Partial<Record<MathVariant, EvalReport>> = {};
    for (const variant of options.variants) {
        const items = trials.get(variant)!;
        const report: EvalReport = { version: 1, runId: randomUUID(), startedAt: manifest.startedAt, finishedAt: new Date().toISOString(),
            provenance: { mode: "live", profile: "standard", variant: "normal", repeats: options.repeats, seed: options.seed, datasetId: `${corpus.id}-${options.split}`, datasetHash, graderHash, systemHash,
                revision: "unknown", dirty: true, model: modelName, timeoutMs: options.timeoutMs, providerFingerprint: digest(process.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4"),
                runtimeSettings: { mathVariant: MATH_VARIANTS.indexOf(variant), temperature: 0, thinking: options.thinking === "enabled" ? 1 : 0 }, nodeVersion: process.version, platform: process.platform,
                fallbackModel: null, fallbackProviderFingerprint: null, inputUsdPerMillion: null, outputUsdPerMillion: null },
            scopeNote: `初中数学真实模型消融：${variant}。使用固定${options.split}题集；同模型、同知识库、同输入、同评分器。准确率只判最终选择；知识点命中不等于证明步骤正确。基线为原AskAgent+原AgentHarness接纯向量检索工具。`,
            ...summarize(items), trials: items, gate: { passed: items.every(t => t.grade.passed), reasons: [
                ...(items.some(t => t.outcome !== "success") ? ["incomplete_model_runs"] : []), ...(items.some(t => !t.grade.passed && t.outcome === "success") ? ["wrong_or_missing_answers"] : [])] } };
        reports[variant] = report;
    }
    const baseline = reports.baseline;
    for (const [variant, report] of Object.entries(reports)) { if (baseline && variant !== "baseline") report!.comparison = compare(report!, baseline); await writeReport(report!, join(out, variant)); }
    const rows = Object.entries(reports).map(([variant, r]) => {
        const retrieval = r!.trials.flatMap(t => t.events.filter(e => e.name === "math.retrieval"));
        return { variant, correct: r!.summary.passRate.successes, total: r!.summary.passRate.total, accuracy: r!.summary.passRate.value,
            allPermutationsCorrect: r!.cases.filter(c => c.allTrialsPassed).length, questionCount: r!.cases.length,
            robustAccuracy: r!.cases.filter(c => c.allTrialsPassed).length / r!.cases.length,
            wilson95: r!.summary.passRate.wilson95, topicRecallAt3: r!.summary.dimensions.evidenceCoverage?.value,
            p50Ms: r!.summary.latencyMs.p50, p95Ms: r!.summary.latencyMs.p95,
            avgModelCalls: r!.summary.averages.modelAttempts, avgInputTokens: r!.summary.averages.reportedInputTokens, avgOutputTokens: r!.summary.averages.reportedOutputTokens,
            retrievalP50Ms: retrieval.length ? percentile(retrieval.map(e => Number(e.fields.durationMs)), .5) : null,
            cacheHits: retrieval.filter(e => e.fields.cacheHit).length,
            nativeTrials:r!.trials.filter(t=>t.events.some(e=>e.name==='math.native_verified')).length,
            modelAttemptedTrials:r!.trials.filter(t=>t.metrics.modelAttempts>0).length };
    });
    const best = [...rows].sort((a, b) => b.accuracy - a.accuracy || a.p50Ms - b.p50Ms)[0]!;
    const comparison = { ...manifest, rows, bestObserved: best.variant, combinedBestAccuracy: !rows.some(r => r.accuracy > (rows.find(r => r.variant === "combined")?.accuracy ?? -1)),
        allRunsCompleted: [...trials.values()].flat().every(t => t.outcome === "success"),
        warning: `有限固定题集的工作流指标，包含程序证明路线；${rows.map(r=>`${r.variant}程序解题${r.nativeTrials}次/调用模型${r.modelAttemptedTrials}次`).join('；')}。固定test回归集已用于错误分析，不代表纯LLM能力、未见题泛化或总体显著性。缓存命中单独记录。` };
    await writeFile(join(out, "comparison.json"), JSON.stringify(comparison, null, 2));
    const escape = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    await writeFile(join(out, "comparison.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>初中数学消融测评</title><style>body{font:16px/1.6 system-ui;color:#25354c;background:#f3f6fb;margin:0}main{max-width:1100px;padding:32px;margin:auto}section{background:white;border-radius:14px;padding:24px;margin:20px 0;overflow:auto}table{border-collapse:collapse;width:100%;min-width:650px}th,td{text-align:left;padding:12px;border-bottom:1px solid #e1e7f0}a{color:#216dba}p{color:#52647c}strong{color:#186954}</style><main><h1>初中数学 Agent + Harness</h1><p>${escape(options.split)} · ${escape(modelName)} · ${questions.length}题 × ${options.repeats}轮选项置换 · 100题知识库</p><section><table><tr><th>版本（点击看轨迹）</th><th>正确/总数</th><th>准确率</th><th>全部置换正确</th><th>知识点R@3</th><th>p50秒</th><th>p95秒</th></tr>${rows.map(r => `<tr><td><a href="${escape(r.variant)}/report.html">${escape(r.variant)}</a></td><td>${r.correct}/${r.total}</td><td>${(100*r.accuracy).toFixed(1)}%</td><td>${r.allPermutationsCorrect}/${r.questionCount}</td><td>${(100*(r.topicRecallAt3??0)).toFixed(1)}%</td><td>${(r.p50Ms/1000).toFixed(2)}</td><td>${(r.p95Ms/1000).toFixed(2)}</td></tr>`).join("")}</table></section><section><strong>观察最优：${escape(best.variant)}</strong><p>${escape(comparison.warning)}</p><p>同一模型设置、同一知识库、同一输入、同一评分器。最终选项严格匹配；相关性按标注知识点命中；每个版本有完整JSON、HTML与逐题轨迹。置换选项可检查是否复制相似题答案字母。基线数据不经过降质或故意限流。</p><a href="comparison.json">下载对比JSON</a></section></main></html>`);
    await writeFile(join(out, "comparison.md"), `# 初中数学 Agent + Harness 消融测评\n\n${comparison.warning}\n\n题集 ${options.split}，每题 ${options.repeats} 次；知识库 ${corpus.knowledge.length} 题。${escape(modelName)}，temperature=0，thinking=${options.thinking}。\n\n| 版本 | 正确/总数 | 准确率 | 知识点 Recall@3 | p50 秒 | p95 秒 | 平均模型调用 |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.map(r => `| ${r.variant} | ${r.correct}/${r.total} | ${(r.accuracy * 100).toFixed(1)}% | ${((r.topicRecallAt3 ?? 0) * 100).toFixed(1)}% | ${(r.p50Ms / 1000).toFixed(2)} | ${(r.p95Ms / 1000).toFixed(2)} | ${r.avgModelCalls?.toFixed(2)} |`).join("\n")}\n\n观察到的最优版本（先准确率，再p50）：${best.variant}。是否合并版准确率最优：${comparison.combinedBestAccuracy}。\n\n指标为真实请求结果，未作奖励性评分；失败和超时计入分母。解析完整性需教师另行审核。每个版本有report.json、report.md、report.html及逐题原始轨迹。\n`);
    return comparison;
}
