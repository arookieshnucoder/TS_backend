import type { AgentMessage } from "../agent/contracts.js";
import type { HarnessInput } from "./agent-harness.js";
import type { ContextConfig } from "./context/config.js";
import type { TokenBudget } from "./context/tokens.js";
import type { RegisteredTool } from "./tool-contracts.js";
import { historyEvidence, historyEvidenceTool } from "./history-evidence.js";
import { normalizeQuestionLabels } from "../math/normalize.js";

/** 单次运行的历史选择策略。保存的原文不改写；取证与压缩各有一个明确入口。 */
export function prepareRun(input: HarnessInput, supplied: RegisteredTool[], config: ContextConfig, tokens: TokenBudget,
    event: (name: string, fields: Record<string, unknown>) => void) {
    const hasTool = (name: string) => supplied.some(tool => tool.definition.name === name);
    const tools = input.history.length && !hasTool("history_lookup") ?
        [...supplied, historyEvidenceTool(input.history, Math.min(5000, Math.floor(config.maxInputTokens * .10)))] : [...supplied];

    let historyTokens = 0;
    if (input.historyPolicy === undefined) {
        for (const message of input.history) {
            historyTokens += tokens.count(message.content);
            if (historyTokens > config.maxInputTokens * .35) break;
        }
    }
    const useEvidence = input.historyPolicy === "evidence" || historyTokens > config.maxInputTokens * .35;
    const evidence = useEvidence ? historyEvidence(input.history, input.question, Math.min(9000, Math.floor(config.maxInputTokens * .25))) : undefined;
    if (evidence) event("context.evidence_selected", { retained: evidence.indices, omitted: evidence.omitted });
    const prefetchHistory = input.proactiveTools !== false && input.history.length > 0 &&
        /之前|前面|刚才|上题|第\d+题|更正|earlier|previous/i.test(normalizeQuestionLabels(input.question)) &&
        tools.some(tool => tool.definition.name === "history_lookup");
    // 工具已经提供原文时不重复注入同一证据，否则会再次触发有损压缩。
    const history: AgentMessage[] = evidence && prefetchHistory ? [] :
        evidence?.messages ?? input.history.map(({ role, content }) => ({ role, content }));
    return { tools, history, prefetchHistory };
}
