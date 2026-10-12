import type { AgentMessage, ToolCall } from "../agent/contracts.js";

export type EvalMode = "offline" | "live";
export type EvalProfile = "standard" | "no-recovery";
export type EvalVariant = "normal" | "omit-tools" | "wrong-answer";
export type Outcome = "success" | "failure" | "cancelled" | "timed_out" | "environment_error";
export interface ScriptTurn { content?: string; calls?: ToolCall[]; status?: number; waitMs?: number; hang?: boolean; }
export interface ToolFixture {
    name: string; description: string; inputs?: Record<string, "string" | "integer">; output?: string;
    operation?: "sum"; failFirst?: number; status?: number; readonly?: boolean; idempotent?: boolean;
}
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
export interface EvalDataset { version: 1; id: string; description: string; cases: EvalCase[]; }
export interface EvalEvent { name: string; elapsedMs: number; fields: Record<string, unknown>; }
export interface Grade {
    passed: boolean; failures: string[];
    factCoverage: number | null; evidenceCoverage: number | null; citationCoverage: number | null; toolPrecision: number | null; toolRecall: number | null;
    argumentValidity: number | null; forbiddenMatches: number; policyCompliant: boolean;
}
export interface Trial {
    caseId: string; category: string; kind: EvalCase["kind"]; repeat: number; seed: number;
    outcome: Outcome; errorCode?: string; answer: string; grade: Grade; events: EvalEvent[];
    metrics: { durationMs: number; setupMs: number; agentMs: number; modelAttempts: number; modelTurns: number;
        toolCalls: number; toolAttempts: number; retries: number; fallbacks: number; compressions: number;
        estimatedInputTokens: number; reportedInputTokens: number | null; reportedOutputTokens: number | null;
        usageCoverage: number | null; costUsd: number | null; };
}
export interface Rate { value: number; successes: number; total: number; wilson95: [number, number]; }
export interface CaseSummary { id: string; category: string; kind: EvalCase["kind"]; passRate: Rate; allTrialsPassed: boolean;
    passAtK: Record<string, number>; passPowerK: Record<string, number>; failures: Record<string, number>; }
export interface EvalReport {
    version: 1; runId: string; startedAt: string; finishedAt: string;
    provenance: { mode: EvalMode; profile: EvalProfile; variant: EvalVariant; repeats: number; seed: number; datasetId: string;
        datasetHash: string; graderHash: string; systemHash: string; revision: string; dirty: boolean; model: string;
        timeoutMs: number; providerFingerprint: string; runtimeSettings: Record<string, number>; nodeVersion: string; platform: string;
        fallbackModel: string | null; fallbackProviderFingerprint: string | null;
        inputUsdPerMillion: number | null; outputUsdPerMillion: number | null; };
    scopeNote: string; summary: { passRate: Rate; taskPassRate: Rate | null; controlPassRate: Rate | null;
        dimensions: Record<string, { value: number | null; applicableTrials: number }>;
        latencyMs: { p50: number; p95: number; max: number }; averages: Record<string, number | null>;
        failureCounts: Record<string, number>; recommendations: string[]; };
    cases: CaseSummary[]; trials: Trial[];
    comparison?: { baselineRunId: string; passRateDelta: number; p95DeltaMs: number; dimensionDeltas: Record<string, number | null>; regressions: string[]; improvements: string[] };
    gate: { passed: boolean; reasons: string[] };
}
