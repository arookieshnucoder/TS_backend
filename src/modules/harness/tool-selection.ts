import type { RegisteredTool } from "./tool-registry.js";
import type { TokenBudget } from "./context/tokens.js";
import type { ContextConfig } from "./context/config.js";
import type { AgentInstructions } from "../agent/contracts.js";

/** External catalogs must not crowd out existing custom tools or the user's question. */
export function selectTools(tools: RegisteredTool[], question: string, instructions: AgentInstructions, config: ContextConfig, tokens: TokenBudget) {
    const custom = tools.filter(t => t.source?.type !== "mcp");
    const external = tools.filter(t => t.source?.type === "mcp");
    if (!external.length) return { tools, omitted: 0, budgetTokens: 0 };
    const customDefinitions = custom.map(t => t.definition);
    const customTokens = tokens.count(JSON.stringify(customDefinitions));
    const base = tokens.count(JSON.stringify([{ role: "system", content: `${instructions.system}\n${instructions.final}` }, { role: "user", content: question }])) + customTokens + 64;
    const budget = Math.max(0, Math.min(Math.floor(config.maxInputTokens * .25), Math.floor(config.maxInputTokens * config.compressionTrigger) - base - 128));
    const lower = question.toLowerCase();
    const terms = [...new Set([...(lower.match(/[a-z0-9_-]{2,}/g) ?? []), ...(lower.match(/[\u3400-\u9fff]{2,}/g) ?? []).flatMap(word =>
        Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)))])].slice(0, 64);
    const score = (tool: RegisteredTool) => {
        const description = `${tool.source?.toolName ?? ""} ${tool.definition.description}`.toLowerCase();
        return terms.reduce((value, term) => value + (description.includes(term) ? term.length : 0), 0);
    };
    const ranked = external.map((tool, index) => ({ tool, index, score: score(tool) })).sort((a, b) => b.score - a.score || a.index - b.index);
    const selected: RegisteredTool[] = [];
    for (const { tool } of ranked) {
        if (selected.length >= 64) break;
        const size = tokens.count(JSON.stringify([...customDefinitions, ...selected.map(t => t.definition), tool.definition])) - customTokens;
        if (size <= budget) selected.push(tool);
    }
    return { tools: [...custom, ...selected], omitted: external.length - selected.length, budgetTokens: budget };
}
