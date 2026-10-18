import { AppError } from "../../common/errors/app-error.js";

/** MCP 服务持久化配置，描述连接方式、启用状态和修改类工具授权。 */
export interface McpServerConfig {
    id: string;
    name: string;
    transport: "stdio" | "http" | "sse";
    enabled: boolean;
    allowMutations: boolean;
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
}
const invalid = (message: string): never => { throw new AppError(400, "MCP_INVALID_CONFIG", message); };
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function text(value: unknown, field: string, max = 2000): string {
    if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) return invalid(`${field} 必须是非空字符串（最多 ${max} 字符）。`);
    return value;
}
function map(value: unknown, field: string): Record<string, string> | undefined {
    if (value === undefined) return undefined;
    if (!object(value) || Object.keys(value).length > 50) return invalid(`${field} 必须是字符串键值对象，最多 50 项。`);
    return Object.fromEntries(Object.entries(value).map(([key, value]) => {
        if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)) return invalid(`${field} 的键名无效。`);
        return [key, text(value, field, 4000)];
    }));
}
export function parseServer(value: unknown, key?: string): McpServerConfig {
    if (!object(value)) return invalid("MCP 配置必须是对象。");
    const allowed = new Set(["id", "name", "transport", "type", "enabled", "allowMutations", "command", "args", "cwd", "url", "env", "headers"]);
    if (Object.keys(value).some(k => !allowed.has(k))) return invalid("MCP 配置包含不支持的字段。");
    const id = text(key ?? value.id, "id", 40);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) return invalid("id 必须以字母开头，仅含字母、数字、下划线和短横线。");
    const transport = value.transport ?? value.type ?? (value.command ? "stdio" : "http");
    if (!["stdio", "http", "streamable-http", "sse"].includes(String(transport))) return invalid("不支持的 MCP 传输类型。");
    for (const field of ["enabled", "allowMutations"]) if (value[field] !== undefined && typeof value[field] !== "boolean") return invalid(`${field} 必须是布尔值。`);
    const config: McpServerConfig = { id, name: text(value.name ?? id, "name", 80),
        transport: transport === "streamable-http" ? "http" : transport as McpServerConfig["transport"],
        enabled: value.enabled === true, allowMutations: value.allowMutations === true };
    if (config.transport === "stdio") {
        config.command = text(value.command, "command");
        if (value.url !== undefined || value.headers !== undefined) return invalid("stdio 不接受 url 或 headers。");
        if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 100 || value.args.some(a => typeof a !== "string" || a.length > 4000 || a.includes("\0")))) return invalid("args 必须是字符串数组。");
        config.args = (value.args as string[] | undefined) ?? [];
        if (value.cwd !== undefined) config.cwd = text(value.cwd, "cwd");
        config.env = map(value.env, "env");
    } else {
        if (["command", "args", "cwd", "env"].some(k => value[k] !== undefined)) return invalid("HTTP/SSE 不接受进程配置字段。");
        config.url = text(value.url, "url");
        let url: URL;
        try { url = new URL(config.url); } catch { return invalid("url 无效。"); }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return invalid("url 必须是无嵌入凭据的 HTTP(S) 地址。");
        config.headers = map(value.headers, "headers");
        if (config.headers && Object.values(config.headers).some(v => /[\r\n]/.test(v))) return invalid("headers 值不得包含换行。");
    }
    return config;
}
export function parseImport(value: unknown): McpServerConfig[] {
    if (!object(value)) return invalid("导入内容必须是 JSON 对象。");
    const configs = object(value.mcpServers) ? Object.entries(value.mcpServers).map(([key, value]) => parseServer(value, key)) : [parseServer(value)];
    if (!configs.length || configs.length > 32) return invalid("一次导入 1 至 32 个 MCP 服务。");
    return configs;
}
/** Resolve credentials on the backend only; never inherit the full process environment. */
export function resolveValues(values: Record<string, string> = {}, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
        if (env[name] === undefined) throw new Error("Missing MCP environment variable");
        return env[name]!;
    })]));
}
