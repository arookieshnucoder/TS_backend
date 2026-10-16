import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config/env.js";
import { TokenBudget } from "../src/modules/harness/context/tokens.js";
import { ReadingHarness } from "../src/modules/reading/harness.js";
import { readingTask, READING_VARIANTS } from "../src/modules/reading/contracts.js";
import { validateReadingCorpus, importReadingPage, readingHash, readingLayout } from "../src/modules/reading/corpus.js";
import { selectReadingEvidence } from "../src/modules/reading/evidence.js";
import { parseReadingInput, ReadingLibrary } from "../src/modules/reading/library.js";
import { readingAnswer } from "../src/modules/reading/agent.js";
import { readingOptionParts } from "../src/modules/reading/question-text.js";
import { ModelProtocolError } from "../src/modules/agent/model.js";
import { readingChoice } from "../src/modules/evaluation/reading-runner.js";
import { routeSchoolSubject } from "../src/bootstrap/reading-chat-agent.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { createApp } from "../src/app.js";
import { readingFixture } from "./reading-fixtures.js";
import { ChatSessionService } from "../src/modules/chat/service/chat-session.service.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";

const config = loadConfig({ NODE_ENV: "test", AGENT_WORKSPACE_ENABLED: "false" });
const logger = { info() {}, error() {} };

test("public import preserves source paragraph numbering and matches actual references without generation", () => {
    const article = "①" + "这是完整的初中阅读原文，其中他没有先回家，而是先完成对病人的承诺。".repeat(14);
    const result = importReadingPage({ title: "中考阅读训练夹具", questionText: `${article}\n1.为什么他没有先回家？`, answerText: "1.他要先完成对病人的承诺。",
        questionUrls: ["https://example.com/question"], answerUrls: ["https://example.com/answer"], questionHash: readingHash(article) });
    assert.ok(result.passage.paragraphs[0]!.startsWith("①"));
    assert.equal(result.questions[0]!.answer, "他要先完成对病人的承诺。");
    assert.throws(() => importReadingPage({ title: "bad", questionText: article, answerText: "", questionUrls: ["https://example.com/same"],
        answerUrls: ["https://example.com/same"], questionHash: readingHash(article) }), /answer boundary/);
});

test("whole-article isolation rejects split leakage and equivalent duplicate articles", () => {
    const corpus = readingFixture(); validateReadingCorpus(corpus);
    const leaked = structuredClone(corpus); leaked.test = [leaked.knowledge.pop()!];
    assert.throws(() => validateReadingCorpus(leaked), /leaked across splits/);
    const duplicate = structuredClone(corpus); duplicate.passages.push({ ...duplicate.passages[0]!, id: "other-id" });
    assert.throws(() => validateReadingCorpus(duplicate), /duplicate/);
});

test("public imports separate vocabulary questions, remove publisher answer trailers and reject omitted source paragraphs", () => {
    const article = "①" + "这是足够完整的初中阅读材料，人物没有先回家，而是先兑现送药的承诺。".repeat(14);
    const page = { title: "公开阅读夹具", questionText: `${article}\n1、给字注音：药。\n2、本文表达了什么？\n3、你有什么启示？`,
        answerText: "1、yào\n2、先兑现承诺。\n3、(略)\n总结：出版社推广文字。", questionUrls: ["https://example.com/question"],
        answerUrls: ["https://example.com/answer"], questionHash: readingHash(article) };
    const imported = importReadingPage(page);
    assert.deepEqual(imported.questions.map(question => question.number), [1, 2]);
    assert.doesNotMatch(imported.passage.paragraphs.join(""), /给字注音/);
    assert.doesNotMatch(imported.questions.map(question => question.answer).join(""), /总结|出版社/);
    const missingFirst = importReadingPage({ ...page, answerText: "2、先兑现承诺。\n3、(略)" });
    assert.doesNotMatch(missingFirst.passage.paragraphs.join(""), /给字注音/);
    assert.deepEqual(missingFirst.questions.map(question => question.number), [2]);
    assert.throws(() => importReadingPage({ ...page, questionText: `${article}\n1、结合第④段说明原因？` }), /missing source paragraph/);
    assert.throws(() => importReadingPage({ ...page, questionText: `${article}（引文略）\n1、解释表达效果？` }), /omits article/);
});

