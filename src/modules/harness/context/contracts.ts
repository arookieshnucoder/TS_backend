import type { ChatSession } from "../../chat/entity/chat-session.entity.js";

export interface MemoryChunk { id: string; sessionId: string; title: string; text: string; }
export interface MemorySearch {
  sync(sessions: ChatSession[], signal?: AbortSignal): Promise<void>;
  titles(query: string, sessionIds: string[], signal?: AbortSignal): Promise<string[]>;
  search(query: string, sessionIds: string[], limit: number, signal?: AbortSignal): Promise<MemoryChunk[]>;
}
