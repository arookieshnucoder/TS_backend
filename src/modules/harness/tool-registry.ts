import type { AgentMessage, ToolCall, ToolDefinition } from "../agent/contracts.js";
import type { TokenBudget } from "./context/tokens.js";
import { abortable } from "./cancellation.js";
import { recoveryPolicy, retry, type RecoveryPolicy } from "./recovery.js";
import { ToolInputError, ToolAccessError, type RegisteredTool } from "./tool-contracts.js";

/**
 * 工具注册表，负责管理工具的注册、验证和执行。
 */
export class ToolRegistry {
    private readonly entries = new Map<string, RegisteredTool>();
    constructor(private readonly tokens: TokenBudget, private readonly outputTokens: number, private readonly timeoutMs: number,
        private readonly event: (name: string, fields: Record<string, unknown>) => void,
        private readonly recovery: RecoveryPolicy = recoveryPolicy()) { }
    register(tool: RegisteredTool): this {
        if (typeof tool.readonly !== "boolean" || this.entries.has(tool.definition.name)) throw new Error("Invalid or duplicate tool");
        this.entries.set(tool.definition.name, tool);
        return this;
    }
    /**
     * 获取所有已注册的只读工具的定义。
     * @returns 工具定义的数组，包含所有已注册的只读工具的副本。
     */
    definitions(): ToolDefinition[] { return [...this.entries.values()].map(tool => structuredClone(tool.definition)); }
    async execute(call: ToolCall, signal?: AbortSignal): Promise<AgentMessage> {
        signal?.throwIfAborted();
        const tool = this.entries.get(call.name);
        if (!tool) throw new Error("Unknown tool");
        const started = Date.now();
        this.event("agent.tool.started", { tool: call.name, callId: call.id, arguments: call.arguments, source: tool.source, readonly: tool.readonly });
        let text: string;
        let status = "success";
        let code: string | undefined;
        let attempts = 0;
        try {
            if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) throw new ToolInputError("Expected a JSON object");
            tool.validate(call.arguments);
            const timeout = AbortSignal.timeout(this.timeoutMs);
            const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
            text = await retry(attempt => { attempts = attempt; return abortable(() => tool.execute(structuredClone(call.arguments), combined), combined); },
                tool.idempotent === true ? this.recovery.toolRetries : 0, this.recovery, combined, this.event,
                { operation: "tool", tool: call.name, callId: call.id });
            signal?.throwIfAborted();
        } catch (error) {
            if (signal?.aborted) this.event("agent.tool", { tool: call.name, callId: call.id, source: tool.source, status: "cancelled", attempts, durationMs: Date.now() - started });
            signal?.throwIfAborted();
            status = "error";
            // Raw exceptions may contain provider credentials or absolute paths.
            code = error instanceof ToolInputError ? "INVALID_ARGUMENTS" : error instanceof ToolAccessError ? "ACCESS_DENIED" :
                error instanceof Error && error.name === "TimeoutError" ? "TOOL_TIMEOUT" : "TOOL_FAILED";
            text = JSON.stringify({ error: code, message: error instanceof ToolInputError ? error.message : "Tool unavailable or access denied. Refine the request or report the limitation." });
        }
        signal?.throwIfAborted();
        const suffix = "\n[Tool output truncated; narrow the query or request a smaller line range.]";
        const truncated = this.tokens.count(text) > this.outputTokens;
        if (truncated) text = this.tokens.truncate(text, this.outputTokens - this.tokens.count(suffix)) + suffix;
        this.event("agent.tool", { tool: call.name, callId: call.id, source: tool.source, status, code, attempts, result: text,
            truncated, durationMs: Date.now() - started, resultTokens: this.tokens.count(text) });
        return { role: "tool", toolCallId: call.id, content: text || "No matching evidence found." };
    }
}
