import { randomUUID } from "node:crypto";
import type { AgentInstructions, AgentResult, AgentTask, AgentTaskResult, AgentWorkflow } from "../agent/contracts.js";
import type { AgentModel } from "../agent/model.js";
import type { ContextConfig } from "./context/config.js";
import type { RegisteredTool } from "./tool-contracts.js";
import { abortable } from "./cancellation.js";
import { failureCode } from "./recovery.js";

export interface SubAgentDefinition {
    name: string;
    description: string;
    model: AgentModel;
    workflow: AgentWorkflow;
    instructions: AgentInstructions;
    tools?: RegisteredTool[];
    context?: ContextConfig;
    /** Child agents cannot delegate unless the host grants named capabilities here. */
    delegates?: string[];
}
export interface DelegationLimits { maxCalls: number; maxDepth: number; maxConcurrent: number; timeoutMs: number; maxOutputCharacters: number; }
export const DEFAULT_DELEGATION_LIMITS: DelegationLimits = {
    maxCalls: 8, maxDepth: 2, maxConcurrent: 2, timeoutMs: 120000, maxOutputCharacters: 16000,
};
export interface SubAgentScope { depth: number; taskId?: string; allowed: readonly string[]; usage?: { modelTurns: number; toolCalls: number }; }
type Event = (name: string, fields?: Record<string, unknown>) => void;

export class DelegationError extends Error {
    constructor(readonly code: string, readonly usage?: { modelTurns: number; toolCalls: number }) { super(code); this.name = "DelegationError"; }
}

/** Shared across one root run, including descendants. No state leaks between requests. */
export class SubAgentSession {
    readonly definitions: ReadonlyMap<string, SubAgentDefinition>;
    readonly limits: DelegationLimits;
    private calls = 0;
    private active = 0;
    constructor(definitions: readonly SubAgentDefinition[] = [], limits: Partial<DelegationLimits> = {}) {
        if (Object.keys(limits).some(key => !Object.hasOwn(DEFAULT_DELEGATION_LIMITS, key))) throw new TypeError("Invalid delegation limits");
        this.limits = { ...DEFAULT_DELEGATION_LIMITS, ...limits };
        for (const [key, max] of [["maxCalls", 32], ["maxDepth", 4], ["maxConcurrent", 8], ["timeoutMs", 600000], ["maxOutputCharacters", 100000]] as const) {
            if (!Number.isInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > max) throw new TypeError(`Invalid delegation ${key}`);
        }
        const entries = new Map<string, SubAgentDefinition>();
        for (const definition of definitions) {
            if (!/^[a-z][a-z0-9_-]{0,63}$/.test(definition.name) || entries.has(definition.name) ||
                !definition.description?.trim() || typeof definition.model?.turn !== "function" || typeof definition.workflow?.run !== "function" ||
                typeof definition.instructions?.system !== "string" || typeof definition.instructions?.final !== "string") throw new TypeError("Invalid sub-agent definition");
            entries.set(definition.name, { ...definition, tools: [...(definition.tools ?? [])], delegates: [...(definition.delegates ?? [])] });
        }
        for (const definition of entries.values()) if (definition.delegates!.some(name => !entries.has(name))) throw new TypeError("Unknown child delegation capability");
        this.definitions = entries;
    }
    async run(task: AgentTask, parent: SubAgentScope, signal: AbortSignal | undefined, event: Event,
        execute: (definition: SubAgentDefinition, task: AgentTask, scope: SubAgentScope, signal: AbortSignal) => Promise<AgentResult>): Promise<AgentTaskResult> {
        signal?.throwIfAborted();
        const definition = this.definitions.get(task?.agent);
        if (!definition || !parent.allowed.includes(task.agent)) throw new DelegationError("SUBAGENT_NOT_ALLOWED");
        if (typeof task.input !== "string" || !task.input.trim() || task.input.length > 200000 ||
            task.context !== undefined && (!Array.isArray(task.context) || task.context.length > 100 || task.context.some(message =>
                !message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || message.content.length > 200000 || message.toolCalls || message.toolCallId))) throw new DelegationError("SUBAGENT_INVALID_INPUT");
        if (parent.depth >= this.limits.maxDepth) throw new DelegationError("SUBAGENT_DEPTH_LIMIT");
        if (this.calls >= this.limits.maxCalls) throw new DelegationError("SUBAGENT_CALL_LIMIT");
        if (this.active >= this.limits.maxConcurrent) throw new DelegationError("SUBAGENT_CONCURRENCY_LIMIT");
        this.calls++; this.active++;
        const taskId = randomUUID(), started = Date.now();
        const fields = { taskId, parentTaskId: parent.taskId ?? null, agent: definition.name, depth: parent.depth + 1 };
        const scope: SubAgentScope = { depth: parent.depth + 1, taskId, allowed: definition.delegates ?? [] };
        const deadline = AbortSignal.timeout(this.limits.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        event("agent.subagent.started", fields);
        try {
            const result = await abortable(() => execute(definition, structuredClone(task), scope, combined), combined);
            combined.throwIfAborted();
            if (typeof result?.content !== "string" || !result.content.trim() || result.content.length > this.limits.maxOutputCharacters) throw new DelegationError("SUBAGENT_INVALID_OUTPUT");
            event("agent.subagent.completed", { ...fields, durationMs: Date.now() - started, modelTurns: result.modelTurns, toolCalls: result.toolCalls });
            return { ...result, taskId, agent: definition.name };
        } catch (error) {
            event("agent.subagent.failed", { ...fields, durationMs: Date.now() - started, code: error instanceof DelegationError ? error.code : failureCode(error), cancelled: signal?.aborted ?? false });
            signal?.throwIfAborted();
            throw new DelegationError(deadline.aborted ? "SUBAGENT_TIMEOUT" : error instanceof DelegationError ? error.code : "SUBAGENT_FAILED", scope.usage);
        } finally { this.active--; }
    }
}
