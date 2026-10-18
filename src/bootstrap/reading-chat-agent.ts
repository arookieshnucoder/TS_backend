import type { AppConfig } from "../config/env.js";
import type { AgentModel } from "../modules/agent/model.js";
import type { ChatAgent } from "../modules/chat/service/chat-agent.js";
import type { Logger } from "../common/logging/logger.js";
import type { HarnessOptions } from "../modules/harness/agent-harness.js";
import { ReadingHarness } from "../modules/reading/harness.js";
import { ReadingLibrary, isReadingRequest, parseReadingInput } from "../modules/reading/library.js";
import { readingQuestions, readingTask } from "../modules/reading/contracts.js";
import { withAnswerReview } from "./answer-review.js";
import { fullReadingEvidence } from "../modules/reading/evidence.js";

export function createReadingChatAgent(model: AgentModel, config: AppConfig, logger: Logger,
    library: ReadingLibrary, options: HarnessOptions = config.harness, reviewer?: AgentModel): ChatAgent {
    return {
        async run(session, current, signal, context) {
            signal?.throwIfAborted();
            const supplied = parseReadingInput(current.content);
            let task = supplied;
            const id = current.content.match(/\[语文题[：:]\s*(reading-[a-f0-9]+-q\d+)\s*\]/)?.[1];
            if (!task && id) task = await library.question(id);
            if (!task && !id) {
                // A follow-up can reuse the latest explicit article. Never treat an assistant summary as the article.
                for (const message of [...session.messages].reverse()) if (message.role === "user") {
                    task = parseReadingInput(message.content);
                    const previousId = message.content.match(/\[语文题[：:]\s*(reading-[a-f0-9]+-q\d+)\s*\]/)?.[1];
                    if (!task && previousId) task = await library.question(previousId);
                    if (task) break;
                }
            }
            if (!task) return { content: "请提供完整阅读材料和题目，使用[原文]、[题目]分隔；也可用[语文题:题库ID]选择公开题目。", modelTurns: 0, toolCalls: 0 };
            const requestedNumbers = [...new Set([...current.content.matchAll(/第\s*(\d+)\s*题/g)].map(match => Number(match[1])))];
            if (!supplied && requestedNumbers.length) {
                let questions = task.questions.filter(question => requestedNumbers.includes(question.number));
                if (questions.length < requestedNumbers.length && !task.passage.id.startsWith("user-reading-")) {
                    const corpus = await library.corpus();
                    questions = readingTask(task.passage, corpus.knowledge.filter(question => question.passageId === task!.passage.id && requestedNumbers.includes(question.number))).questions;
                }
                if (questions.length < requestedNumbers.length) return { content: "当前材料中缺少所指定题目的完整题干，请补充题目后再解答。", modelTurns: 0, toolCalls: 0 };
                task = { ...task, questions };
            }
            const original = task;
            const reviewedOptions = withAnswerReview(options, model, reviewer, config, "chinese", context => ({
                question: context.question, title: original.passage.title, original: fullReadingEvidence(original.passage),
            }));
            const harness = new ReadingHarness(model, task, config.reading.variant, config.context, logger, config.reading.contextTokens, reviewedOptions);
            return harness.run({ history: session.messages.map(({ role, content }) => ({ role, content })),
                question: supplied ? readingQuestions(task) : current.content, tools: [],
                metadata: { sessionId: session.id, messageId: current.id, runId: context?.runId, subject: "chinese" }, onEvent: context?.event }, signal);
        },
        async titleFor(session) { return `语文阅读 · ${session.messages.find(message => message.role === "user")?.content.replace(/\s+/g, " ").slice(0, 22) ?? "新题"}`; },
    };
}

export { routeSchoolSubject } from "./school-subject.js";
