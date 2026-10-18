import type { AgentMessage, ToolCall } from "../agent/contracts.js";

export type EvalMode = "offline" | "live";
export type EvalProfile = "standard" | "no-recovery";
export type EvalVariant = "normal" | "omit-tools" | "wrong-answer";
export type Outcome = "success" | "failure" | "cancelled" | "timed_out" | "environment_error";
/** 离线评测中的一次模拟模型返回，可注入错误、延迟或不响应。 */
export interface ScriptTurn { content?: string; calls?: ToolCall[]; status?: number; waitMs?: number; hang?: boolean; }
/** 评测工具的声明和模拟行为，用于检查工具选择、重试和执行次数。 */
export interface ToolFixture {
    name: string; description: string; inputs?: Record<string, "string" | "integer">; output?: string;
    operation?: "sum"; failFirst?: number; status?: number; readonly?: boolean; idempotent?: boolean;
}
/** 一个评测场景，包含问题、模拟过程、运行限制和预期结果。 */
export interface EvalCase {
    id: string; category: string; kind: "task" | "control"; modes: EvalMode[]; question: string;
    environment?: "workspace" | "memory" | "mcp"; history?: AgentMessage[]; historyPadding?: number;
    tools?: ToolFixture[]; script: ScriptTurn[]; repeatLast?: boolean; backupScript?: ScriptTurn[];
    summary?: string; assertPromptIncludes?: string[]; cancelAfterMs?: number; timeoutMs?: number;
    attemptTimeoutMs?: number; maxToolSteps?: number;
    expect: {
        outcome: Outcome; errorCode?: string; facts?: string[]; evidenceFacts?: string[]; citations?: string[]; forbidden?: string[];
        requiredTools?: string[]; allowedTools?: string[]; maxToolCalls?: number;
        toolErrors?: string[]; minRetries?: number; minFallbacks?: number; minCompressions?: number;
        maxModelAttempts?: number; maxRetries?: number; maxFallbacks?: number;
        toolExecutions?: Record<string, number>;
    };
}
/** 带版本和说明的评测用例集合，供离线与真实模型评测共用。 */
export interface EvalDataset { version: 1; id: string; description: string; cases: EvalCase[]; }
/** 评测记录的运行事件，保存相对耗时与结构化字段。 */
export interface EvalEvent { name: string; elapsedMs: number; fields: Record<string, unknown>; }
/** 单次评测评分，记录事实、证据、引用和工具策略等检查结果。 */
export interface Grade {
    passed: boolean; failures: string[];
    factCoverage: number | null; evidenceCoverage: number | null; citationCoverage: number | null; toolPrecision: number | null; toolRecall: number | null;
    argumentValidity: number | null; forbiddenMatches: number; policyCompliant: boolean;
}
/** 一个用例的一次运行结果，包含答案、评分、事件与成本统计。 */
export interface Trial {
    caseId: string; category: string; kind: EvalCase["kind"]; repeat: number; seed: number;
    outcome: Outcome; errorCode?: string; answer: string; grade: Grade; events: EvalEvent[];
    metrics: { durationMs: number; setupMs: number; agentMs: number; modelAttempts: number; modelTurns: number;
        toolCalls: number; toolAttempts: number; retries: number; fallbacks: number; compressions: number;
        estimatedInputTokens: number; reportedInputTokens: number | null; reportedOutputTokens: number | null;
        usageCoverage: number | null; costUsd: number | null; };
}
/** 通过率及其成功数、总数和 Wilson 置信区间。 */
export interface Rate { value: number; successes: number; total: number; wilson95: [number, number]; }
/** 同一用例多次运行的汇总，记录稳定性和失败原因分布。 */
export interface CaseSummary { id: string; category: string; kind: EvalCase["kind"]; passRate: Rate; allTrialsPassed: boolean;
    passAtK: Record<string, number>; passPowerK: Record<string, number>; failures: Record<string, number>; }
/** 完整评测报告，包含运行配置、来源指纹、汇总指标和发布检查结果。 */
export interface EvalReport {
    version: 1; runId: string; startedAt: string; finishedAt: string;
    provenance: { mode: EvalMode; profile: EvalProfile; variant: EvalVariant; repeats: number; seed: number; datasetId: string;
        datasetHash: string; graderHash: string; systemHash: string; revision: string; dirty: boolean; model: string;
        timeoutMs: number; providerFingerprint: string; runtimeSettings: Record<string, number>; nodeVersion: string; platform: string;
        fallbackModel: string | null; fallbackProviderFingerprint: string | null;
        inputUsdPerMillion: number | null; outputUsdPerMillion: number | null; };
    scopeNote: string; summary: { passRate: Rate; taskPassRate: Rate | null; controlPassRate: Rate | null;
        dimensions: Record<string, { value: number | null; applicableTrials: number }>;
        latencyMs: { p50: number; p95: number; p99?: number; max: number }; averages: Record<string, number | null>;
        failureCounts: Record<string, number>; recommendations: string[]; };
    cases: CaseSummary[]; trials: Trial[];
    comparison?: { baselineRunId: string; passRateDelta: number; p95DeltaMs: number; p99DeltaMs?: number; dimensionDeltas: Record<string, number | null>; regressions: string[]; improvements: string[] };
    gate: { passed: boolean; reasons: string[] };
}
