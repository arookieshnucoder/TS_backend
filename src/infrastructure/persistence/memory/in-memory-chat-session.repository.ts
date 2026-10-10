import type { ChatSession } from "../../../modules/chat/entity/chat-session.entity.js";
import type { ChatSessionRepository } from "../../../modules/chat/repository/chat-session.repository.js";


/**
 * 继承自 ChatSessionRepository 的内存实现，用于在内存中存储聊天会话。后续可继续继承来实现其他存储方式。
 * 三个方法的多态实现都死异步的，保证了接口的一致性。
 * 使用 structuredClone 来确保返回的对象是独立的副本，避免外部修改影响内存中的数据。
 */
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
