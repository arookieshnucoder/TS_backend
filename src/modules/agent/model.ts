import type { AgentMessage, AgentTurn, ToolDefinition } from "./contracts.js";

/** One provider protocol for agent decisions and harness-internal text generation. */
export interface AgentModel {
  turn(messages: AgentMessage[], tools: ToolDefinition[], signal?: AbortSignal, maxOutputTokens?: number): Promise<AgentTurn>;
}
