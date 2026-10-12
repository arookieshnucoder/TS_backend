import type { ChatSession } from "../entity/chat-session.entity.js";

/**
 * 表示聊天会话中的一个内存块。
 * @property id 内存块的唯一标识。
 * @property sessionId 所属聊天会话的 ID。
 * @property title 内存块的标题。
 * @property text 内存块的文本内容。
 */
export interface MemoryChunk { id: string; sessionId: string; title: string; text: string; }
/**
 * 表示内存检索的接口。
 * @method sync 同步聊天会话数据。
 * @method titles 根据查询获取相关会话标题。
 * @method search 根据查询获取相关内存块。
 */
export interface MemorySearch {
  sync(sessions: ChatSession[], signal?: AbortSignal): Promise<void>;
  titles(query: string, sessionIds: string[], signal?: AbortSignal): Promise<string[]>;
  search(query: string, sessionIds: string[], limit: number, signal?: AbortSignal): Promise<MemoryChunk[]>;
}
