import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../../config/env.js";
import { GlmModel } from "../../infrastructure/llm/glm-model.js";
import type { AgentModel } from "../agent/model.js";
import { englishHash, loadEnglishCorpus, validateEnglishCorpus } from "../english/corpus.js";
import { englishTask, ENGLISH_VARIANTS, type EnglishCorpus, type EnglishQuestion, type EnglishVariant } from "../english/contracts.js";
import { EnglishHarness } from "../english/harness.js";
import { englishChoice } from "../english/agent.js";
import { percentile, rate } from "./statistics.js";
import { sourceHash } from "./runner.js";
import type { EnglishWorkflow } from "../english/response.js";

/** 英语评测配置，指定数据划分、策略、并发和输出位置。 */
export interface EnglishEvaluationOptions {
    out: string; split: "knowledge" | "development" | "test" | "all"; variants: EnglishVariant[]; limit: number;
    concurrency: number; maxInputTokens: number; contextTokens: number; thinking?: "enabled" | "disabled"; workflow?: EnglishWorkflow;
    corpusPath?: string; corpus?: EnglishCorpus; modelFactory?: () => AgentModel;
}
/** 一次英语评测任务，把同一材料的待答题目组合成求解输入。 */
export interface EnglishEvaluationJob {
    passageId: string; variant: EnglishVariant; durationMs: number; modelCalls: number; modelAttempts: number; toolCalls: number; inputTokens: number; outputTokens: number;
    answers: { id: string; number: number; kind: string; split: string; category: string; expected: string; actual: string | null; passed: boolean }[]; error?: string;
}
export function summarizeEnglishJobs(results: EnglishEvaluationJob[], variants: EnglishVariant[]) {
    return variants.map(variant => {
        const items = results.filter(r => r.variant === variant), answers = items.flatMap(r => r.answers);
        const accuracy = (group: typeof answers) => group.length ? rate(group.filter(a => a.passed).length, group.length) : null;
        return { variant, jobs: items.length, questions: answers.length, accuracy: accuracy(answers), failures: items.filter(r => r.error).length,
            byKind: Object.fromEntries(["reading", "grammar", "cloze"].map(kind => [kind, accuracy(answers.filter(a => a.kind === kind))])),
            bySplit: Object.fromEntries(["knowledge", "development", "test"].map(split => [split, accuracy(answers.filter(a => a.split === split))])),
            jobLatencyMs: { p50: percentile(items.map(r => r.durationMs), .5), p95: percentile(items.map(r => r.durationMs), .95) },
            modelCalls: items.reduce((sum, r) => sum + r.modelCalls, 0), modelAttempts: items.reduce((sum, r) => sum + r.modelAttempts, 0),
            inputTokens: items.reduce((sum, r) => sum + r.inputTokens, 0), outputTokens: items.reduce((sum, r) => sum + r.outputTokens, 0) };
    });
}
export async function evaluateEnglish(options: EnglishEvaluationOptions) {
    if (!["knowledge", "development", "test", "all"].includes(options.split) || !options.variants.length || new Set(options.variants).size !== options.variants.length ||
        options.variants.some(v => !ENGLISH_VARIANTS.includes(v)) || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 500 ||
        !Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4 ||
        !Number.isSafeInteger(options.maxInputTokens) || options.maxInputTokens < 4096 || options.maxInputTokens > 32768 ||
        !Number.isSafeInteger(options.contextTokens) || options.contextTokens < 256 || options.contextTokens > 6000 ||
        options.workflow !== undefined && !["direct", "grounded"].includes(options.workflow) ||
        options.thinking !== undefined && !["enabled", "disabled"].includes(options.thinking)) throw new Error("Invalid English evaluation options");
    if (!process.env.LLM_API_KEY && !options.modelFactory) throw new Error("English live evaluation requires LLM_API_KEY");
    const out = resolve(options.out);
    try { await stat(out); throw new Error("Choose a new English evaluation output directory"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const corpus = options.corpus ? validateEnglishCorpus(options.corpus) : await loadEnglishCorpus(options.corpusPath ?? "evals/english/corpus.json");
    const selected = (options.split === "all" ? [...corpus.knowledge, ...corpus.development, ...corpus.test] : corpus[options.split]).slice(0, options.limit);
    if (!selected.length) throw new Error("Empty English evaluation split");
    const config = loadConfig({ ...process.env, NODE_ENV: "test", SCHOOL_SUBJECT: "english", LLM_MODEL: "glm-4.5-air",
        LLM_BASE_URL: process.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4", ENGLISH_THINKING: options.thinking ?? "disabled",
        ANSWER_REVIEW_ENABLED: "false", LLM_MAX_INPUT_TOKENS: String(options.maxInputTokens), AGENT_MODEL_ATTEMPT_TIMEOUT_MS: "60000" });
    const grouped = new Map<string, EnglishQuestion[]>();
    for (const q of selected) grouped.set(q.passageId, [...(grouped.get(q.passageId) ?? []), q]);
    const jobs = [...grouped].flatMap(([passageId, questions]) => options.variants.map(variant => ({ passageId, questions, variant })));
    const manifest = { subject: "english", targetGrade: 9, model: config.llmModel, thinking: config.english.thinking, workflow: options.workflow ?? "grounded", review: "not_configured",
        startedAt: new Date().toISOString(), mode: options.modelFactory ? "offline" : "live", split: options.split, variants: options.variants,
        questionCount: selected.length, passageCount: grouped.size, jobCount: jobs.length, cases: selected.map(q => q.id),
        corpusHash: englishHash(JSON.stringify(corpus)), sourceHash: await sourceHash(resolve("src")), grader: "exact per-question final choice, missing/conflicting conclusions fail",
        batching: "Jobs group questions by passage; grounded reading compares a batch candidate with isolated per-question solves and arbitrates only disagreements. All parent/child calls and tokens count once; accuracy counts once per question.",
        limitations: [...corpus.limitations, ...(options.split === "all" ? ["All-split coverage includes library/development items; report held-out test accuracy separately."] : [])] };
    await mkdir(join(out, "jobs"), { recursive: true });
    await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
    const results: EnglishEvaluationJob[] = [];
    const splitById = new Map(["knowledge", "development", "test"].flatMap(split => corpus[split as "knowledge"].map(q => [q.id, split] as const)));
    let cursor = 0;
    await Promise.all(Array.from({ length: options.concurrency }, async () => {
        while (cursor < jobs.length) {
            const job = jobs[cursor++]!, passage = corpus.passages.find(p => p.id === job.passageId)!;
            const task = englishTask(passage, job.questions), events: { name: string; fields: Record<string, any> }[] = [];
            const model = options.modelFactory?.() ?? new GlmModel(config, config.english.thinking), started = performance.now();
            let answer = "", error: string | undefined;
            try {
                const result = await new EnglishHarness(model, task, job.variant, config.context, { info() {}, error() {} }, options.contextTokens, config.harness, options.workflow ?? "grounded")
                    .run({ history: [], question: "", tools: [], metadata: { passageId: job.passageId, variant: job.variant }, onEvent(name, fields = {}) { events.push({ name, fields }); } }, AbortSignal.timeout(120000));
                answer = result.content;
            } catch (failure) { error = failure instanceof Error ? failure.name : "Error"; }
            const measured = events.map(e => e.name === "agent.subagent.event" ? { name: e.fields.event as string, fields: e.fields } : e);
            const completed = measured.filter(e => e.name === "agent.model.completed");
            const row = { passageId: job.passageId, variant: job.variant, durationMs: performance.now() - started,
                modelCalls: completed.length, modelAttempts: measured.filter(e => e.name === "agent.model.started").length, toolCalls: measured.filter(e => e.name === "agent.tool.started").length,
                inputTokens: completed.reduce((sum, e) => sum + (e.fields.usage?.inputTokens ?? 0), 0), outputTokens: completed.reduce((sum, e) => sum + (e.fields.usage?.outputTokens ?? 0), 0),
                answers: job.questions.map(q => { let actual: string | null = null; try { actual = englishChoice(answer, q.number) ?? null; } catch { /* No visible conclusion is incorrect, never dropped. */ }
                    return { id: q.id, number: q.number, kind: q.kind, split: splitById.get(q.id)!, category: q.category, expected: q.answer, actual, passed: !error && actual === q.answer }; }), ...(error ? { error } : {}) };
            results.push(row);
            const file = join(out, "jobs", `${job.passageId}-${job.variant}.json`);
            await writeFile(`${file}.tmp`, JSON.stringify({ ...row, answer, events: events.filter(e => e.name.startsWith("english.") || ["agent.protocol_repair", "agent.model.failed", "agent.retry", "agent.failed"].includes(e.name)) }, null, 2));
            await rename(`${file}.tmp`, file);
            console.log(JSON.stringify({ progress: `${results.length}/${jobs.length}`, variant: job.variant, questions: row.answers.length, correct: row.answers.filter(a => a.passed).length, error, seconds: (row.durationMs / 1000).toFixed(1) }));
        }
    }));
    const rows = summarizeEnglishJobs(results, options.variants);
    const report = { manifest, rows };
    await writeFile(join(out, "comparison.json"), JSON.stringify(report, null, 2));
    await writeFile(join(out, "comparison.md"), `# 初三英语选择题实验\n\n模型：${manifest.model}；流程：${manifest.workflow}；独立复核：未配置。按文章调度、逐题判分；grounded完整原文阅读逐题隔离，父子模型用量全部计入。\n\n|策略|题目|正确|失败请求|请求p50秒|请求p95秒|模型调用|输入token|\n|---|---:|---:|---:|---:|---:|---:|---:|\n` +
        rows.map(r => `|${r.variant}|${r.questions}|${r.accuracy?.successes}/${r.accuracy?.total}|${r.failures}|${(r.jobLatencyMs.p50 / 1000).toFixed(2)}|${(r.jobLatencyMs.p95 / 1000).toFixed(2)}|${r.modelCalls}|${r.inputTokens}|`).join("\n") + "\n\n" + manifest.limitations.join("\n\n"));
    return report;
}
