import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../../common/logging/logger.js";
import { AppError } from "../../common/errors/app-error.js";
import { abortable } from "../harness/cancellation.js";
import { ToolAccessError, type RegisteredTool } from "../harness/tool-contracts.js";
import { parseImport, parseServer, resolveValues, type McpServerConfig } from "./mcp-config.js";
import { adaptMcpTool } from "./mcp-tools.js";

/** 提供给管理界面的 MCP 服务状态和工具列表，不暴露连接凭据。 */
export interface McpServerView {
    id: string; name: string; transport: McpServerConfig["transport"]; enabled: boolean; allowMutations: boolean;
    status: "disabled" | "disconnected" | "connecting" | "connected" | "error";
    error?: string;
    tools: { name: string; description: string; readonly: boolean; available: boolean }[];
}
/** 一个 MCP 服务的活动连接，组合客户端、传输通道和生效配置。 */
interface Connection { client: Client; transport: Transport; config: McpServerConfig; }
export type McpConnector = (config: McpServerConfig, signal: AbortSignal) => Promise<Connection>;
export async function connectMcp(config: McpServerConfig, signal: AbortSignal): Promise<Connection> {
    const client = new Client({ name: "rag-agent-harness", version: "1.0.0" });
    const transport = config.transport === "stdio" ? new StdioClientTransport({ command: config.command!, args: config.args,
        cwd: config.cwd, env: { ...getDefaultEnvironment(), ...resolveValues(config.env) }, stderr: "ignore", maxBufferSize: 2 * 1024 * 1024 }) :
        config.transport === "sse" ? new SSEClientTransport(new URL(config.url!), {
            requestInit: { headers: resolveValues(config.headers) },
            eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...resolveValues(config.headers), ...Object.fromEntries(new Headers(init?.headers)) } }) },
        }) : new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: resolveValues(config.headers) } });
    try {
        await abortable(() => client.connect(transport, { signal, timeout: 10000 }), signal);
        signal.throwIfAborted();
        return { client, transport, config };
    } catch (error) { await client.close().catch(() => {}); await transport.close().catch(() => {}); throw error; }
}

