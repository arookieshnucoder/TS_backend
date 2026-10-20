import type { AppConfig } from "../config/env.js";
import type { AgentModel } from "../modules/agent/model.js";
import type { ChatAgent } from "../modules/chat/service/chat-agent.js";
import type { Logger } from "../common/logging/logger.js";
import type { HarnessOptions } from "../modules/harness/agent-harness.js";
import { AgentHarness } from "../modules/harness/agent-harness.js";
import { AskAgent } from "../modules/agent/ask-agent.js";
import { MATH_INSTRUCTIONS } from "../modules/math/agent.js";
import { mathAnalyzeTool, mathCalculateTool } from "../modules/math/task-tools.js";
import { subjectHistory } from "./school-subject.js";
import { withAnswerReview, mathReviewEvidence } from "./answer-review.js";
import { SingleTurnAgent } from "../modules/agent/single-turn-agent.js";
import { elementaryArithmetic, elementaryEquation } from "../modules/math/fast-path.js";
/** Used by offline corpus/index evaluations only. */
export function mathEmbeddingConfig(config: AppConfig) {
    const key = config.context.embeddingApiKey;
    if (!key && config.llmApiKey && config.math.embeddingBaseUrl.replace(/\/$/, "") !== config.llmBaseUrl?.replace(/\/$/, ""))
        throw new Error("A different mathematics embedding endpoint requires EMBEDDING_API_KEY");
    return { ...config, llmBaseUrl: config.math.embeddingBaseUrl, llmApiKey: key ?? config.llmApiKey };
}
export function createMathChatAgent(model: AgentModel, config: AppConfig, logger: Logger, options: HarnessOptions = config.harness, reviewer?: AgentModel, fastModel: AgentModel = model): ChatAgent {
    if (config.math.variant === "general") throw new TypeError("Math agent requires a mathematics variant");
    // Runtime solving has no bank, vector index or submission-bank dependency.
    const harness = new AgentHarness(model, new AskAgent(), { system: MATH_INSTRUCTIONS,
        final: "根据当前题目独立求解全部子问，核对适用条件和最新更正，给出关键推导与最终答案。" }, config.context, logger,
        withAnswerReview(options, model, reviewer, config, "math", mathReviewEvidence));
    const elementaryHarness = new AgentHarness(fastModel, new SingleTurnAgent(), { system: MATH_INSTRUCTIONS,
        final: "依据当前题目及计算工具的实际结果，简洁输出必要推导、验算和答案，不超过5行。方程须将根代回原等式检验。" }, config.context, logger,
        withAnswerReview({ ...options, skills: undefined }, fastModel, reviewer, config, "math", mathReviewEvidence));
    return {
        async run(session, current, signal, context) {
            signal?.throwIfAborted();
            const arithmetic = elementaryArithmetic(current.content);
            const elementary = arithmetic ?? elementaryEquation(current.content);
            if (elementary) {
                context?.event("math.fast_path", { reason: arithmetic ? "elementary_arithmetic" : "elementary_equation", independentReview: !!reviewer });
                return elementaryHarness.run({ history: subjectHistory(session.messages, "math").map(({ role, content }) => ({ role, content })), question: current.content.trim(), tools: [mathCalculateTool()],
                    initialCalls: [{ id: "elementary-check-1", name: "math_calculate", arguments: { expression: elementary.expression } }],
                    proactiveTools: false, metadata: { sessionId: session.id, messageId: current.id, runId: context?.runId, subject: "math" }, onEvent: context?.event }, signal);
            }
            return harness.run({ history: subjectHistory(session.messages, "math").map(({ role, content }) => ({ role, content })), question: current.content.trim(),
                tools: [mathAnalyzeTool(), mathCalculateTool()], metadata: { sessionId: session.id, messageId: current.id, runId: context?.runId, subject: "math" }, onEvent: context?.event, deferMaintenance: context?.deferMaintenance }, signal);
        },
        async titleFor(session) {
            const text = session.messages.find(message => message.role === "user")?.content;
            return text ? `数学 · ${text.replace(/\s+/g, " ").slice(0, 28)}` : session.title;
        },
    };
}
