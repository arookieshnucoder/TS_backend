import { isDeepStrictEqual } from "node:util";
import type { AgentMessage, AgentRuntime, AgentTurn, ToolCall, ToolDefinition, ToolRound } from "../agent/contracts.js";
import type { AgentModel } from "../agent/model.js";
import type { ContextBuilder } from "./context-builder.js";
import type { ToolRegistry } from "./tool-registry.js";
import { abortable } from "./cancellation.js";

export class HarnessPolicyError extends Error {
    constructor(readonly code: string, message: string) { super(message); this.name = "HarnessPolicyError"; }
}
const reject = (code: string, message: string): never => { throw new HarnessPolicyError(code, message); };

/** Execution policy is enforced here for every workflow, including injected workflows. */
export class HarnessRuntime implements AgentRuntime {
    private modelTurns = 0;
    private toolCalls = 0;
    private final = false;
    private readonly requestedIds = new Set<string>();
    private readonly executedIds = new Set<string>();
    private initialRounds: ToolRound[]=[];
    setInitialRounds(rounds:ToolRound[]){this.initialRounds=rounds;}
    get executedToolCount(){return this.toolCalls;}
    constructor(private readonly model: AgentModel, private readonly builder: ContextBuilder, private readonly registry: ToolRegistry,
        readonly maxToolSteps: number, private readonly maxCallsPerBatch: number, private readonly maxInputTokens: number,
        readonly event: (name: string, fields?: Record<string, unknown>) => void, private readonly signal?: AbortSignal) {}
    get tools(): ToolDefinition[] { return this.registry.definitions(); }
    private scope(operation?: AbortSignal) { return this.signal && operation ? AbortSignal.any([this.signal, operation]) : this.signal ?? operation; }
    async prepare(rounds: readonly ToolRound[], final: boolean, operation?: AbortSignal): Promise<AgentMessage[]> {
        const scope = this.scope(operation); scope?.throwIfAborted();
        if (!final && this.modelTurns >= this.maxToolSteps) reject("TOOLS_DISABLED", "Research budget exhausted; prepare the final turn explicitly");
        this.final = final;
        return abortable(() => this.builder.build([...this.initialRounds,...rounds], this.final ? [] : this.tools, this.final, scope), scope);
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
        if (this.modelTurns >= this.maxToolSteps + 1) reject("MODEL_TURN_LIMIT", "Agent model turn limit exceeded");
        const available = this.tools;
        if (tools.some(tool => !available.some(entry => isDeepStrictEqual(entry, tool)))) reject("UNKNOWN_TOOL", "Unknown or altered tool definition");
        if ((this.final || this.modelTurns === this.maxToolSteps) && tools.length) reject("TOOLS_DISABLED", "Tools are disabled for the final turn");
        if (this.builder.size(messages, tools) > this.maxInputTokens) reject("CONTEXT_LIMIT", "Model input exceeds context budget");
        this.modelTurns++;
        const turn = await abortable(() => this.model.turn(messages, tools, scope), scope);
        scope?.throwIfAborted();
        if (!turn || typeof turn.content !== "string" || !Array.isArray(turn.toolCalls)) reject("INVALID_TURN", "Invalid agent turn");
        if (!tools.length && turn.toolCalls.length) reject("TOOLS_DISABLED", "Agent tool step limit exceeded");
        if (!turn.toolCalls.length && !turn.content.trim()) reject("EMPTY_ANSWER", "Empty agent answer");
        this.validateCalls(turn.toolCalls, tools, this.requestedIds);
        turn.toolCalls.forEach(call => this.requestedIds.add(call.id));
        return structuredClone(turn);
    }
    async executeBatch(calls: ToolCall[], operation?: AbortSignal): Promise<AgentMessage[]> {
        const scope = this.scope(operation); scope?.throwIfAborted();
        this.validateCalls(calls, this.tools, this.executedIds);
        if (this.toolCalls + calls.length > this.maxToolSteps * this.maxCallsPerBatch) reject("TOOL_CALL_LIMIT", "Agent total tool call limit exceeded");
        const snapshot = structuredClone(calls);
        snapshot.forEach(call => this.executedIds.add(call.id));
        this.toolCalls += snapshot.length;
        const results: AgentMessage[] = [];
        for (let i=0;i<snapshot.length;) {
            const call=snapshot[i]!;
            if(!this.registry.parallelSafe(call.name)){results.push(await this.registry.execute(call,scope));i++;continue;}
            const group:ToolCall[]=[];
            while(i<snapshot.length&&this.registry.parallelSafe(snapshot[i]!.name))group.push(snapshot[i++]!);
            results.push(...await Promise.all(group.map(c=>this.registry.execute(c,scope))));
        }
        return results;
    }
    async execute(call: ToolCall, operation?: AbortSignal): Promise<AgentMessage> { return (await this.executeBatch([call], operation))[0]!; }
}
