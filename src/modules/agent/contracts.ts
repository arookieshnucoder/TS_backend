/** Provider-neutral protocol. No SDK, HTTP or storage dependencies. */
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown>; }
export interface AgentTurn { content: string; toolCalls: ToolCall[]; }
/** Only complete exchanges may enter the next prompt or be compacted. */
export interface ToolRound { assistant: AgentMessage; results: AgentMessage[]; }
export interface AgentResult { content: string; modelTurns: number; toolCalls: number; }
export interface AgentRuntime {
  readonly tools: ToolDefinition[];
  readonly maxToolSteps: number;
  readonly maxCallsPerStep: number;
  prepare(rounds: readonly ToolRound[], final: boolean, signal?: AbortSignal): Promise<AgentMessage[]>;
  complete(messages: AgentMessage[], tools: ToolDefinition[], signal?: AbortSignal): Promise<AgentTurn>;
  execute(call: ToolCall, signal?: AbortSignal): Promise<AgentMessage>;
  event(name: string, fields?: Record<string, unknown>): void;
}
