import type { ToolDefinition } from "../agent/contracts.js";

/** Declaration ports shared by native and MCP tools; no executor/provider dependencies. */
export class ToolInputError extends Error { }
export class ToolAccessError extends Error { }
export class ToolExecutionError extends Error { }
export interface RegisteredTool {
    definition: ToolDefinition;
    readonly: boolean;
    idempotent?: boolean;
    source?: { type: "custom" | "mcp"; serverId?: string; toolName?: string };
    validate(input: Record<string, unknown>): void;
    execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}
