/** 供应商无关的模型消息；工具关联 ID 和推理字段用于保持完整调用协议。 */
export interface AgentMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
    toolCalls?: ToolCall[];
    reasoningContent?: string;
}
/** 模型请求执行的工具及参数，id 用于关联对应的工具结果。 */
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}
/** 提供给模型的工具说明和参数结构，不包含实际执行函数。 */
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}
/** 一次模型返回的可见文本、工具请求及可选 token 用量。 */
export interface AgentTurn {
    content: string;
    toolCalls: ToolCall[];
    /** 供应商要求在后续工具回合带回的推理字段，不作为可见答案展示。 */
    reasoningContent?: string;
    usage?: { inputTokens: number; outputTokens: number };
}
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
/** 一轮工作流的最终答案和调用统计，可附带独立核验状态。 */
export interface AgentResult {
    content: string;
    modelTurns: number;
    toolCalls: number;
    review?: { status: "passed" | "failed" | "uncertain" | "unavailable"; attempts: number; revised: boolean };
}
/** 显式委派给已注册子 agent 的任务，子任务不会自动继承父任务历史。 */
export interface AgentTask { agent: string; input: string; context?: AgentMessage[]; }
/** 子任务结果，在通用答案上补充任务 ID 和实际执行的 agent 名称。 */
export interface AgentTaskResult extends AgentResult { taskId: string; agent: string; }
/** 结果处理器可读取的当前问题和历史消息，用于核验和格式检查。 */
export interface AgentResultContext { question: string; history: readonly AgentMessage[]; }
/** 答案提交前的公共处理阶段，可核验、修正或规范化工作流输出。 */
export interface AgentResultProcessor {
    process(result: AgentResult, runtime: AgentRuntime, context: AgentResultContext, signal?: AbortSignal): Promise<AgentResult>;
}
/** 工作流提示词：system 指定常规规则，final 指定最后一次作答要求。 */
export interface AgentInstructions { system: string; final: string; }
/** 解题决策接口，只决定如何使用运行时，不负责存储或供应商协议转换。 */
export interface AgentWorkflow {
    run(runtime: AgentRuntime, signal?: AbortSignal): Promise<AgentResult>;
}

/**
 * 工作流可调用的运行能力。所有模型、工具和委派操作均经过同一预算、取消与追踪机制。
 */
export interface AgentRuntime {
    /** 当前宿主允许委派的子 agent；没有出现在列表中的名称不可调用。 */
    readonly agents: readonly { name: string; description: string }[];
    delegate(task: AgentTask, signal?: AbortSignal): Promise<AgentTaskResult>;
    readonly tools: ToolDefinition[];
    readonly maxToolSteps: number;
    /** 用完整工具回合构建上下文；final 为 true 时追加最终作答要求。 */
    prepare(rounds: readonly ToolRound[], final: boolean, signal?: AbortSignal): Promise<AgentMessage[]>;
    complete(messages: AgentMessage[], tools: ToolDefinition[], signal?: AbortSignal): Promise<AgentTurn>;
    execute(call: ToolCall, signal?: AbortSignal): Promise<AgentMessage>;
    /** 批量执行仍逐项检查权限和次数，返回结果顺序与调用顺序一致。 */
    executeBatch(calls: ToolCall[], signal?: AbortSignal): Promise<AgentMessage[]>;
    event(name: string, fields?: Record<string, unknown>): void;
}