test("publisher introductions and titles do not shift the second body paragraph", () => {
    const layout = readingLayout("中考网为各位初三考生整理了下面的文章，仅供参考！\n有月亮的晚上\n窗外有悄悄说话声。\n我拿起书走出屋子，说明晚自习的缘由。", true);
    assert.deepEqual(layout.headings, ["有月亮的晚上"]);
    assert.equal(layout.paragraphs[1], "我拿起书走出屋子，说明晚自习的缘由。");
});

test("compact public and pasted choices share one parser and answer letters must belong to available options", () => {
    const text = "下列解释正确的一项是：A．富足B．添、增加\nC．宽恕D．尽管";
    assert.deepEqual(readingOptionParts(text).options, ["富足", "添、增加", "宽恕", "尽管"]);
    assert.equal(parseReadingInput(`[原文]①原文。\n[题目]第1题：${text}`)!.questions[0]!.options.length, 4);
    const corpus = readingFixture(); corpus.knowledge[0]!.answer = "F";
    assert.throws(() => validateReadingCorpus(corpus), /Invalid reading question/);
    assert.throws(() => readingOptionParts("选择：A.一项C.另一项"), /ordered/);
});

test("question-aware original snippets retain negation and causal neighbors within the token budget", () => {
    const corpus = readingFixture(), tokens = new TokenBudget(config.context);
    const evidence = selectReadingEvidence(corpus.passages[0]!, "为什么哥哥“没有先回家”？结合第三自然段说明", 300, tokens);
    assert.ok(tokens.count(JSON.stringify(evidence.paragraphs)) <= 300);
    assert.match(evidence.paragraphs.map(paragraph => paragraph.text).join("\n"), /没有先回家|先把药送给病人/);
    for (const paragraph of evidence.paragraphs) for (const fragment of paragraph.text.split("[…省略…]"))
        assert.ok(corpus.passages[0]!.paragraphs[Number(paragraph.id.slice(1)) - 1]!.includes(fragment));
});

test("all five reading variants reuse the same harness protocol and never expose reference answers", async () => {
    const corpus = readingFixture(), task = readingTask(corpus.passages[0]!, corpus.knowledge.slice(1));
    for (const variant of READING_VARIANTS) {
        let solverCalls = 0;
        const harness = new ReadingHarness({ async turn(messages, tools, _signal, maxTokens) {
            assert.doesNotMatch(JSON.stringify(messages), /GOLD_PRIVATE_REFERENCE/);
            if (maxTokens !== undefined) return { content: "他先送药，母亲给他热粥。", toolCalls: [] };
            solverCalls++;
            assert.ok(messages.some(message => message.role === "tool" && message.toolCallId === "reading-prepare-1"));
            assert.ok(tools.length === 0 || variant === "adaptive");
            return { content: "内部思考</think>他要先兑现送药的承诺。[P1]\n第2题答案：他先送药，才回家。", toolCalls: [] };
        } }, task, variant, config.context, logger, 500);
        const result = await harness.run({ history: [], question: "", tools: [], metadata: {} });
        assert.equal(solverCalls, 1); assert.equal(result.toolCalls, 1);
        assert.doesNotMatch(result.content, /内部思考|think/);
    }
});

test("adaptive can recover omitted original paragraphs using the existing tool scheduler", async () => {
    const corpus = readingFixture(), task = readingTask(corpus.passages[0]!, corpus.knowledge.slice(1));
    task.passage.paragraphs = task.passage.paragraphs.map((text, index) => index < 2 ? text.repeat(120) : text);
    let turns = 0;
    const harness = new ReadingHarness({ async turn(messages) {
        if (turns++ === 0) return { content: "", toolCalls: [{ id: "recover", name: "reading_lookup", arguments: { startParagraph: 3, endParagraph: 3 } }] };
        const recovered = messages.find(message => message.toolCallId === "recover")!;
        assert.match(recovered.content, /先把药送给病人/);
        return { content: "第2题答案：先送药，才回家。[P3]", toolCalls: [] };
    } }, task, "adaptive", { ...config.context, maxInputTokens: 4096 }, logger, 256);
    const result = await harness.run({ history: [], question: "请依据原文复核", tools: [], metadata: {} });
    assert.equal(result.modelTurns, 2); assert.equal(result.toolCalls, 2);
});

