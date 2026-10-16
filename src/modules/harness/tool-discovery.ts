import type { AgentInstructions } from "../agent/contracts.js";
import type { ContextConfig } from "./context/config.js";
import type { TokenBudget } from "./context/tokens.js";
import type { RegisteredTool } from "./tool-contracts.js";
import type { ToolRegistry } from "./tool-registry.js";
import { defineTool, stringParameter } from "./define-tool.js";
import { rankTools, selectTools } from "./tool-selection.js";

/** 延迟公开大目录的工具 schema。只扩充本轮已授权目录，不连接新服务或改变 MCP 权限。 */
export function toolDiscovery(catalog: RegisteredTool[], registry: ToolRegistry, instructions: AgentInstructions,
    config: ContextConfig, tokens: TokenBudget, limit: number, question: string) {
    return defineTool({
        name: "tool_search",
        description: "Discover additional authorized MCP tools when current tools lack a capability. Search by the desired action, subject or service name. Returned definitions become callable on the NEXT turn. Do not guess hidden tool names. Discovery may be limited by context budget.",
        // 注册表有状态；与同批工具顺序执行，避免改变下一轮目录时发生竞态。
        readonly: false, idempotent: true,
        parameters: { query: stringParameter(500) },
        async execute({ query }, signal) {
            signal?.throwIfAborted();
            const current = registry.definitions();
            const names = new Set(current.map(tool => tool.name));
            const candidates = rankTools(catalog.filter(tool => tool.source?.type === "mcp" && !names.has(tool.definition.name)), query)
                .filter(entry => entry.score > 0).map(entry => entry.tool);
            const selection = selectTools(candidates, query, instructions, config, tokens,
                { limit, reservedDefinitions: current, budgetQuestion: question });
            for (const tool of selection.tools) registry.register(tool);
            return JSON.stringify({ tools: selection.tools.map(tool => tool.definition), omitted: selection.omitted,
                notice: "Use the returned names and schemas on the next turn. No matching tools fit when tools is empty." });
        },
    });
}
