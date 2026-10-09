import type { ChatSession } from "../entity/chat-session.entity.js";

export interface ChatSessionRepository {
  save(session: ChatSession): Promise<void>;
  findById(id: string): Promise<ChatSession | null>;
  findAll(): Promise<ChatSession[]>;
}
