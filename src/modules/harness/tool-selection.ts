import type { RegisteredTool } from "./tool-contracts.js";
import type { TokenBudget } from "./context/tokens.js";
import type { ContextConfig } from "./context/config.js";
import type { AgentInstructions, ToolDefinition } from "../agent/contracts.js";

/** External catalogs must not crowd out existing custom tools or the user's question. */
export function rankTools(tools: RegisteredTool[], question: string) {
    const lower = question.toLowerCase();
    const terms = [...new Set([...(lower.match(/[a-z0-9_-]{2,}/g) ?? []), ...(lower.match(/[\u3400-\u9fff]{2,}/g) ?? []).flatMap(word =>
        Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)))])].slice(0, 64);
    const score = (tool: RegisteredTool) => {
        const description = `${tool.source?.serverId ?? ""} ${tool.source?.toolName ?? ""} ${tool.definition.description}`.toLowerCase();
        return terms.reduce((value, term) => value + (description.includes(term) ? term.length : 0), 0);
    };
    return tools.map((tool, index) => ({ tool, index, score: score(tool) })).sort((a, b) => b.score - a.score || a.index - b.index);
}

export function selectTools(tools: RegisteredTool[], question: string, instructions: AgentInstructions, config: ContextConfig, tokens: TokenBudget,
    options: { limit?: number; reservedDefinitions?: ToolDefinition[]; budgetQuestion?: string } = {}) {
    const { limit = 64, reservedDefinitions = [], budgetQuestion = question } = options;
    const custom = tools.filter(t => t.source?.type !== "mcp");
    const external = tools.filter(t => t.source?.type === "mcp");
    if (!external.length) return { tools, omitted: 0, budgetTokens: 0 };
    const customDefinitions = [...reservedDefinitions, ...custom.map(t => t.definition)];
    const customTokens = tokens.count(JSON.stringify(customDefinitions));
    const base = tokens.count(JSON.stringify([{ role: "system", content: `${instructions.system}\n${instructions.final}` }, { role: "user", content: budgetQuestion }])) + customTokens + 64;
    const budget = Math.max(0, Math.min(Math.floor(config.maxInputTokens * .25), Math.floor(config.maxInputTokens * config.compressionTrigger) - base - 128));
    const ranked = rankTools(external, question);
    const selected: RegisteredTool[] = [];
    for (const { tool } of ranked) {
        if (selected.length >= limit) break;
        const size = tokens.count(JSON.stringify([...customDefinitions, ...selected.map(t => t.definition), tool.definition])) - customTokens;
        if (size <= budget) selected.push(tool);
    }
    return { tools: [...custom, ...selected], omitted: external.length - selected.length, budgetTokens: budget };
}
