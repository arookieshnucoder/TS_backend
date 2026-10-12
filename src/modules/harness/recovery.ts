import type { AgentModel } from "../agent/model.js";
import type { AgentMessage, ToolDefinition } from "../agent/contracts.js";
import { abortable } from "./cancellation.js";

export interface RecoveryPolicy {
    modelRetries: number;
    toolRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    modelAttemptTimeoutMs: number;
}
export interface NamedAgentModel { name: string; model: AgentModel; }
export const DEFAULT_RECOVERY: RecoveryPolicy = {
    modelRetries: 2, toolRetries: 1, baseDelayMs: 250, maxDelayMs: 3000, modelAttemptTimeoutMs: 30000,
};
export function recoveryPolicy(value: Partial<RecoveryPolicy> = {}): RecoveryPolicy {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !Object.hasOwn(DEFAULT_RECOVERY, k))) throw new TypeError("Invalid recovery policy");
    const policy = { ...DEFAULT_RECOVERY, ...value };
    for (const [key, max] of [["modelRetries", 5], ["toolRetries", 3], ["baseDelayMs", 30000], ["maxDelayMs", 60000], ["modelAttemptTimeoutMs", 600000]] as const) {
        if (!Number.isInteger(policy[key]) || policy[key] < (key === "modelAttemptTimeoutMs" ? 1 : 0) || policy[key] > max) throw new TypeError(`Invalid recovery ${key}`);
    }
    if (policy.maxDelayMs < policy.baseDelayMs) throw new TypeError("Recovery maxDelayMs must be >= baseDelayMs");
    return policy;
}
export function failureCode(error: unknown, seen = new Set<object>()): string {
    if (!error || typeof error !== "object") return "UNKNOWN";
    if (seen.has(error) || seen.size >= 8) return "UNKNOWN";
    seen.add(error);
    const value = error as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown; cause?: unknown };
    const status = value.status ?? value.statusCode ?? (typeof value.code === "number" ? value.code : undefined);
    if (value.code === -32000) return "CONNECTION_ERROR"; // MCP ConnectionClosed
    if (value.code === -32001) return "TIMEOUT"; // MCP RequestTimeout
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) return `HTTP_${status}`;
    if (typeof value.code === "string" && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH)$/.test(value.code)) return value.code;
    if (value.name === "TimeoutError" || value.name === "APIConnectionTimeoutError") return "TIMEOUT";
    if (value.name === "APIConnectionError") return "CONNECTION_ERROR";
    return value.cause ? failureCode(value.cause, seen) : "UNKNOWN";
}
export const retryable = (error: unknown): boolean => /^(HTTP_(408|425|429|500|502|503|504)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|TIMEOUT|CONNECTION_ERROR)$/.test(failureCode(error));
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout>;
    try { await abortable(() => new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal); }
    finally { clearTimeout(timer!); }
}
type Event = (name: string, fields: Record<string, unknown>) => void;
export async function retry<T>(operation: (attempt: number) => Promise<T>, retries: number, policy: RecoveryPolicy,
    signal?: AbortSignal, event: Event = () => {}, fields: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        signal?.throwIfAborted();
        try { return await operation(attempt); }
        catch (error) {
            signal?.throwIfAborted();
            if (attempt > retries || !retryable(error)) throw error;
            const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
            event("agent.retry", { ...fields, attempt, nextAttempt: attempt + 1, delayMs, code: failureCode(error) });
            await delay(delayMs, signal);
        }
    }
}

/** Scoped to one run: a successful fallback remains selected for subsequent turns. */
export class RecoveringModel implements AgentModel {
    private active = 0;
    private sequence = 0;
    private readonly models: NamedAgentModel[];
    constructor(primary: AgentModel, fallbacks: NamedAgentModel[], private readonly policy: RecoveryPolicy, private readonly event: Event) {
        // AgentHarness resolves and validates this chain before starting a run.
        this.models = [{ name: "primary", model: primary }, ...fallbacks];
    }
    async turn(messages: AgentMessage[], tools: ToolDefinition[], signal?: AbortSignal, maxOutputTokens?: number) {
        const modelCallId = `model-${++this.sequence}`;
        for (;;) {
            signal?.throwIfAborted();
            const selected = this.models[this.active]!;
            try {
                return await retry(async attempt => {
                    const timeout = AbortSignal.timeout(this.policy.modelAttemptTimeoutMs);
                    const scope = signal ? AbortSignal.any([signal, timeout]) : timeout;
                    const started = Date.now();
                    this.event("agent.model.started", { modelCallId, model: selected.name, attempt, tools: tools.length, messageCount: messages.length });
                    try {
                        const result = await abortable(() => selected.model.turn(structuredClone(messages), structuredClone(tools), scope, maxOutputTokens), scope);
                        scope.throwIfAborted();
                        this.event("agent.model.completed", { modelCallId, model: selected.name, attempt, durationMs: Date.now() - started, toolCalls: result.toolCalls.length,
                            ...(result.usage ? { usage: result.usage } : {}),
                            calls: result.toolCalls.map(call => ({ id: call.id, name: call.name, arguments: call.arguments })) });
                        return result;
                    } catch (error) {
                        this.event("agent.model.failed", { modelCallId, model: selected.name, attempt, durationMs: Date.now() - started, code: failureCode(error), cancelled: signal?.aborted ?? false });
                        throw error;
                    }
                }, this.policy.modelRetries, this.policy, signal, this.event, { operation: "model", modelCallId, model: selected.name });
            } catch (error) {
                signal?.throwIfAborted();
                if (!retryable(error) || this.active + 1 >= this.models.length) throw error;
                this.active++;
                this.event("agent.fallback", { modelCallId, from: selected.name, to: this.models[this.active]!.name, code: failureCode(error) });
            }
        }
    }
}
