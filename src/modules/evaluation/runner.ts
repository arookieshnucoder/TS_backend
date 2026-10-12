import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { AgentModel, LlmConfig } from "../agent/model.js";
import { AskAgent } from "../agent/ask-agent.js";
import { ASK_INSTRUCTIONS, FINAL_INSTRUCTIONS } from "../agent/prompt.js";
import { AgentHarness } from "../harness/agent-harness.js";
import { HarnessPolicyError } from "../harness/runtime.js";
import { failureCode, delay } from "../harness/recovery.js";
import { loadConfig, type AppConfig } from "../../config/env.js";
import { LangChainChatModel } from "../../infrastructure/llm/langchain-chat-model.js";
import { redact, environmentSecrets } from "../../common/logging/redaction.js";
import { createEnvironment } from "./environment.js";
import { grade } from "./graders.js";
import { summarize, compare, assertComparable } from "./statistics.js";
import type { EvalCase, EvalDataset, EvalEvent, EvalMode, EvalProfile, EvalVariant, EvalReport, ScriptTurn, Trial, Outcome } from "./contracts.js";

export interface EvaluationOptions {
    mode: EvalMode; profile: EvalProfile; variant: EvalVariant; repeats: number; seed: number; directory: string;
    timeoutMs: number; minPassRate: number; maxRegression: number; config?: AppConfig; baseline?: EvalReport;
    inputUsdPerMillion?: number; outputUsdPerMillion?: number;
    modelFactory?: () => AgentModel; progress?(completed: number, total: number, trial: Trial): void;
}
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export async function sourceHash(directory: string): Promise<string> {
    const files: string[] = [];
    async function walk(root: string) { for (const entry of await readdir(root, { withFileTypes: true })) {
        const file = join(root, entry.name); if (entry.isDirectory()) await walk(file); else if (entry.name.endsWith(".ts")) files.push(file);
    } }
    await walk(directory); files.sort();
    return digest((await Promise.all(files.map(async file => `${file.slice(directory.length).replace(/\\/g, "/")}\0${(await readFile(file, "utf8")).replace(/\r\n/g, "\n")}`))).join("\0"));
}
function scripted(c: EvalCase, script: ScriptTurn[], aliases: Record<string, string>, options: EvaluationOptions): AgentModel {
    let index = 0;
    return { async turn(messages, _tools, signal) {
        const text = messages.map(m => m.content).join("\n");
        if (messages[0]?.content.startsWith("Summarize the following")) return { content: /NEEDLE-772/.test(text) ? "Project code NEEDLE-772." : c.summary ?? "Other conversation details.", toolCalls: [] };
        for (const pattern of c.assertPromptIncludes ?? []) if (!new RegExp(pattern, "iu").test(text)) throw new Error("Evaluation prompt invariant failed");
        const item = script[index] ?? (c.repeatLast ? script.at(-1) : undefined); index++;
        if (!item) throw new Error("Evaluation script exhausted");
        if (item.hang) return new Promise(() => {});
        if (item.waitMs) await delay(item.waitMs, signal);
        if (item.status) throw Object.assign(new Error("Injected model fault"), { status: item.status });
        const calls = (item.calls ?? []).map(call => ({ ...structuredClone(call), id: call.id.replace(/\{turn\}/g, String(index)), name: aliases[call.name] ?? call.name }));
        if (options.variant === "omit-tools" && calls.length) return { content: "No evidence was consulted.", toolCalls: [] };
        return { content: options.variant === "wrong-answer" && !calls.length ? "UNSUPPORTED_VALUE_999" : item.content ?? "", toolCalls: calls };
    } };
}
async function trial(c: EvalCase, repeat: number, seed: number, options: EvaluationOptions, config: AppConfig): Promise<Trial> {
    const started = performance.now(), events: EvalEvent[] = [], abort = new AbortController();
    const event = (name: string, fields: Record<string, unknown> = {}) => events.push({ name, elapsedMs: performance.now() - started, fields: structuredClone(fields) });
    const context = { ...config.context, ...(c.historyPadding ? { maxInputTokens: 4096 } : {}), maxToolSteps: c.maxToolSteps ?? config.context.maxToolSteps };
    const aliases: Record<string, string> = {};
    const provider: LlmConfig = { llmApiKey: config.llmApiKey, llmModel: config.llmModel, llmBaseUrl: config.llmBaseUrl, llmTimeoutMs: config.llmTimeoutMs };
    const model = options.mode === "live" ? options.modelFactory?.() ?? new LangChainChatModel(provider) : scripted(c, c.script, aliases, options);
    let environment: Awaited<ReturnType<typeof createEnvironment>> | undefined, answer = "", errorCode: string | undefined;
    let outcome: Outcome = "environment_error", setupMs = 0, agentMs = 0;
    let deadline: ReturnType<typeof setTimeout> | undefined, cancel: ReturnType<typeof setTimeout> | undefined;
    try {
        environment = await createEnvironment(c, options.directory, context, model, event);
        Object.assign(aliases, environment.aliases);
        setupMs = performance.now() - started;
        deadline = setTimeout(() => abort.abort(new DOMException("Evaluation deadline", "TimeoutError")), c.timeoutMs ?? options.timeoutMs);
        if (c.cancelAfterMs) cancel = setTimeout(() => abort.abort(new DOMException("Evaluation cancellation", "AbortError")), c.cancelAfterMs);
        const noRecovery = options.profile === "no-recovery";
        const harness = new AgentHarness(model, new AskAgent(), { system: ASK_INSTRUCTIONS, final: FINAL_INSTRUCTIONS }, context, { info() {}, error() {} }, {
            ...config.harness, recovery: { ...config.harness.recovery, ...(options.mode === "offline" ? { baseDelayMs: 5, maxDelayMs: 20 } : {}),
                modelRetries: noRecovery ? 0 : config.harness.recovery.modelRetries, toolRetries: noRecovery ? 0 : config.harness.recovery.toolRetries,
                modelAttemptTimeoutMs: c.attemptTimeoutMs ?? config.harness.recovery.modelAttemptTimeoutMs },
            fallbackModels: noRecovery ? [] : options.mode === "live" && !options.modelFactory && config.llmFallback ? [{ name: config.llmFallback.model,
                model: new LangChainChatModel({ ...provider, llmModel: config.llmFallback.model, llmBaseUrl: config.llmFallback.baseUrl, llmApiKey: config.llmFallback.apiKey }) }] :
                c.backupScript ? [{ name: "explicit-eval-backup", model: scripted(c, c.backupScript, aliases, options) }] : [],
        });
        const history = structuredClone(c.history ?? []);
        if (c.historyPadding) history.unshift({ role: "user", content: "Old irrelevant conversation. ".repeat(c.historyPadding) });
        const agentStarted = performance.now();
        try {
            const result = await harness.run({ history, question: c.question, tools: environment.tools, metadata: { caseId: c.id, repeat, seed }, onEvent: event }, abort.signal);
            answer = result.content; outcome = "success";
        } catch (error) {
            outcome = abort.signal.aborted ? (abort.signal.reason?.name === "TimeoutError" ? "timed_out" : "cancelled") : "failure";
            errorCode = error instanceof HarnessPolicyError ? error.code : failureCode(error);
        }
        agentMs = performance.now() - agentStarted;
    } catch { errorCode = "EVALUATION_ENVIRONMENT_FAILED"; }
    finally { clearTimeout(deadline); clearTimeout(cancel); }
    const durationMs = performance.now() - started;
    const resultGrade = grade(c, outcome, answer, events, environment?.executions ?? {}, errorCode);
    const count = (name: string) => events.filter(e => e.name === name).length;
    const completed = events.filter(e => e.name === "agent.model.completed");
    const usage = completed.map(e => e.fields.usage as { inputTokens: number; outputTokens: number } | undefined).filter((u): u is { inputTokens: number; outputTokens: number } => !!u && Number.isSafeInteger(u.inputTokens) && Number.isSafeInteger(u.outputTokens));
    const fullyMeasured = completed.length > 0 && usage.length === completed.length;
    const input = fullyMeasured ? usage.reduce((n, u) => n + u.inputTokens, 0) : null, output = fullyMeasured ? usage.reduce((n, u) => n + u.outputTokens, 0) : null;
    const costUsd = input !== null && output !== null && options.inputUsdPerMillion !== undefined && options.outputUsdPerMillion !== undefined ? (input * options.inputUsdPerMillion + output * options.outputUsdPerMillion) / 1000000 : null;
    const secrets = [...environmentSecrets(), config.llmApiKey, config.llmFallback?.apiKey, "EVAL_CANARY_SECRET"].filter((s): s is string => !!s);
    const result: Trial = { caseId: c.id, category: c.category, kind: c.kind, repeat, seed, outcome, errorCode, answer: redact(answer, secrets) as string, grade: resultGrade,
        events: events.map(e => ({ ...e, fields: redact(e.fields, secrets) as Record<string, unknown> })), metrics: {
            durationMs, setupMs, agentMs, modelAttempts: count("agent.model.started"), modelTurns: new Set(events.filter(e => e.name === "agent.model.started").map(e => e.fields.modelCallId)).size,
            toolCalls: count("agent.tool.started"), toolAttempts: events.filter(e => e.name === "agent.tool").reduce((n, e) => n + Number(e.fields.attempts ?? 0), 0),
            retries: count("agent.retry"), fallbacks: count("agent.fallback"), compressions: count("context.compressed"),
            estimatedInputTokens: events.filter(e => e.name === "agent.context").reduce((n, e) => n + Number(e.fields.inputTokens), 0),
            reportedInputTokens: input, reportedOutputTokens: output, usageCoverage: completed.length ? usage.length / completed.length : null, costUsd,
        } };
    await environment?.close();
    return result;
}
export async function evaluate(dataset: EvalDataset, options: EvaluationOptions, hashes: { datasetHash: string; graderHash: string; systemHash: string }): Promise<EvalReport> {
    if (!Number.isInteger(options.repeats) || options.repeats < 1 || options.repeats > 100 || !Number.isInteger(options.seed) || !Number.isFinite(options.timeoutMs) || options.timeoutMs < 5 ||
        !["offline", "live"].includes(options.mode) || !["standard", "no-recovery"].includes(options.profile) || !["normal", "omit-tools", "wrong-answer"].includes(options.variant) ||
        ![options.minPassRate, options.maxRegression].every(v => Number.isFinite(v) && v >= 0 && v <= 1) ||
        (options.inputUsdPerMillion === undefined) !== (options.outputUsdPerMillion === undefined) ||
        [options.inputUsdPerMillion, options.outputUsdPerMillion].some(v => v !== undefined && (!Number.isFinite(v) || v < 0))) throw new Error("Invalid evaluation options");
    if (options.mode === "live" && options.variant !== "normal") throw new Error("Synthetic variants are offline only");
    const config = options.config ?? loadConfig();
    if (options.mode === "live" && !config.llmApiKey && !options.modelFactory) throw new Error("Live evaluation requires LLM_API_KEY; no offline fallback is performed.");
    const cases = dataset.cases.filter(c => c.modes.includes(options.mode));
    if (!cases.length) throw new Error("Dataset has no cases for this mode");
    if (options.mode === "live" && cases.some(c => c.backupScript)) throw new Error("Live evaluation cannot use a scripted backup model");
    let revision = "unknown", dirty = true;
    try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(); dirty = !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim(); } catch { /* Explicit unknown provenance, never invented revision. */ }
    const provenance: EvalReport["provenance"] = {
        mode: options.mode, profile: options.profile, variant: options.variant, repeats: options.repeats, seed: options.seed, datasetId: dataset.id, ...hashes, revision, dirty,
        model: options.mode === "live" ? config.llmModel : "scripted-control-v1", timeoutMs: options.timeoutMs,
        providerFingerprint: options.mode === "live" ? digest(config.llmBaseUrl ?? "default") : "not-applicable",
        fallbackModel: options.mode === "live" && config.llmFallback ? config.llmFallback.model : null,
        fallbackProviderFingerprint: options.mode === "live" && config.llmFallback ? digest(config.llmFallback.baseUrl ?? "default") : null,
        nodeVersion: process.version, platform: process.platform,
        runtimeSettings: { maxInputTokens: config.context.maxInputTokens, compressionTrigger: config.context.compressionTrigger, tokenSafetyFactor: config.context.tokenSafetyFactor,
            minPassRate: options.minPassRate, maxRegression: options.maxRegression,
            maxToolSteps: config.context.maxToolSteps, maxCallsPerStep: config.harness.maxCallsPerStep, toolTimeoutMs: config.harness.toolTimeoutMs, toolOutputTokens: config.harness.toolOutputTokens,
            modelRetries: options.profile === "no-recovery" ? 0 : config.harness.recovery.modelRetries, toolRetries: options.profile === "no-recovery" ? 0 : config.harness.recovery.toolRetries,
            baseDelayMs: options.mode === "offline" ? 5 : config.harness.recovery.baseDelayMs, maxDelayMs: options.mode === "offline" ? 20 : config.harness.recovery.maxDelayMs,
            modelAttemptTimeoutMs: config.harness.recovery.modelAttemptTimeoutMs },
        inputUsdPerMillion: options.inputUsdPerMillion ?? null, outputUsdPerMillion: options.outputUsdPerMillion ?? null,
    };
    if (options.baseline) assertComparable({ provenance, cases }, options.baseline);
    const startedAt = new Date().toISOString(), trials: Trial[] = [];
    const jobs = Array.from({ length: options.repeats }, (_, repeat) => cases.map(c => ({ c, repeat: repeat + 1 }))).flat();
    let random = options.seed >>> 0;
    for (let i = jobs.length - 1; i > 0; i--) { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; const j = random % (i + 1); [jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!]; }
    for (const { c, repeat } of jobs) {
        const result = await trial(c, repeat, (options.seed + repeat) >>> 0, options, config); trials.push(result); options.progress?.(trials.length, jobs.length, result);
    }
    const report: EvalReport = { version: 1, runId: randomUUID(), startedAt, finishedAt: new Date().toISOString(), provenance,
        scopeNote: options.mode === "offline" ? "Scripted control evaluation of the actual AskAgent and harness. Scores do not establish LLM capability; Wilson intervals are descriptive for these controlled repeats. Latency is local fixture latency." :
        "Live model on isolated project fixtures. Pattern graders cover annotated facts and citations, not unrestricted semantic correctness. Repeats do not set or guarantee a provider seed; token cost excludes unreported failed requests.",
        ...summarize(trials), trials, gate: { passed: true, reasons: [] } };
    if (options.baseline) report.comparison = compare(report, options.baseline);
    if (report.summary.passRate.value < options.minPassRate) report.gate.reasons.push("pass_rate_below_threshold");
    if (report.comparison && report.comparison.passRateDelta < -options.maxRegression) report.gate.reasons.push("pass_rate_regression");
    if (trials.some(t => t.outcome === "environment_error")) report.gate.reasons.push("evaluation_environment_failed");
    if (trials.some(t => ["safety", "protocol", "limits"].includes(t.category) && !t.grade.passed)) report.gate.reasons.push("critical_contract_failed");
    report.gate.passed = !report.gate.reasons.length;
    return report;
}
