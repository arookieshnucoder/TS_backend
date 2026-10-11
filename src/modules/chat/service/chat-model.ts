import type { ChatMessage } from "../entity/chat-session.entity.js";
import type { AgentMessage, AgentTurn, ToolDefinition } from "../../context/contracts.js";
export interface ChatModel {
  reply(messages: ChatMessage[], signal?: AbortSignal, maxOutputTokens?: number): Promise<string>;
  turn?(messages: AgentMessage[], tools: ToolDefinition[], signal?: AbortSignal): Promise<AgentTurn>;
}
