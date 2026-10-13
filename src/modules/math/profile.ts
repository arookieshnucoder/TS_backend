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
export function createMathProfile(variant: MathVariant, rag: MathRag, model: AgentModel, config: ContextConfig, logger: Logger, options: HarnessOptions = {}) {
    const specialized = variant === "agent" || variant === "combined";
    const enhanced = variant === "harness" || variant === "combined";
    const harness = new AgentHarness(model, specialized ? new MathAgent(enhanced,enhanced?verifiedSolution:undefined) : new AskAgent(), {
        system: specialized ? MATH_INSTRUCTIONS : ASK_INSTRUCTIONS,
        final: specialized ? "独立求解并核对原条件、选项和端点，给出清晰的最终答案。" : FINAL_INSTRUCTIONS,
    }, config, logger, options);
    return { harness: enhanced ? new MathRetrievalHarness(harness, rag) : harness, mode: enhanced ? "hybrid" as const : "dense" as const };
}
