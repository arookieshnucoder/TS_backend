import type { AgentMessage, ToolCall, ToolDefinition } from "../agent/contracts.js";
import type { TokenBudget } from "./context/tokens.js";
import { abortable } from "./cancellation.js";

export class ToolInputError extends Error {}
export class ToolAccessError extends Error {}
export interface RegisteredTool {
  definition: ToolDefinition;
  readonly: true;
  validate(input: Record<string, unknown>): void;
  execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

/** Request-local registry: the same objects advertise, validate and execute tools. */
export class ToolRegistry {
  private readonly entries = new Map<string, RegisteredTool>();
  constructor(private readonly tokens: TokenBudget, private readonly outputTokens: number, private readonly timeoutMs: number,
    private readonly event: (name: string, fields: Record<string, unknown>) => void) {}
  register(tool: RegisteredTool): this {
    if (tool.readonly !== true || this.entries.has(tool.definition.name)) throw new Error("Invalid or duplicate read-only tool");
    this.entries.set(tool.definition.name, tool);
    return this;
  }
  definitions(): ToolDefinition[] { return [...this.entries.values()].map(tool => structuredClone(tool.definition)); }
  async execute(call: ToolCall, signal?: AbortSignal): Promise<AgentMessage> {
    signal?.throwIfAborted();
    const tool = this.entries.get(call.name);
    if (!tool) throw new Error("Unknown tool");
    const started = Date.now();
    let text: string;
    let status = "success";
    try {
      if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) throw new ToolInputError("Expected a JSON object");
      tool.validate(call.arguments);
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      text = await abortable(() => tool.execute(call.arguments, combined), combined);
    } catch (error) {
      signal?.throwIfAborted();
      status = "error";
      // Raw exceptions may contain provider credentials or absolute paths.
      const code = error instanceof ToolInputError ? "INVALID_ARGUMENTS" : error instanceof ToolAccessError ? "ACCESS_DENIED" :
        error instanceof Error && error.name === "TimeoutError" ? "TOOL_TIMEOUT" : "TOOL_FAILED";
      text = JSON.stringify({ error: code, message: error instanceof ToolInputError ? error.message : "Tool unavailable or access denied. Refine the request or report the limitation." });
    }
    signal?.throwIfAborted();
    const suffix = "\n[Tool output truncated; narrow the query or request a smaller line range.]";
    const truncated = this.tokens.count(text) > this.outputTokens;
    if (truncated) text = this.tokens.truncate(text, this.outputTokens - this.tokens.count(suffix)) + suffix;
    this.event("agent.tool", { tool: call.name, callId: call.id, status, truncated, durationMs: Date.now() - started, resultTokens: this.tokens.count(text) });
    return { role: "tool", toolCallId: call.id, content: text || "No matching evidence found." };
  }
}

export function validateFields(input: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new ToolInputError(`Allowed fields: ${allowed.join(", ")}`);
}
export function stringField(input: Record<string, unknown>, key: string, max: number, optional = false): void {
  if (optional && input[key] === undefined) return;
  if (typeof input[key] !== "string" || !(input[key] as string).trim() || (input[key] as string).length > max)
    throw new ToolInputError(`${key} must be a non-empty string of at most ${max} characters`);
}
