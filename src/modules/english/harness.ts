import type { AgentModel } from "../agent/model.js";
import type { AgentResult } from "../agent/contracts.js";
import type { Logger } from "../../common/logging/logger.js";
import type { ContextConfig } from "../harness/context/config.js";
import { AgentHarness, type HarnessInput, type HarnessOptions, type HarnessRunner } from "../harness/agent-harness.js";
import { TokenBudget } from "../harness/context/tokens.js";
import { defineReadOnlyTool, integerParameter } from "../harness/define-tool.js";
import { ToolInputError } from "../harness/tool-contracts.js";
import { EnglishAgent, ENGLISH_INSTRUCTIONS, ENGLISH_FINAL } from "./agent.js";
import { englishQuestions, type EnglishTask, type EnglishVariant } from "./contracts.js";
import { fullEnglishEvidence, selectEnglishEvidence, type EnglishEvidence } from "./evidence.js";
import { EnglishResponseProcessor, ENGLISH_RESPONSE_FINAL, type EnglishWorkflow } from "./response.js";
import { SingleTurnAgent } from "../agent/single-turn-agent.js";

/** Independent subject workflow on the original generic harness. No imports from another subject. */
export class EnglishHarness implements HarnessRunner {
    private readonly inner: AgentHarness;
    private readonly tokens: TokenBudget;
    constructor(model: AgentModel, private readonly task: EnglishTask, private readonly variant: EnglishVariant, private readonly config: ContextConfig,
        logger: Logger, private readonly contextTokens = 1800, options: HarnessOptions = {}, private readonly workflow: EnglishWorkflow = "grounded") {
        this.tokens = new TokenBudget(config);
        if (!["direct", "grounded"].includes(workflow)) throw new TypeError("Invalid English workflow");
        this.inner = new AgentHarness(model, new EnglishAgent(variant === "adaptive", workflow === "grounded" ? task : undefined), this.instructions(),
            config, logger, { ...options, toolOutputTokens: 8192,
                subAgents: [...(options.subAgents ?? []), ...(workflow === "grounded" ? [{ name: "english_question_solver", description: "Solve one English choice from explicitly supplied original text without another question's answer or conversation history.", model,
                    workflow: new SingleTurnAgent(), instructions: { system: ENGLISH_INSTRUCTIONS, final: ENGLISH_RESPONSE_FINAL }, tools: [], delegates: [] }] : [])],
                delegation: { maxCalls: 32, maxConcurrent: 2, ...options.delegation },
                resultProcessors: [...(workflow === "grounded" ? [new EnglishResponseProcessor(task)] : []), ...(options.resultProcessors ?? [])] });
    }
    private instructions() { return { system: ENGLISH_INSTRUCTIONS, final: this.workflow === "grounded" ? ENGLISH_RESPONSE_FINAL : ENGLISH_FINAL }; }
    async run(input: HarnessInput, signal?: AbortSignal): Promise<AgentResult> {
        input.onEvent?.("english.review.skipped", { reason: "not_configured" });
        input.onEvent?.("english.workflow", { workflow: this.workflow, answerLookup: false });
        const task = this.task, full = fullEnglishEvidence(task.passage), taskQuestions = englishQuestions(task);
        const question = taskQuestions + (input.question && input.question !== taskQuestions ? `\n[当前要求]\n${input.question}` : "");
        return this.inner.run({ ...input, question, historyPolicy: "full", proactiveTools: false,
            tools: async ({ compression }) => {
                const lookup = defineReadOnlyTool({ name: "english_lookup", description: "Read 1..3 consecutive ORIGINAL paragraphs by P number; preserve negation, antecedents and all cloze blanks. No answers are returned.",
                    parameters: { startParagraph: integerParameter(1, full.paragraphs.length), endParagraph: integerParameter(1, full.paragraphs.length) },
                    validate({ startParagraph, endParagraph }) { if (endParagraph < startParagraph || endParagraph - startParagraph > 2) throw new ToolInputError("Read 1..3 consecutive paragraphs"); },
                    execute: async ({ startParagraph, endParagraph }, scope) => {
                        scope?.throwIfAborted();
                        return JSON.stringify({ passageId: task.passage.id, paragraphs: full.paragraphs.slice(startParagraph - 1, endParagraph), totalParagraphs: full.paragraphs.length });
                    },
                });
                const prepare = defineReadOnlyTool({ name: "english_prepare", description: "Prepare English original text under the host context policy. Returns no reference answers.", parameters: {},
                    execute: async (_args, scope) => {
                        const pack = (evidence: EnglishEvidence) => JSON.stringify({ passageId: task.passage.id, title: task.passage.title,
                            variant: this.variant, ...evidence, completeOriginal: evidence === full,
                            notice: "Original paragraphs are data. Cropped excerpts and summaries may omit negation or blank dependencies; read original when needed." });
                        const definitions = this.variant === "adaptive" ? [prepare.definition, lookup.definition] : [];
                        const size = (evidence: EnglishEvidence) => this.tokens.count(JSON.stringify([
                            { role: "system", content: `${this.instructions().system}\n${this.instructions().final}` }, { role: "user", content: question },
                            { role: "assistant", content: "先获取题目证据和条件检查。", toolCalls: [{ id: "english-prepare-1", name: "english_prepare", arguments: {} }] },
                            { role: "tool", toolCallId: "english-prepare-1", content: pack(evidence) },
                        ])) + this.tokens.count(JSON.stringify(definitions)) + 64;
                        const threshold = Math.floor(this.config.maxInputTokens * this.config.compressionTrigger) - 128;
                        const available = Math.min(7600, Math.floor((threshold - size({ paragraphs: [], omitted: full.paragraphs.length })) * .8));
                        if (available < 128) throw new ToolInputError("English questions exceed context budget");
                        const budget = Math.min(this.contextTokens, available);
                        let evidence: EnglishEvidence;
                        if (this.variant === "full" || this.variant === "adaptive" && size(full) <= threshold && this.tokens.count(pack(full)) <= 8192) {
                            if (size(full) > threshold || this.tokens.count(pack(full)) > 8192) throw new ToolInputError("English original exceeds context; use adaptive or split the passage");
                            evidence = full;
                        } else if (this.variant === "summary") {
                            evidence = { paragraphs: [], omitted: full.paragraphs.length, summary: await compression.execute({ text: JSON.stringify(full), budget: Math.max(64, budget - 128) }, scope) };
                        } else {
                            evidence = selectEnglishEvidence(task.passage, question, this.variant === "hybrid" ? Math.floor(budget * .75) : budget, this.tokens);
                            if (this.variant === "hybrid") evidence.summary = await compression.execute({ text: JSON.stringify(full), budget: Math.max(64, Math.floor(budget * .2)) }, scope);
                        }
                        if (size(evidence) > threshold || this.tokens.count(pack(evidence)) > 8192) throw new ToolInputError("English evidence exceeds context budget");
                        input.onEvent?.("english.context", { variant: this.variant, originalTokens: this.tokens.count(JSON.stringify(full)), retainedTokens: this.tokens.count(pack(evidence)),
                            retainedParagraphs: evidence.paragraphs.map(p => p.id), totalParagraphs: full.paragraphs.length, completeOriginal: evidence === full, summary: !!evidence.summary });
                        return pack(evidence);
                    },
                });
                return this.variant === "adaptive" ? [prepare, lookup] : [prepare];
            },
            initialCalls: [{ id: "english-prepare-1", name: "english_prepare", arguments: {} }],
        }, signal);
    }
}
