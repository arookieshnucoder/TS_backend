import type { ChatSession } from "../../../modules/chat/entity/chat-session.entity.js";
import type { ChatSessionRepository } from "../../../modules/chat/repository/chat-session.repository.js";

export class InMemoryChatSessionRepository implements ChatSessionRepository {
  private readonly sessions = new Map<string, ChatSession>();

  async save(session: ChatSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async findById(id: string): Promise<ChatSession | null> {
    const session = this.sessions.get(id);
    return session ? structuredClone(session) : null;
  }

  async findAll(): Promise<ChatSession[]> {
    return [...this.sessions.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(session => structuredClone(session));
  }
}
