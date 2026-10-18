import type { AgentModel } from "../agent/model.js";
import type { Logger } from "../../common/logging/logger.js";
import type { HarnessOptions } from "../harness/agent-harness.js";
import type { ContextConfig } from "../harness/context/config.js";
import { PassageHarness } from "../subjects/passage-harness.js";
import { ReadingAgent, READING_INSTRUCTIONS, READING_FINAL } from "./agent.js";
import { readingQuestions, type ReadingTask, type ReadingVariant } from "./contracts.js";
import { selectReadingEvidence } from "./evidence.js";

/** 语文配置入口：提供标题作者信息、中文选句规则和阅读作答策略。 */
export class ReadingHarness extends PassageHarness {
    constructor(model: AgentModel, task: ReadingTask, variant: ReadingVariant,
        config: ContextConfig, logger: Logger, contextTokens = 1400, options: HarnessOptions = {}) {
        super(model, new ReadingAgent(variant === "adaptive"), { system: READING_INSTRUCTIONS, final: READING_FINAL },
            task, variant, config, logger, {
                subject: "reading", questions: readingQuestions(task), contextTokens,
                selectEvidence: (query, budget, tokens) => selectReadingEvidence(task.passage, query, budget, tokens),
                pack: (evidence, full) => JSON.stringify({ passageId: task.passage.id, title: task.passage.title, variant,
                    headings: task.passage.headings ?? [], totalParagraphs: full.paragraphs.length,
                    source: task.passage.source.urls[0]?.startsWith("https://") ? task.passage.source.urls[0] : "当前会话提供的原文",
                    notice: "P定位正文；片段不代表整段。摘要仅辅助，精确措辞以原文为准。", ...evidence,
                    ...(variant === "adaptive" ? { completeOriginal: evidence === full } : {}) }),
            }, options);
    }
}
