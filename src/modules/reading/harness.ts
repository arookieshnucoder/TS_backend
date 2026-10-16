import type { AgentModel } from "../agent/model.js";
import type { AgentResult } from "../agent/contracts.js";
import type { Logger } from "../../common/logging/logger.js";
import { AgentHarness, type HarnessInput, type HarnessOptions, type HarnessRunner } from "../harness/agent-harness.js";
import type { ContextConfig } from "../harness/context/config.js";
import { TokenBudget } from "../harness/context/tokens.js";
import { defineReadOnlyTool, integerParameter } from "../harness/define-tool.js";
import { ToolInputError } from "../harness/tool-contracts.js";
import { ReadingAgent, READING_INSTRUCTIONS, READING_FINAL } from "./agent.js";
import { readingQuestions, type ReadingTask, type ReadingVariant } from "./contracts.js";
import { fullReadingEvidence, selectReadingEvidence, type ReadingEvidence } from "./evidence.js";

/** Domain wrapper only: generic context compression, math workflows and math budgets remain unchanged. */
export class ReadingHarness implements HarnessRunner {
    private readonly inner: AgentHarness;
    private readonly tokens: TokenBudget;
    constructor(model: AgentModel, private readonly task: ReadingTask, private readonly variant: ReadingVariant,
        private readonly config: ContextConfig, logger: Logger, private readonly contextTokens = 1400, options: HarnessOptions = {}) {
        this.tokens = new TokenBudget(config);
        this.inner = new AgentHarness(model, new ReadingAgent(variant === "adaptive"), {
            system: READING_INSTRUCTIONS, final: READING_FINAL,
        }, config, logger, { ...options, toolOutputTokens: 8192 });
    }
    async run(input: HarnessInput, signal?: AbortSignal): Promise<AgentResult> {
        const task = this.task;
        const taskQuestions = readingQuestions(task);
        const question = taskQuestions + (input.question && input.question !== taskQuestions ? `\n[当前要求]\n${input.question}` : "");
        const full = fullReadingEvidence(task.passage);
        return this.inner.run({
            ...input, question, historyPolicy: "full", proactiveTools: false,
            tools: async ({ compression }) => {
                const lookup = defineReadOnlyTool({
                    name: "reading_lookup", description: "按本篇文章的P编号找回连续原文段落，最多3段；原段号保留。只查本轮原文，不返回题库参考答案。",
                    parameters: { startParagraph: integerParameter(1, task.passage.paragraphs.length), endParagraph: integerParameter(1, task.passage.paragraphs.length) },
                    validate({ startParagraph, endParagraph }) {
                        if (endParagraph < startParagraph || endParagraph - startParagraph > 2) throw new ToolInputError("Request 1..3 consecutive paragraphs");
                    },
                    async execute({ startParagraph, endParagraph }, scope) {
                        scope?.throwIfAborted();
                        return JSON.stringify({ passageId: task.passage.id, paragraphs: full.paragraphs.slice(startParagraph - 1, endParagraph), totalParagraphs: full.paragraphs.length });
                    },
                });
                const prepare = defineReadOnlyTool({
                    name: "reading_prepare", description: "获取当前阅读文章的初始上下文；按宿主选择的保留/压缩策略处理，绝不提供参考答案。", parameters: {},
                    execute: async (_args, scope) => {
                        const metadata = { passageId: task.passage.id, title: task.passage.title, variant: this.variant,
                            headings: task.passage.headings ?? [], totalParagraphs: full.paragraphs.length,
                            source: task.passage.source.urls[0]?.startsWith("https://") ? task.passage.source.urls[0] : "当前会话提供的原文",
                            notice: "P定位正文；片段不代表整段。摘要仅辅助，精确措辞以原文为准。" };
                        const pack = (evidence: ReadingEvidence) => JSON.stringify({ ...metadata, ...evidence,
                            ...(this.variant === "adaptive" ? { completeOriginal: evidence === full } : {}) });
                        const definitions = this.variant === "adaptive" ? [prepare.definition, lookup.definition] : [];
                        // Count the actual JSON message envelope, including escaped tool content and final-turn instructions.
                        // One-shot variants advertise no tools to the solver, so their budget must not reserve unused schemas.
                        const size = (evidence: ReadingEvidence) => this.tokens.count(JSON.stringify([
                            { role: "system", content: `${READING_INSTRUCTIONS}\n${READING_FINAL}` }, { role: "user", content: question },
                            { role: "assistant", content: "先获取题目证据和条件检查。", toolCalls: [{ id: "reading-prepare-1", name: "reading_prepare", arguments: {} }] },
                            { role: "tool", toolCallId: "reading-prepare-1", content: pack(evidence) },
                        ])) + this.tokens.count(JSON.stringify(definitions)) + 64;
                        const threshold = Math.floor(this.config.maxInputTokens * this.config.compressionTrigger) - 128;
                        const available = Math.min(7600, Math.floor((threshold - size({ paragraphs: [], omitted: full.paragraphs.length })) * .8));
                        if (available < 128) throw new ToolInputError("Question exceeds reading context budget");
                        const budget = Math.min(this.contextTokens, available);
                        let evidence: ReadingEvidence;
                        const fullTokens = this.tokens.count(JSON.stringify(full));
                        // Adaptive preserves complete original text whenever it fits the actual context, not merely the compression target.
                        if (this.variant === "full" || this.variant === "adaptive" && size(full) <= threshold && this.tokens.count(pack(full)) <= 8192) {
                            if (size(full) > threshold || this.tokens.count(pack(full)) > 8192) throw new ToolInputError("Full article exceeds context; select a compression variant or increase the input budget");
                            evidence = full;
                        } else if (this.variant === "summary") {
                            evidence = { summary: await compression.execute({ text: JSON.stringify(full), budget: Math.max(64, budget - 128) }, scope), paragraphs: [], omitted: full.paragraphs.length };
                        } else {
                            evidence = selectReadingEvidence(task.passage, question, this.variant === "hybrid" ? Math.floor(budget * .75) : budget, this.tokens);
                            if (this.variant === "hybrid") evidence.summary = await compression.execute({ text: JSON.stringify(full), budget: Math.max(64, Math.floor(budget * .20)) }, scope);
                        }
                        const output = pack(evidence);
                        if (size(evidence) > threshold || this.tokens.count(output) > 8192) throw new ToolInputError("Prepared evidence exceeds reading budget");
                        input.onEvent?.("reading.context", { variant: this.variant, originalTokens: fullTokens, retainedTokens: this.tokens.count(output),
                            retainedParagraphs: evidence.paragraphs.map(paragraph => paragraph.id), totalParagraphs: full.paragraphs.length, summary: !!evidence.summary });
                        return output;
                    },
                });
                // Both tools are declared once. Preparation goes through the same limits/retry/trace as ordinary calls.
                return this.variant === "adaptive" ? [prepare, lookup] : [prepare];
            },
            initialCalls: [{ id: "reading-prepare-1", name: "reading_prepare", arguments: {} }],
        }, signal);
    }
}
