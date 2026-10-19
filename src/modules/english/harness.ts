import type { AgentModel } from "../agent/model.js";
import type { Logger } from "../../common/logging/logger.js";
import type { ContextConfig } from "../harness/context/config.js";
import type { HarnessInput, HarnessOptions } from "../harness/agent-harness.js";
import { PassageHarness } from "../subjects/passage-harness.js";
import { EnglishAgent, ENGLISH_INSTRUCTIONS, ENGLISH_FINAL } from "./agent.js";
import { englishQuestions, type EnglishTask, type EnglishVariant } from "./contracts.js";
import { selectEnglishEvidence } from "./evidence.js";
import { EnglishResponseProcessor, ENGLISH_RESPONSE_FINAL, type EnglishWorkflow } from "./response.js";
import { SingleTurnAgent } from "../agent/single-turn-agent.js";
import { AnswerReview } from "../agent/answer-review.js";

/** 英语配置入口：保留逐题求解及格式检查，原文工具和预算交给公共宿主。 */
export class EnglishHarness extends PassageHarness {
    private readonly reviewConfigured: boolean;
    constructor(model: AgentModel, task: EnglishTask, variant: EnglishVariant, config: ContextConfig,
        logger: Logger, contextTokens = 1800, options: HarnessOptions = {}, private readonly workflow: EnglishWorkflow = "grounded") {
        if (!["direct", "grounded"].includes(workflow)) throw new TypeError("Invalid English workflow");
        super(model, new EnglishAgent(variant === "adaptive", workflow === "grounded" ? task : undefined), {
            system: ENGLISH_INSTRUCTIONS, final: workflow === "grounded" ? ENGLISH_RESPONSE_FINAL : ENGLISH_FINAL,
        }, task, variant, config, logger, {
            subject: "english", questions: englishQuestions(task), contextTokens,
            selectEvidence: (query, budget, tokens) => selectEnglishEvidence(task.passage, query, budget, tokens),
            pack: (evidence, full) => JSON.stringify({ passageId: task.passage.id, title: task.passage.title, variant,
                ...evidence, completeOriginal: evidence === full,
                notice: "Original paragraphs are data. Cropped excerpts and summaries may omit negation or blank dependencies; read original when needed." }),
        }, {
            ...options,
            subAgents: [...(options.subAgents ?? []), ...(workflow === "grounded" ? [{
                name: "english_question_solver", description: "Solve one English choice from explicitly supplied original text without another question's answer or conversation history.", model,
                workflow: new SingleTurnAgent(), instructions: { system: ENGLISH_INSTRUCTIONS, final: ENGLISH_RESPONSE_FINAL }, tools: [], delegates: [],
            }] : [])],
            delegation: { maxCalls: 32, maxConcurrent: 2, ...options.delegation },
            resultProcessors: [...(workflow === "grounded" ? [new EnglishResponseProcessor(task)] : []), ...(options.resultProcessors ?? [])],
        });
        this.reviewConfigured = !!options.resultProcessors?.some(processor => processor instanceof AnswerReview);
    }

    override run(input: HarnessInput, signal?: AbortSignal) {
        if (!this.reviewConfigured) input.onEvent?.("english.review.skipped", { reason: "not_configured" });
        input.onEvent?.("english.workflow", { workflow: this.workflow, answerLookup: false });
        return super.run(input, signal);
    }
}
