/** Provider-neutral protocol. No SDK, HTTP or storage dependencies. */
export interface AgentMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
    toolCalls?: ToolCall[];
    reasoningContent?: string;
}
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown>; }
export interface AgentTurn { content: string; toolCalls: ToolCall[]; reasoningContent?: string; usage?: { inputTokens: number; outputTokens: number }; }
/**
 * 只有完整的工具调用回合才会进入下一轮提示或被压缩。
 */
export interface ToolRound { assistant: AgentMessage; results: AgentMessage[]; }

/** 所有工作流以同一种方式保存完整工具回合，包括 GLM 的本轮推理协议字段。 */
export function toolRound(turn: Pick<AgentTurn, "content" | "toolCalls" | "reasoningContent">, results: AgentMessage[]): ToolRound {
    return {
        assistant: { role: "assistant", content: turn.content, toolCalls: turn.toolCalls,
            ...(turn.reasoningContent ? { reasoningContent: turn.reasoningContent } : {}) },
        results,
    };
}
export interface AgentResult { content: string; modelTurns: number; toolCalls: number; }
export interface AgentInstructions { system: string; final: string; }
export interface AgentWorkflow {
    run(runtime: AgentRuntime, signal?: AbortSignal): Promise<AgentResult>;
}

/**
 * 代理运行时接口，定义了工具、步骤限制以及与代理交互的方法。
 */
export interface AgentRuntime {
    readonly tools: ToolDefinition[];
    readonly maxToolSteps: number;
    prepare(rounds: readonly ToolRound[], final: boolean, signal?: AbortSignal): Promise<AgentMessage[]>;
    complete(messages: AgentMessage[], tools: ToolDefinition[], signal?: AbortSignal): Promise<AgentTurn>;
    execute(call: ToolCall, signal?: AbortSignal): Promise<AgentMessage>;
    executeBatch(calls: ToolCall[], signal?: AbortSignal): Promise<AgentMessage[]>;
    event(name: string, fields?: Record<string, unknown>): void;
}
