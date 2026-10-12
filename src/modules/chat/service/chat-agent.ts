import type { ChatSession, ChatMessage } from "../entity/chat-session.entity.js";

/** Chat-facing port. Persistence does not depend on a concrete Harness or provider. */
export interface ChatAgent {
  run(session: ChatSession, current: ChatMessage, signal?: AbortSignal): Promise<{ content: string }>;
  titleFor(session: ChatSession, signal?: AbortSignal): Promise<string>;
}
