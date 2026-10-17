import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config/env.js";
import { loadEnvironment } from "../src/config/environment.js";
import { GlmModel } from "../src/infrastructure/llm/glm-model.js";
import { createMathChatAgent } from "../src/bootstrap/math-chat-agent.js";
import { createReadingChatAgent } from "../src/bootstrap/reading-chat-agent.js";
import { ReadingLibrary } from "../src/modules/reading/library.js";
import { loadCorpus } from "../src/modules/math/corpus.js";
import { renderQuestion } from "../src/modules/math/contracts.js";
import { extractMathAnswer } from "../src/modules/evaluation/math-runner.js";
import { readingChoice } from "../src/modules/evaluation/reading-runner.js";
import type { AgentResult } from "../src/modules/agent/contracts.js";

const config = loadConfig({ ...loadEnvironment(), ANSWER_REVIEW_ENABLED: "true" });
if (!config.llmApiKey || !config.verification.apiKey) throw new Error("Set LLM_API_KEY before running live review smoke tests");
const solver = new GlmModel(config, config.math.thinking);
const reviewer = new GlmModel({ llmApiKey: config.verification.apiKey, llmModel: config.verification.model,
    llmBaseUrl: config.verification.baseUrl, llmTimeoutMs: config.verification.timeoutMs }, config.math.thinking);
const logger = { info() {}, error() {} };
const session = { id: "review-smoke", requestId: "review-smoke", title: "review smoke", messages: [], createdAt: new Date(), updatedAt: new Date(), sessionStatus: "finished" as const, sessionError: null };
const corpus = await loadCorpus(config.math.corpusPath);
const library = new ReadingLibrary(config.reading.corpusPath);
const readingCorpus = await library.corpus();
const math = createMathChatAgent(solver, config, logger, config.harness, reviewer);
const reading = createReadingChatAgent(solver, config, logger, library, config.harness, reviewer);
const mathQuestion = corpus.test.find(q => q.family === "roots") ?? corpus.knowledge[0]!;
const readingQuestion = readingCorpus.test.find(q => q.type === "single-choice") ?? readingCorpus.knowledge.find(q => q.type === "single-choice")!;
const passage = readingCorpus.passages.find(p => p.id === readingQuestion.passageId)!;
const readingInput = `[原文]\n${passage.paragraphs.join("\n")}\n[题目]\n第${readingQuestion.number}题：${readingQuestion.question}\n${readingQuestion.options.map((o, i) => `${"ABCDEF"[i]}. ${o}`).join("\n")}`;
const cases = [
    { subject: "math", agent: math, question: renderQuestion(mathQuestion), expected: mathQuestion.answer, extract: extractMathAnswer },
    { subject: "chinese", agent: reading, question: readingInput, expected: readingQuestion.answer, extract: (answer: string) => readingChoice(answer, readingQuestion.number) },
];
const results: unknown[] = [];
for (const [index, item] of cases.entries()) {
    const started = Date.now(), events: { name: string; fields?: Record<string, unknown> }[] = [];
    console.log(JSON.stringify({ subject: item.subject, stage: "started", solver: config.llmModel, reviewer: config.verification.model }));
    const result = await item.agent.run(session, { id: `review-smoke-${index}`, role: "user", content: item.question }, AbortSignal.timeout(240000),
        { runId: `review-smoke-${index}`, event(name, fields) {
            if (name === "agent.review.report" || name === "agent.review.completed" || name === "agent.subagent.failed") events.push({ name, fields });
        } }) as AgentResult;
    const row = { subject: item.subject, durationMs: Date.now() - started, ...result, expected: item.expected,
        answerCorrect: item.extract(result.content) === item.expected, events };
    results.push(row); console.log(JSON.stringify(row));
}
const output = join("data", "review-smoke", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
await writeFile(join(output, "results.json"), JSON.stringify({ solver: config.llmModel, reviewer: config.verification.model, results }, null, 2));
console.log(JSON.stringify({ output }));
if (results.some((row: any) => row.review?.status !== "passed" || !row.answerCorrect)) process.exitCode = 1;
