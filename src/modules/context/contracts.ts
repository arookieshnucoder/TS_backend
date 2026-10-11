import type { ChatSession } from "../chat/entity/chat-session.entity.js";

export interface MemoryChunk { id: string; sessionId: string; title: string; text: string; }
export interface MemorySearch {
  sync(sessions: ChatSession[], signal?: AbortSignal): Promise<void>;
  titles(query: string, sessionIds: string[], signal?: AbortSignal): Promise<string[]>;
  search(query: string, sessionIds: string[], limit: number, signal?: AbortSignal): Promise<MemoryChunk[]>;
}
export interface ContextTool<I, O> { readonly name: string; execute(input: I, signal?: AbortSignal): Promise<O>; }
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown>; }
export interface AgentTurn { content: string; toolCalls: ToolCall[]; }
