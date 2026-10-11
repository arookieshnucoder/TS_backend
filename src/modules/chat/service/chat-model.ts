import type { ChatMessage } from "../entity/chat-session.entity.js";
export interface ChatModel {
  reply(messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
}
