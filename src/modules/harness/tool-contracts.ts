import type { ToolDefinition } from "../agent/contracts.js";

/** 工具参数格式或业务取值无效，应由模型修正输入。 */
export class ToolInputError extends Error { }
/** 工具访问被拒绝，例如路径越界或未授予写入权限。 */
export class ToolAccessError extends Error { }
/** 工具已通过参数检查，但实际执行失败。 */
export class ToolExecutionError extends Error { }
/** 已注册工具的完整契约，包括模型可见定义、权限、校验和执行函数。 */
export interface RegisteredTool {
    definition: ToolDefinition;
    readonly: boolean;
    idempotent?: boolean;
    source?: { type: "custom" | "mcp"; serverId?: string; toolName?: string };
    validate(input: Record<string, unknown>): void;
    execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}
