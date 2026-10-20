import type { AppConfig } from "../config/env.js";
import type { AgentModel } from "../modules/agent/model.js";
import type { ChatAgent } from "../modules/chat/service/chat-agent.js";
import type { Logger } from "../common/logging/logger.js";
import type { HarnessOptions } from "../modules/harness/agent-harness.js";
import { EnglishHarness } from "../modules/english/harness.js";
import { EnglishLibrary, parseEnglishInput, unsupportedEnglish } from "../modules/english/library.js";
import { englishQuestions } from "../modules/english/contracts.js";
import { subjectHistory } from "./school-subject.js";
import { withAnswerReview } from "./answer-review.js";

export function createEnglishChatAgent(model: AgentModel, config: AppConfig, logger: Logger, library: EnglishLibrary, options: HarnessOptions = config.harness, reviewer?: AgentModel): ChatAgent {
    return {
        async run(session, current, signal, context) {
            signal?.throwIfAborted();
            if (unsupportedEnglish(current.content)) return { content: "当前英语练习支持阅读、语法和完形选择题，请提供相应文字题目；作文和听力暂未开放。", modelTurns: 0, toolCalls: 0 };
            const supplied = parseEnglishInput(current.content);
            const history = subjectHistory(session.messages, "english");
            let task = supplied;
            const id = current.content.match(/\[英语题[：:]\s*(english-[a-z0-9-]+)\s*\]/i)?.[1];
            if (!task && id) task = await library.question(id);
            if (!task && !id && /\[(?:Passage|Article|原文|Questions?|题目)\]|(?:^|\n)\s*A[.．]/i.test(current.content))
                return { content: "当前英语题目的原文、题干或A至D选项不完整，请补充本题材料后再作答。", modelTurns: 0, toolCalls: 0 };
            if (!task && !id) for (const message of [...history].reverse()) if (message.role === "user") {
                task = parseEnglishInput(message.content);
                const previousId = message.content.match(/\[英语题[：:]\s*(english-[a-z0-9-]+)\s*\]/i)?.[1];
                if (!task && previousId) task = await library.question(previousId);
                if (task) break;
            }
            if (!task) return { content: "请提供完整英语选择题及A至D选项；阅读或完形请用[Passage]、[Questions]分隔原文与题目，也可使用[英语题:题库ID]。", modelTurns: 0, toolCalls: 0 };
            const numbers = [...new Set([...current.content.matchAll(/第\s*(\d+)\s*题/g)].map(m => Number(m[1])))];
            if (!supplied && numbers.length) {
                const questions = task.questions.filter(q => numbers.includes(q.number));
                if (questions.length !== numbers.length) return { content: "现有原文中缺少所指定选择题的完整题干和选项，请补充后再作答。", modelTurns: 0, toolCalls: 0 };
                task = { ...task, questions };
            }
            const original = task;
            const reviewed = withAnswerReview(options, model, reviewer, config, "english", context => ({ question: context.question,
                original: original.passage.paragraphs.map((text, index) => ({ id: `P${index + 1}`, text })), questions: englishQuestions(original) }));
            const harness = new EnglishHarness(model, task, config.english.variant, config.context, logger, config.english.contextTokens, reviewed, config.english.workflow);
            return harness.run({ history: history.map(({ role, content }) => ({ role, content })), question: supplied ? englishQuestions(task) : current.content,
                tools: [], metadata: { sessionId: session.id, messageId: current.id, runId: context?.runId, subject: "english" }, onEvent: context?.event, deferMaintenance: context?.deferMaintenance }, signal);
        },
        async titleFor(session) { return `英语 · ${session.messages.find(m => m.role === "user")?.content.replace(/\s+/g, " ").slice(0, 24) ?? "新练习"}`; },
    };
}