/** 管理 MCP 配置、连接和工具目录，负责超时、授权检查及连接清理。 */
export class McpManager {
    private configs: McpServerConfig[] = [];
    private initialized?: Promise<void>;
    private queue: Promise<unknown> = Promise.resolve();
    private readonly connections = new Map<string, Connection>();
    private readonly pending = new Map<string, Promise<Connection>>();
    private readonly views = new Map<string, McpServerView>();
    private closed = false;
    constructor(private readonly file: string, private readonly logger: Logger,
        private readonly connector: McpConnector = connectMcp, private readonly timeoutMs = 10000) {}
    private initialize(): Promise<void> {
        return this.initialized ??= (async () => {
            try {
                const stored: unknown = JSON.parse(await readFile(this.file, "utf8"));
                if (!Array.isArray(stored) || stored.length > 32) throw new Error("Invalid MCP catalog");
                this.configs = stored.map(value => parseServer(value));
                if (new Set(this.configs.map(c => c.id)).size !== this.configs.length) throw new Error("Duplicate MCP catalog entries");
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        })();
    }
    private mutate<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.queue.then(fn);
        this.queue = next.catch(() => {});
        return next;
    }
    private async save(configs: McpServerConfig[]) {
        await mkdir(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(configs, null, 2), { flag: "wx", mode: 0o600 });
        await rename(temporary, this.file);
        this.configs = configs;
    }
    private view(config: McpServerConfig): McpServerView {
        const existing = this.views.get(config.id);
        return { id: config.id, name: config.name, transport: config.transport, enabled: config.enabled, allowMutations: config.allowMutations,
            status: !config.enabled ? "disabled" : existing?.status ?? "disconnected", error: existing?.error,
            tools: (existing?.tools ?? []).map(t => ({ ...t, available: config.enabled && (t.readonly || config.allowMutations) })) };
    }
    async list(): Promise<McpServerView[]> { await this.initialize(); return this.configs.map(c => this.view(c)); }
    async import(value: unknown): Promise<McpServerView[]> {
        const entries = parseImport(value);
        return this.mutate(async () => {
            await this.initialize();
            const updated = new Map(this.configs.map(c => [c.id, c]));
            for (const c of entries) updated.set(c.id, c);
            if (updated.size > 32) throw new AppError(400, "MCP_LIMIT", "最多配置 32 个 MCP 服务。");
            await this.save([...updated.values()]);
            for (const c of entries) { await this.disconnect(c.id); this.views.delete(c.id); }
            return this.list();
        });
    }
    async update(id: string, patch: { enabled?: boolean; allowMutations?: boolean }): Promise<McpServerView[]> {
        return this.mutate(async () => {
            await this.initialize();
            const config = this.configs.find(c => c.id === id);
            if (!config) throw new AppError(404, "MCP_NOT_FOUND", "MCP 服务不存在。");
            await this.save(this.configs.map(c => c.id === id ? { ...c, ...patch } : c));
            await this.disconnect(id);
            this.views.delete(id);
            return this.list();
        });
    }
    private async disconnect(id: string) {
        const connection = this.connections.get(id);
        this.connections.delete(id);
        if (connection) {
            if (connection.transport instanceof StreamableHTTPClientTransport)
                await abortable(() => connection.transport instanceof StreamableHTTPClientTransport ? connection.transport.terminateSession() : Promise.resolve(), AbortSignal.timeout(1000)).catch(() => {});
            await connection.client.close().catch(() => {});
        }
        // Pending handshakes check config identity before entering the cache.
    }
    private async connection(config: McpServerConfig): Promise<Connection> {
        const cached = this.connections.get(config.id);
        if (cached?.config === config) return cached;
        const previous = this.pending.get(config.id);
        if (previous) { await previous.catch(() => {}); return this.connection(config); }
        const connecting = (async () => {
            this.views.set(config.id, { ...this.view(config), status: "connecting" });
            const connection = await this.connector(config, AbortSignal.timeout(this.timeoutMs));
            if (this.closed || this.configs.find(c => c.id === config.id) !== config) { await connection.client.close(); throw new ToolAccessError("MCP configuration changed"); }
            this.connections.set(config.id, connection);
            this.views.set(config.id, { ...this.view(config), status: "connected", error: undefined });
            connection.client.onclose = () => {
                if (this.connections.get(config.id) === connection) {
                    this.connections.delete(config.id);
                    this.views.set(config.id, { ...this.view(config), status: "disconnected" });
                }
            };
            return connection;
        })();
        this.pending.set(config.id, connecting);
        try { return await connecting; } finally { if (this.pending.get(config.id) === connecting) this.pending.delete(config.id); }
    }
    private async discover(config: McpServerConfig, signal?: AbortSignal, event?: (name: string, fields: Record<string, unknown>) => void): Promise<RegisteredTool[]> {
        const started = Date.now();
        event?.("mcp.discovery.started", { serverId: config.id, transport: config.transport });
        const scope = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
        try {
            const connection = await abortable(() => this.connection(config), scope);
            const catalog: Tool[] = [];
            const cursors = new Set<string>();
            let cursor: string | undefined;
            do {
                const page = await connection.client.listTools(cursor ? { cursor } : undefined, { signal: scope, timeout: this.timeoutMs });
                catalog.push(...page.tools);
                cursor = page.nextCursor;
                if (catalog.length > 256 || (cursor && cursors.has(cursor)) || cursors.size > 32) throw new Error("MCP catalog exceeds limits");
                if (cursor) cursors.add(cursor);
            } while (cursor);
            const names = new Set<string>();
            const tools = catalog.map(tool => {
                if (names.has(tool.name)) throw new Error("Duplicate MCP tool name");
                names.add(tool.name);
                return adaptMcpTool(config.id, tool, async (args, operation) => {
                    const current = this.configs.find(c => c.id === config.id);
                    if (this.closed || current !== config || !current.enabled || (tool.annotations?.readOnlyHint !== true && !current.allowMutations)) throw new ToolAccessError("MCP is disabled or tool access revoked");
                    const live = await abortable(() => this.connection(config), operation);
                    return CallToolResultSchema.parse(await live.client.callTool({ name: tool.name, arguments: args }, CallToolResultSchema, { signal: operation, timeout: this.timeoutMs }));
                });
            });
            if (this.configs.find(c => c.id === config.id) !== config) throw new ToolAccessError("MCP configuration changed");
            this.views.set(config.id, { ...this.view(config), status: "connected", error: undefined,
                tools: catalog.map(t => ({ name: t.name, description: (t.description ?? "").slice(0, 500), readonly: t.annotations?.readOnlyHint === true, available: t.annotations?.readOnlyHint === true || config.allowMutations })) });
            const available = tools.filter(t => t.readonly || config.allowMutations);
            event?.("mcp.discovery.completed", { serverId: config.id, durationMs: Date.now() - started, count: catalog.length, available: available.length });
            return available;
        } catch (error) {
            event?.("mcp.discovery.failed", { serverId: config.id, durationMs: Date.now() - started, cancelled: signal?.aborted ?? false });
            signal?.throwIfAborted();
            if (this.configs.find(c => c.id === config.id) === config) {
                this.views.set(config.id, { ...this.view(config), status: "error", error: "连接或工具发现失败，请检查地址、进程、凭据和 JSON Schema。", tools: [] });
                await this.disconnect(config.id);
            }
            this.logger.error("mcp.unavailable", { serverId: config.id });
            return [];
        }
    }
    async test(id: string): Promise<McpServerView> {
        await this.initialize();
        const config = this.configs.find(c => c.id === id);
        if (!config) throw new AppError(404, "MCP_NOT_FOUND", "MCP 服务不存在。");
        if (!config.enabled) throw new AppError(409, "MCP_DISABLED", "请先启用 MCP 再测试连接。");
        await this.discover(config);
        return this.view(config);
    }
    async tools(signal?: AbortSignal, event?: (name: string, fields: Record<string, unknown>) => void): Promise<RegisteredTool[]> {
        signal?.throwIfAborted();
        if (this.closed) return [];
        try { await this.initialize(); } catch { this.logger.error("mcp.catalog_failed"); return []; }
        return (await Promise.all(this.configs.filter(c => c.enabled).map(c => this.discover(c, signal, event)))).flat();
    }
    async close(): Promise<void> {
        this.closed = true;
        await Promise.all([...this.connections.keys()].map(id => this.disconnect(id)));
        await Promise.allSettled(this.pending.values());
    }
}
