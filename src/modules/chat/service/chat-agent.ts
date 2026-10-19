import type { ChatSession, ChatMessage } from "../entity/chat-session.entity.js";
import type { WorkflowSnapshot } from "../../workflows/definition.js";
/** 会话执行的追踪上下文，把工作流事件关联到同一次运行。 */
export interface ChatAgentRunContext { runId: string; event(name: string, fields?: Record<string, unknown>): void; workflow?(snapshot: WorkflowSnapshot & { runtime: Record<string, unknown> }): Promise<void>; }

/** 会话服务依赖的 agent 接口，统一提供作答和标题生成，隔离模型及学科实现。 */
export interface ChatAgent {
    run(session: ChatSession, current: ChatMessage, signal?: AbortSignal, context?: ChatAgentRunContext): Promise<{ content: string; modelTurns?: number; toolCalls?: number }>;
    titleFor(session: ChatSession, signal?: AbortSignal): Promise<string>;
}
