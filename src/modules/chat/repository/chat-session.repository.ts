import type { ChatSession } from "../entity/chat-session.entity.js";

/**
 * 提供对聊天会话的持久化操作接口，包括保存、根据ID查找以及获取所有会话。
 */
export interface ChatSessionRepository {
    save(session: ChatSession): Promise<void>;
    findById(id: string): Promise<ChatSession | null>;
    findAll(): Promise<ChatSession[]>;
    // TODO: 可以以后扩展跨 session 个性化的操作
}