test("adaptive disables further tools after the host has supplied the complete original", async () => {
    const corpus = readingFixture(), task = readingTask(corpus.passages[0]!, corpus.knowledge.slice(1));
    let calls = 0;
    const harness = new ReadingHarness({ async turn(messages, tools) {
        calls++;
        assert.equal(tools.length, 0);
        const original = JSON.parse(messages.find(message => message.toolCallId === "reading-prepare-1" && message.role === "tool")!.content);
        assert.equal(original.completeOriginal, true);
        assert.match(messages[0]!.content, /不再调用工具/);
        return { content: "第2题答案：先送药，再回家。[P1]", toolCalls: [] };
    } }, task, "adaptive", config.context, logger, 256);
    await harness.run({ history: [], question: "", tools: [], metadata: {} });
    assert.equal(calls, 1);
});

test("cropped reading falls back once to original evidence when the model tool protocol is unusable", async () => {
    const corpus = readingFixture(), task = readingTask(corpus.passages[0]!, corpus.knowledge.slice(1));
    task.passage.paragraphs = task.passage.paragraphs.map((text, index) => index < 2 ? text.repeat(120) : text);
    const events: string[] = []; let calls = 0;
    const harness = new ReadingHarness({ async turn(messages, tools) {
        calls++;
        if (tools.length) throw new ModelProtocolError("INVALID_RESPONSE");
        assert.match(messages[0]!.content, /不再调用工具/);
        assert.doesNotMatch(JSON.stringify(messages), /GOLD_PRIVATE_REFERENCE/);
        assert.equal(JSON.parse(messages.find(message => message.toolCallId === "reading-prepare-1" && message.role === "tool")!.content).completeOriginal, false);
        return { content: "第2题答案：依据现有原文，先送药才回家。[P3]", toolCalls: [] };
    } }, task, "adaptive", { ...config.context, maxInputTokens: 4096 }, logger, 256);
    const result = await harness.run({ history: [], question: "", tools: [], metadata: {}, onEvent: name => events.push(name) });
    assert.equal(calls, 2); assert.equal(result.modelTurns, 2);
    assert.equal(events.filter(name => name === "reading.protocol_fallback").length, 1);
});

test("4096-token reading budgets count actual schemas and tool JSON envelopes instead of starving every variant", async () => {
    const corpus = readingFixture(), task = readingTask(corpus.passages[0]!, corpus.knowledge.slice(1));
    for (const variant of ["extractive", "adaptive"] as const) {
        let turns = 0;
        const harness = new ReadingHarness({ async turn() { turns++; return { content: "第2题答案：先送药，才回家。[P1]", toolCalls: [] }; } },
            task, variant, { ...config.context, maxInputTokens: 4096 }, logger, 1400);
        assert.match((await harness.run({ history: [], question: "", tools: [], metadata: {} })).content, /先送药/);
        assert.equal(turns, 1);
    }
});

test("oversized full articles and cancellation fail without guessing a partial answer", async () => {
    const corpus = readingFixture(); corpus.passages[0]!.paragraphs = ["原文很长，必须完整保留具体事实。".repeat(2000)];
    let turns = 0;
    const harness = new ReadingHarness({ async turn() { turns++; return { content: "invented", toolCalls: [] }; } }, readingTask(corpus.passages[0]!, corpus.knowledge.slice(1)),
        "full", { ...config.context, maxInputTokens: 4096 }, logger);
    const input = { history: [], question: "", tools: [], metadata: {} };
    await assert.rejects(harness.run(input), /READING_EVIDENCE_UNAVAILABLE/); assert.equal(turns, 0);
    await assert.rejects(harness.run(input, AbortSignal.abort()), { name: "AbortError" }); assert.equal(turns, 0);
});

