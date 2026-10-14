import type { AgentModel } from "../agent/model.js";
import { AskAgent } from "../agent/ask-agent.js";
import { ASK_INSTRUCTIONS, FINAL_INSTRUCTIONS } from "../agent/prompt.js";
import { AgentHarness, type HarnessOptions } from "../harness/agent-harness.js";
import type { ContextConfig } from "../harness/context/config.js";
import type { Logger } from "../../common/logging/logger.js";
import type { MathVariant } from "./contracts.js";
import { MathAgent, MATH_INSTRUCTIONS } from "./agent.js";
import { MathRetrievalHarness } from "./harness.js";
import { MathRag } from "./rag.js";
import { verifiedSolution } from './verified-solution.js';
import { EvidenceMathAgent, OptimizedMathHarness } from "./optimized.js";
export function createMathProfile(variant: MathVariant, rag: MathRag, model: AgentModel, config: ContextConfig, logger: Logger, options: HarnessOptions = {}) {
    if(["lexical","rerank","memory","batch","adaptive"].includes(variant)) {
        const harness=new AgentHarness(model,new EvidenceMathAgent(variant==="adaptive"),{
            system:MATH_INSTRUCTIONS+"\n长对话中用户最新的明确条件更正覆盖旧值，助手历史结论需重新核验。若旧题原文缺失，明确说明。多题按第n题逐题作答，最后各给一行‘第n题答案：X’；所有子问都需回答。",
            final:"证据已经预取。独立求解当前题，逐个检查子问和条件，依据当前选项输出最终答案。"},config,logger,{...options,toolOutputTokens:Math.max(options.toolOutputTokens??2048,Math.min(8000,Math.floor(config.maxInputTokens*.4)))});
        return {harness:new OptimizedMathHarness(harness,rag,variant),mode:variant==="lexical"?"lexical" as const:"rerank" as const};
    }
    const specialized = variant === "agent" || variant === "combined";
    const enhanced = variant === "harness" || variant === "combined";
    const harness = new AgentHarness(model, specialized ? new MathAgent(enhanced,enhanced?verifiedSolution:undefined) : new AskAgent(), {
        system: specialized ? MATH_INSTRUCTIONS : ASK_INSTRUCTIONS,
        final: specialized ? "独立求解并核对原条件、选项和端点，给出清晰的最终答案。" : FINAL_INSTRUCTIONS,
    }, config, logger, options);
    return { harness: enhanced ? new MathRetrievalHarness(harness, rag) : harness, mode: enhanced ? "hybrid" as const : "dense" as const };
}
