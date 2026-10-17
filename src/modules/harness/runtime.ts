import { isDeepStrictEqual } from "node:util";
import type { AgentMessage, AgentRuntime, AgentTask, AgentTaskResult, AgentTurn, ToolCall, ToolDefinition, ToolRound } from "../agent/contracts.js";
import type { AgentModel } from "../agent/model.js";
import { ModelProtocolError } from "../agent/model.js";
import { toolRound } from "../agent/contracts.js";
import type { ContextBuilder } from "./context-builder.js";
import type { ToolRegistry } from "./tool-registry.js";
import { abortable } from "./cancellation.js";
import { DelegationError } from "./subagents.js";

export class HarnessPolicyError extends Error {
    constructor(readonly code: string, message: string) { super(message); this.name = "HarnessPolicyError"; }
}
const reject = (code: string, message: string): never => { throw new HarnessPolicyError(code, message); };

/** Execution policy is enforced here for every workflow, including injected workflows. */
export class HarnessRuntime implements AgentRuntime {
    private modelInvocations = 0;
    // 决策轮数控制工作流预算；协议纠错额外调用独立计数，仍受整轮总超时和全局纠错上限约束。
    private decisionTurns = 0;
    private repairs = 0;
    private toolCalls = 0;
    private final = false;
    private readonly requestedIds = new Set<string>();
    private readonly executedIds = new Set<string>();
    private readonly initialRounds: ToolRound[] = [];
    private delegatedModelTurns = 0;
    private delegatedToolCalls = 0;
    get executedToolCount() { return this.toolCalls + this.delegatedToolCalls; }
    get modelInvocationCount() { return this.modelInvocations + this.delegatedModelTurns; }
    constructor(private readonly model: AgentModel, private readonly builder: ContextBuilder, private readonly registry: ToolRegistry,
        readonly maxToolSteps: number, private readonly maxCallsPerBatch: number, private readonly maxInputTokens: number,
        readonly event: (name: string, fields?: Record<string, unknown>) => void, private readonly signal?: AbortSignal,
        private readonly maxProtocolRepairs = 0,
        readonly agents: readonly { name: string; description: string }[] = [],
        private readonly delegateTask?: (task: AgentTask, signal?: AbortSignal) => Promise<AgentTaskResult>) {}
    async delegate(task: AgentTask, operation?: AbortSignal): Promise<AgentTaskResult> {
        const signal = this.scope(operation); signal?.throwIfAborted();
        if (!this.delegateTask) reject("SUBAGENT_NOT_ALLOWED", "No sub-agents registered");
        try {
            const result = await this.delegateTask!(task, signal);
            this.delegatedModelTurns += result.modelTurns;
            this.delegatedToolCalls += result.toolCalls;
            return result;
        } catch (error) {
            if (error instanceof DelegationError && error.usage) {
                this.delegatedModelTurns += error.usage.modelTurns;
                this.delegatedToolCalls += error.usage.toolCalls;
            }
            throw error;
        }
    }
    get tools(): ToolDefinition[] { return this.registry.definitions(); }
    private scope(operation?: AbortSignal) { return this.signal && operation ? AbortSignal.any([this.signal, operation]) : this.signal ?? operation; }
    async prepare(rounds: readonly ToolRound[], final: boolean, operation?: AbortSignal): Promise<AgentMessage[]> {
        const scope = this.scope(operation); scope?.throwIfAborted();
        if (!final && this.decisionTurns >= this.maxToolSteps) reject("TOOLS_DISABLED", "Research budget exhausted; prepare the final turn explicitly");
        this.final = final;
        return abortable(() => this.builder.build([...this.initialRounds, ...rounds], this.final ? [] : this.tools, this.final, scope), scope);
    }
    /** 预取也走相同的批次校验、限额和执行器，不能绕过工具策略。 */
    async prefetch(calls: ToolCall[], content: string, signal?: AbortSignal): Promise<void> {
        const results = await this.executeBatch(calls, signal);
        this.initialRounds.push(toolRound({ content, toolCalls: calls }, results));
    }
    private validateCalls(calls: ToolCall[], allowed: ToolDefinition[], ids: Set<string>) {
        if (!Array.isArray(calls) || calls.length > this.maxCallsPerBatch) reject("TOOL_BATCH_LIMIT", "Agent tool step limit exceeded");
        const batch = new Set<string>();
        for (const call of calls) {
            if (!call || typeof call.id !== "string" || !call.id.trim() || call.id.length > 200) reject("INVALID_CALL_ID", "Missing or invalid tool call ID");
            if (batch.has(call.id) || ids.has(call.id)) reject("DUPLICATE_CALL_ID", "Duplicate tool call IDs");
            if (!allowed.some(tool => tool.name === call.name)) reject("UNKNOWN_TOOL", "Unknown or disabled tool");
            if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) reject("INVALID_CALL_ARGUMENTS", "Tool call arguments must be a JSON object");
            batch.add(call.id);
        }
    }
    async complete(messages: AgentMessage[], tools: ToolDefinition[], operation?: AbortSignal): Promise<AgentTurn> {
        const scope = this.scope(operation); scope?.throwIfAborted();
        if (this.decisionTurns >= this.maxToolSteps + 1) reject("MODEL_TURN_LIMIT", "Agent model turn limit exceeded");
        const available = this.tools;
        if (tools.some(tool => !available.some(entry => isDeepStrictEqual(entry, tool)))) reject("UNKNOWN_TOOL", "Unknown or altered tool definition");
        if ((this.final || this.decisionTurns === this.maxToolSteps) && tools.length) reject("TOOLS_DISABLED", "Tools are disabled for the final turn");
        if (this.builder.size(messages, tools) > this.maxInputTokens) reject("CONTEXT_LIMIT", "Model input exceeds context budget");
        this.decisionTurns++;
        let input = messages;
        for (;;) {
            try {
                this.modelInvocations++;
                const turn = await abortable(() => this.model.turn(input, tools, scope), scope);
                scope?.throwIfAborted();
                if (!turn || typeof turn.content !== "string" || !Array.isArray(turn.toolCalls)) reject("INVALID_TURN", "Invalid agent turn");
                if (!tools.length && turn.toolCalls.length) reject("TOOLS_DISABLED", "Agent tool step limit exceeded");
                if (!turn.toolCalls.length && !turn.content.trim()) reject("EMPTY_ANSWER", "Empty agent answer");
                this.validateCalls(turn.toolCalls, tools, new Set([...this.requestedIds, ...this.executedIds]));
                turn.toolCalls.forEach(call => this.requestedIds.add(call.id));
                return structuredClone(turn);
            } catch (error) {
                scope?.throwIfAborted();
                const code = error instanceof HarnessPolicyError || error instanceof ModelProtocolError ? error.code : undefined;
                const repairable = code && ["INVALID_TOOL_CALLS", "INVALID_CALL_ID", "DUPLICATE_CALL_ID", "UNKNOWN_TOOL", "INVALID_CALL_ARGUMENTS", "TOOL_BATCH_LIMIT"].includes(code);
                // 只纠正未执行的研究批次。网络重试属于 RecoveringModel，最终轮不能再开工具。
                if (!tools.length || !repairable || this.repairs >= this.maxProtocolRepairs) throw error;
                const feedback: AgentMessage = { role: "system", content:
                    `The previous tool request was rejected (${code}); no tools in that batch ran. Use only the supplied tool names and JSON object arguments matching their schemas. Supply fresh non-empty unique call IDs. At most ${this.maxCallsPerBatch} calls per batch. Return a corrected tool request or a supported final answer.` };
                input = [...messages, feedback];
                if (this.builder.size(input, tools) > this.maxInputTokens) throw error;
                this.repairs++;
                this.event("agent.protocol_repair", { code, repair: this.repairs, maxRepairs: this.maxProtocolRepairs });
            }
        }
    }
    async executeBatch(calls: ToolCall[], operation?: AbortSignal): Promise<AgentMessage[]> {
        const scope = this.scope(operation); scope?.throwIfAborted();
        this.validateCalls(calls, this.tools, this.executedIds);
        if (this.toolCalls + calls.length > this.maxToolSteps * this.maxCallsPerBatch) reject("TOOL_CALL_LIMIT", "Agent total tool call limit exceeded");
        const snapshot = structuredClone(calls);
        snapshot.forEach(call => this.executedIds.add(call.id));
        this.toolCalls += snapshot.length;
        const results: AgentMessage[] = [];
        // 连续的只读幂等调用可并行；有状态工具形成顺序屏障，返回顺序仍与请求一致。
        for (let i = 0; i < snapshot.length;) {
            const call = snapshot[i]!;
            if (!this.registry.parallelSafe(call.name)) {
                results.push(await this.registry.execute(call, scope));
                i++;
                continue;
            }
            const group: ToolCall[] = [];
            while (i < snapshot.length && this.registry.parallelSafe(snapshot[i]!.name)) group.push(snapshot[i++]!);
            results.push(...await Promise.all(group.map(call => this.registry.execute(call, scope))));
        }
        return results;
    }
    async execute(call: ToolCall, operation?: AbortSignal): Promise<AgentMessage> { return (await this.executeBatch([call], operation))[0]!; }
}
