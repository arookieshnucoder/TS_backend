import type { Logger } from "../../common/logging/logger.js";
import type { AgentInstructions, AgentResult, AgentWorkflow } from "../agent/contracts.js";
import type { AgentModel } from "../agent/model.js";
import { AgentHarness, type HarnessInput, type HarnessOptions, type HarnessRunner } from "../harness/agent-harness.js";
import type { ContextConfig } from "../harness/context/config.js";
import { TokenBudget } from "../harness/context/tokens.js";
import { defineReadOnlyTool, integerParameter } from "../harness/define-tool.js";
import { ToolInputError } from "../harness/tool-contracts.js";
import { fullPassageEvidence, type PassageEvidence, type PassageTask, type PassageVariant } from "./contracts.js";

/** 学科提供题目格式、证据选取和输出元信息，公共层统一工具与预算。 */
export interface PassagePolicy {
    subject: "reading" | "english";
    questions: string;
    contextTokens: number;
    pack(evidence: PassageEvidence, full: PassageEvidence): string;
    selectEvidence(query: string, budget: number, tokens: TokenBudget): PassageEvidence;
}

/** 阅读类任务的公共宿主：准备原文、按段补读、检查上下文和工具输出预算。 */
export class PassageHarness implements HarnessRunner {
    private readonly inner: AgentHarness;
    private readonly tokens: TokenBudget;

    constructor(model: AgentModel, workflow: AgentWorkflow, private readonly instructions: AgentInstructions,
        private readonly task: PassageTask, private readonly variant: PassageVariant, private readonly config: ContextConfig,
        logger: Logger, private readonly policy: PassagePolicy, options: HarnessOptions = {}) {
        this.tokens = new TokenBudget(config);
        this.inner = new AgentHarness(model, workflow, instructions, config, logger, { ...options, toolOutputTokens: 8192 });
    }

    async run(input: HarnessInput, signal?: AbortSignal): Promise<AgentResult> {
        const { task, policy, variant } = this;
        const question = policy.questions + (input.question && input.question !== policy.questions ? `\n[当前要求]\n${input.question}` : "");
        const full = fullPassageEvidence(task.passage);
        const prepareName = `${policy.subject}_prepare`, lookupName = `${policy.subject}_lookup`;
        const prepareId = `${policy.subject}-prepare-1`;

        return this.inner.run({
            ...input, question, evidence: { title: task.passage.title, original: full }, historyPolicy: "full", proactiveTools: false,
            tools: async ({ compression }) => {
                const lookup = defineReadOnlyTool({
                    name: lookupName,
                    description: "按 P 段号补读当前原文，每次读取连续 1 至 3 段；保留原段号，不返回参考答案。",
                    parameters: {
                        startParagraph: integerParameter(1, full.paragraphs.length),
                        endParagraph: integerParameter(1, full.paragraphs.length),
                    },
                    validate({ startParagraph, endParagraph }) {
                        if (endParagraph < startParagraph || endParagraph - startParagraph > 2)
                            throw new ToolInputError("Read 1..3 consecutive paragraphs");
                    },
                    async execute({ startParagraph, endParagraph }, scope) {
                        scope?.throwIfAborted();
                        return JSON.stringify({ passageId: task.passage.id,
                            paragraphs: full.paragraphs.slice(startParagraph - 1, endParagraph), totalParagraphs: full.paragraphs.length });
                    },
                });
                const prepare = defineReadOnlyTool({
                    name: prepareName, description: "按宿主配置准备当前原文证据；摘要仅供辅助，不返回题库参考答案。", parameters: {},
                    execute: async (_args, scope) => {
                        const pack = (evidence: PassageEvidence) => policy.pack(evidence, full);
                        const definitions = variant === "adaptive" ? [prepare.definition, lookup.definition] : [];
                        // 计算实际消息封装和工具定义；一次作答的策略无需预留补读工具空间。
                        const size = (evidence: PassageEvidence) => this.tokens.count(JSON.stringify([
                            { role: "system", content: `${this.instructions.system}\n${this.instructions.final}` },
                            { role: "user", content: question },
                            { role: "assistant", content: "先获取题目证据和条件检查。", toolCalls: [{ id: prepareId, name: prepareName, arguments: {} }] },
                            { role: "tool", toolCallId: prepareId, content: pack(evidence) },
                        ])) + this.tokens.count(JSON.stringify(definitions)) + 64;
                        const threshold = Math.floor(this.config.maxInputTokens * this.config.compressionTrigger) - 128;
                        const available = Math.min(7600, Math.floor((threshold - size({ paragraphs: [], omitted: full.paragraphs.length })) * .8));
                        if (available < 128) throw new ToolInputError("Questions exceed passage context budget");
                        const budget = Math.min(policy.contextTokens, available);
                        const fits = (evidence: PassageEvidence) => size(evidence) <= threshold && this.tokens.count(pack(evidence)) <= 8192;
                        let evidence: PassageEvidence;

                        // 自适应策略只在全文确实放不下时裁剪；full 策略超限时直接报错。
                        if (variant === "full" || variant === "adaptive" && fits(full)) {
                            if (!fits(full)) throw new ToolInputError("Full original exceeds context; use adaptive or split the passage");
                            evidence = full;
                        } else if (variant === "summary") {
                            evidence = { paragraphs: [], omitted: full.paragraphs.length,
                                summary: await compression.execute({ text: JSON.stringify(full), budget: Math.max(64, budget - 128) }, scope) };
                        } else {
                            evidence = policy.selectEvidence(question, variant === "hybrid" ? Math.floor(budget * .75) : budget, this.tokens);
                            if (variant === "hybrid") evidence.summary = await compression.execute({ text: JSON.stringify(full), budget: Math.max(64, Math.floor(budget * .2)) }, scope);
                        }
                        if (!fits(evidence)) throw new ToolInputError("Prepared evidence exceeds passage context budget");
                        const output = pack(evidence);
                        input.onEvent?.(`${policy.subject}.context`, { variant, originalTokens: this.tokens.count(JSON.stringify(full)),
                            retainedTokens: this.tokens.count(output), retainedParagraphs: evidence.paragraphs.map(paragraph => paragraph.id),
                            totalParagraphs: full.paragraphs.length, completeOriginal: evidence === full, summary: !!evidence.summary });
                        return output;
                    },
                });
                return variant === "adaptive" ? [prepare, lookup] : [prepare];
            },
            initialCalls: [{ id: prepareId, name: prepareName, arguments: {} }],
        }, signal);
    }
}
