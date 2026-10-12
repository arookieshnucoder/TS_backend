import type { ChatSession, ChatMessage } from "../entity/chat-session.entity.js";
export interface ChatAgentRunContext { runId: string; event(name: string, fields?: Record<string, unknown>): void; }

/** Chat-facing port. Persistence does not depend on a concrete Harness or provider. */
export interface ChatAgent {
    run(session: ChatSession, current: ChatMessage, signal?: AbortSignal, context?: ChatAgentRunContext): Promise<{ content: string; modelTurns?: number; toolCalls?: number }>;
    titleFor(session: ChatSession, signal?: AbortSignal): Promise<string>;
}