test("visible answer normalization and exact multiple-choice grading handle legacy GLM tags", () => {
    assert.equal(readingAnswer("分析</think>第5题答案：D"), "第5题答案：D");
    assert.equal(readingChoice("分析</think>第5题答案：D", 5), "D");
    assert.equal(readingChoice("第3题答案：B、D", 3), "BD");
    assert.equal(readingChoice("参考第4题答案：A", 3), undefined);
    assert.throws(() => readingAnswer("<think>只有思考"), /VISIBLE_ANSWER/);
});

test("routing respects explicit current mathematics after a reading conversation and leaves defaults unchanged", () => {
    assert.equal(config.schoolSubject, "math");
    const history = [{ role: "user", content: "[语文阅读]\n[原文]原文\n[题目]问题" }];
    assert.equal(routeSchoolSubject("解方程 x²-5x+6=0", history), "math");
    assert.equal(routeSchoolSubject("求二次函数的最小值", history), "math");
    assert.equal(routeSchoolSubject("第2题是什么意思？", history), "chinese");
    assert.equal(routeSchoolSubject("计算主人公等候的时间", history), "chinese");
    assert.equal(routeSchoolSubject("[数学]阅读理解这道三角形题", history), "math");
    assert.equal(routeSchoolSubject("[语文阅读]计算人物等待的时间", []), "chinese");
    assert.ok(parseReadingInput("[原文]①他没有回家。\n③他先送药。\n[题目]第1题：为什么？"));
    assert.ok(parseReadingInput("阅读下面的文章。\n" + "①他没有先回家，因为他要完成送药的承诺。".repeat(8) + "\n1.为什么他没有先回家？"));
});

test("mathematical requests have identical model inputs before and after enabling subject routing", async () => {
    const prompts: unknown[][] = [];
    for (const subject of ["math", "auto"] as const) {
        const localConfig = loadConfig({ NODE_ENV: "test", SCHOOL_SUBJECT: subject, MATH_AGENT_VARIANT: "general", AGENT_WORKSPACE_ENABLED: "false", AGENT_TRACE_ENABLED: "false" });
        const repository = new InMemoryChatSessionRepository();
        const requests: unknown[] = [];
        const deps = createDependencies({ logger, chatSessionRepository: repository, agentModel: { async turn(messages, tools) {
            requests.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
            return { content: messages[0]?.content.startsWith("Generate") ? "数学基础计算流程核验" : "2", toolCalls: [] };
        } } }, localConfig);
        const service = new ChatSessionService(repository, deps.agentHarness);
        const session = await service.create("新对话", "test");
        assert.equal((await service.send(session.id, "计算 1+1" )).sessionStatus, "finished");
        prompts.push(requests);
    }
    assert.deepEqual(prompts[0], prompts[1]);
});

test("public library HTTP omits reference answers by default and uses the same loader as chat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reading-http-")), path = join(directory, "corpus.json");
    await writeFile(path, JSON.stringify(readingFixture()));
    const localConfig = loadConfig({ NODE_ENV: "test", MATH_AGENT_VARIANT: "general", AGENT_TRACE_ENABLED: "false" });
    const deps = createDependencies({ logger, readingLibrary: new ReadingLibrary(path), chatSessionRepository: new InMemoryChatSessionRepository(),
        agentModel: { async turn() { return { content: "ok", toolCalls: [] }; } } }, localConfig);
    const server = createApp(localConfig, deps).listen(0, "127.0.0.1"); await once(server, "listening");
    try {
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/reading/questions`;
        const list = await (await fetch(base)).json();
        assert.equal(list.data.total, 2); assert.equal(list.data.questions[1].answer, undefined);
        const detail = await (await fetch(`${base}/fixture-q2`)).text(); assert.doesNotMatch(detail, /GOLD_PRIVATE_REFERENCE/);
        const reference = await (await fetch(`${base}/fixture-q2?reference=true`)).json(); assert.match(reference.data.reference, /GOLD_PRIVATE_REFERENCE/);
        assert.equal((await fetch(`${base}?limit=0`)).status, 400);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
