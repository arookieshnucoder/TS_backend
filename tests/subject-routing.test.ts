import assert from "node:assert/strict";
import test from "node:test";
import { routeSchoolSubject, subjectHistory } from "../src/bootstrap/school-subject.js";
import { SubjectClassifier } from "../src/modules/subjects/subject-classifier.js";
import { createSubjectRoutingAgent } from "../src/bootstrap/subject-routing-agent.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { ChatSessionService } from "../src/modules/chat/service/chat-session.service.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";
import { BackgroundWorkQueue } from "../src/modules/chat/service/background-work.js";
import type { ChatAgent } from "../src/modules/chat/service/chat-agent.js";
import type { ChatMessage, ChatSession } from "../src/modules/chat/entity/chat-session.entity.js";
import type { AgentModel } from "../src/modules/agent/model.js";
import type { SolutionSkill, SolutionSkillDraft, SolutionSkillStore } from "../src/modules/harness/skills/contracts.js";
import { SolutionSkillLibrary } from "../src/modules/harness/skills/library.js";
import { loadConfig } from "../src/config/env.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";

const logger = { info() {}, error() {} };
const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};
const sessionFixture = (): ChatSession => ({
    id: "session", requestId: "request", title: "测试", createdAt: new Date(), updatedAt: new Date(),
    messages: [], sessionStatus: "finished", sessionError: null,
});
const current: ChatMessage = { id: "current", role: "user", content: "分析‘他像松树一样挺立’的比喻作用。" };
const modelAnswer = (content: string): AgentModel => ({ async turn() { return { content, toolCalls: [] }; } });
const unusedAgent: ChatAgent = {
    async run() { assert.fail("an unresolved or differently classified question must not reach this solver"); },
    async titleFor(session) { return session.title; },
};

test("persisted classification overrides an obsolete mode label and keeps follow-ups in the classified subject", () => {
    const history = [
        { id: "math-user", role: "user", content: "[数学] 解方程x²-5x+6=0", subject: "math" },
        { id: "math-answer", role: "assistant", content: "MATH_ONLY_ANSWER", subject: "math" },
        { id: "chinese-user", role: "user", content: "[数学] 分析‘他像松树一样挺立’的比喻作用。", subject: "chinese" },
        { id: "chinese-answer", role: "assistant", content: "CHINESE_ONLY_ANSWER", subject: "chinese" },
        { id: "follow-up", role: "user", content: "再解释一下表达效果。", subject: "chinese" },
        { id: "follow-up-answer", role: "assistant", content: "继续分析该句的表达效果。", subject: "chinese" },
        { id: "english-user", role: "user", content: "[英语] Choose the correct tense.", subject: "english" },
    ];
    assert.deepEqual(subjectHistory(history, "chinese").map(message => message.id),
        ["chinese-user", "chinese-answer", "follow-up", "follow-up-answer"]);
    assert.deepEqual(subjectHistory(history, "math").map(message => message.id), ["math-user", "math-answer"]);
    assert.deepEqual(subjectHistory(history, "english").map(message => message.id), ["english-user"]);
});

test("legacy history without subject metadata still follows the latest explicit subject", () => {
    const history = [
        { id: "chinese", role: "user", content: "[语文阅读]\n[原文]哥哥先送药。\n[题目]1.哥哥先做什么？" },
        { id: "chinese-answer", role: "assistant", content: "先送药。" },
        { id: "follow-up", role: "user", content: "第1题解释一下依据。" },
        { id: "math", role: "user", content: "[数学] 解方程x²-5x+6=0" },
        { id: "math-answer", role: "assistant", content: "答案为2和3。" },
    ];
    assert.deepEqual(subjectHistory(history, "chinese").map(message => message.id),
        ["chinese", "chinese-answer", "follow-up"]);
});

test("legacy question content overrides stale mode labels while mathematical tasks keep their subject", () => {
    const chineseQuestions = [
        "[数学] 分析古诗词《水调歌头》的意象与思想感情。",
        "[数学]\n[原文]哥哥先送药，兑现承诺，然后回家。\n[题目]1.哥哥为什么没有先回家？",
    ];
    for (const content of chineseQuestions) {
        assert.equal(routeSchoolSubject(content, []), "chinese");
        const history = [{ role: "user", content }, { role: "assistant", content: "CHINESE_LEGACY_ANSWER" }];
        assert.equal(subjectHistory(history, "chinese").length, 2);
        assert.equal(subjectHistory(history, "math").length, 0);
        assert.equal(history[0]!.content, content, "inference must not rewrite the user's original text");
    }
    assert.equal(routeSchoolSubject("[数学] 阅读理解这道三角形题", []), "math");
    assert.equal(routeSchoolSubject("[英语] Solve the equation 2x + 3 = 11.", []), "math");
    assert.equal(routeSchoolSubject("[英语] Find the area of a triangle with base 4 and height 3.", []), "math");
});

test("unlabelled legacy follow-ups inherit confirmed metadata without replaying a stale mode label", () => {
    const history: ChatMessage[] = [
        { id: "classified", role: "user", content: "[数学] 白日依山尽，黄河入海流。", subject: "chinese" },
        { id: "answer", role: "assistant", content: "CHINESE_CONFIRMED_ANSWER" },
        { id: "follow-up", role: "user", content: "继续第1题。" },
        { id: "follow-up-answer", role: "assistant", content: "CHINESE_FOLLOW_UP_ANSWER" },
    ];
    assert.equal(routeSchoolSubject("再解释一下。", history), "chinese");
    assert.deepEqual(subjectHistory(history, "chinese").map(message => message.id), history.map(message => message.id));
    assert.deepEqual(subjectHistory(history, "math"), []);
    history.push({ id: "new-math-question", role: "user", content: "解方程x²-5x+6=0" },
        { id: "new-math-answer", role: "assistant", content: "MATH_NEW_ANSWER" });
    assert.deepEqual(subjectHistory(history, "math").map(message => message.id), ["new-math-question", "new-math-answer"]);
    assert.equal(routeSchoolSubject("继续下一步。", history), "math");
});

test("the isolated classifier uses one tool-free call capped at 48 output tokens and can override the preferred mode", async () => {
    let calls = 0;
    const classifier = new SubjectClassifier({ async turn(messages, tools, signal, maxOutputTokens) {
        calls++;
        assert.equal(messages[0]!.role, "system");
        assert.equal(messages.at(-1)!.role, "user");
        assert.ok(messages.at(-1)!.content.includes(current.content));
        assert.deepEqual(tools, []);
        assert.equal(signal?.aborted, false);
        assert.equal(maxOutputTokens, 48);
        return { content: '{"subject":"chinese"}', toolCalls: [] };
    } });
    assert.equal(await classifier.classify(sessionFixture(), current, undefined, "math"), "chinese");
    assert.equal(calls, 1);
});

test("classification defaults to the requested lightweight model and an eight-second deadline", () => {
    const settings = loadConfig({ NODE_ENV: "test" });
    assert.equal(settings.subjectClassification.model, "glm-4.5-air");
    assert.equal(settings.subjectClassification.timeoutMs, 8000);
    assert.equal(settings.subjectClassification.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
});

test("classifier credentials are reused only for the same endpoint and can be configured independently", () => {
    const glm = loadConfig({ NODE_ENV: "test", LLM_MODEL: "glm-4.5-air", LLM_BASE_URL: "https://glm.example/api/",
        LLM_API_KEY: "glm-fixture-key" });
    assert.equal(glm.subjectClassification.baseUrl, "https://glm.example/api/");
    assert.equal(glm.subjectClassification.apiKey, "glm-fixture-key");
    const deepseek = loadConfig({ NODE_ENV: "test", LLM_MODEL: "deepseek-flash", LLM_BASE_URL: "https://deepseek.example/api",
        LLM_API_KEY: "main-fixture-key" });
    assert.equal(deepseek.subjectClassification.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
    assert.equal(deepseek.subjectClassification.apiKey, undefined);
    const independent = loadConfig({ NODE_ENV: "test", LLM_MODEL: "glm-4.5-air", LLM_BASE_URL: "https://main.example/api",
        LLM_API_KEY: "main-fixture-key", SUBJECT_CLASSIFIER_BASE_URL: "https://classifier.example/api" });
    assert.equal(independent.subjectClassification.apiKey, undefined);
    const explicit = loadConfig({ NODE_ENV: "test", LLM_API_KEY: "main-fixture-key",
        SUBJECT_CLASSIFIER_BASE_URL: "https://classifier.example/api", SUBJECT_CLASSIFIER_API_KEY: "classifier-fixture-key" });
    assert.equal(explicit.subjectClassification.apiKey, "classifier-fixture-key");
    assert.equal(explicit.llmApiKey, "main-fixture-key");
});

test("unknown, malformed and unavailable classification cannot silently become the current mode", async () => {
    assert.equal(await new SubjectClassifier(modelAnswer('{"subject":"unknown"}')).classify(sessionFixture(), current, undefined, "math"), undefined);
    for (const content of ['{"subject":"physics"}', "math", '{"subject":null}', "{}"])
        await assert.rejects(new SubjectClassifier(modelAnswer(content)).classify(sessionFixture(), current));
    await assert.rejects(new SubjectClassifier({ async turn() { throw new Error("provider unavailable"); } })
        .classify(sessionFixture(), current, undefined, "math"));
});

test("classification has a bounded deadline even when the model ignores cancellation", { timeout: 2000 }, async () => {
    const classifier = new SubjectClassifier({ async turn() { return new Promise(() => {}); } }, 20);
    await assert.rejects(classifier.classify(sessionFixture(), current));
});

test("pending persistence and classification start concurrently, and the chosen mode is public before solving ends", { timeout: 5000 }, async () => {
    const pendingWriteStarted = gate(), releasePendingWrite = gate();
    const classifyStarted = gate(), releaseClassify = gate();
    const solveStarted = gate(), releaseSolve = gate();
    let solveCalls = 0;
    class SlowPendingRepository extends InMemoryChatSessionRepository {
        override async save(session: ChatSession) {
            if (session.sessionStatus === "pending" && !session.subject) {
                pendingWriteStarted.resolve();
                await releasePendingWrite.promise;
            }
            return super.save(session);
        }
    }
    const repository = new SlowPendingRepository();
    const classifier = new SubjectClassifier({ async turn() {
        classifyStarted.resolve();
        await releaseClassify.promise;
        return { content: '{"subject":"chinese"}', toolCalls: [] };
    } });
    const chinese: ChatAgent = {
        async run(session, message) {
            solveCalls++;
            assert.equal(session.subject, "chinese");
            assert.equal(message.subject, "chinese");
            assert.equal((await repository.findById(session.id))?.subject, "chinese");
            solveStarted.resolve();
            await releaseSolve.promise;
            return { content: "比喻生动表现人物坚韧的品质。" };
        }, async titleFor(session) { return session.title; },
    };
    const routed = createSubjectRoutingAgent(classifier, { math: unusedAgent, chinese, english: unusedAgent }, "math");
    const service = new ChatSessionService(repository, routed);
    const session = await service.create("新对话", "request");
    const answer = service.send(session.id, current.content, undefined, "send-request", "math");
    try {
        await Promise.all([pendingWriteStarted.promise, classifyStarted.promise]);
        assert.equal(solveCalls, 0);
        releaseClassify.resolve();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(solveCalls, 0, "classification cannot run the solver before the pending write is committed");
        releasePendingWrite.resolve();
        await solveStarted.promise;
        const pending = await service.getById(session.id);
        assert.equal(pending.sessionStatus, "pending");
        assert.equal(pending.subject, "chinese");
        assert.equal(pending.modelRequestId, "send-request");
        releaseSolve.resolve();
        const final = await answer;
        assert.equal(final.sessionStatus, "finished");
        assert.equal(final.subject, "chinese");
        assert.deepEqual(final.messages.map(message => message.subject), ["chinese", "chinese"]);
        assert.equal(solveCalls, 1);
    } finally {
        releaseClassify.resolve(); releasePendingWrite.resolve(); releaseSolve.resolve();
        await answer;
    }
});

test("a failed classification never invokes solving, stores an answer or submits learning", async () => {
    const queue = new BackgroundWorkQueue(16, 1000, 0);
    const routed = createSubjectRoutingAgent(new SubjectClassifier(modelAnswer('{"subject":"invalid"}')),
        { math: unusedAgent, chinese: unusedAgent, english: unusedAgent }, "math");
    const service = new ChatSessionService(new InMemoryChatSessionRepository(), routed, undefined, 1000, undefined, queue);
    try {
        const session = await service.create("新对话", "request");
        const result = await service.send(session.id, current.content, undefined, "send-request", "math");
        assert.equal(result.sessionStatus, "failure");
        assert.deepEqual(result.messages, []);
        assert.equal(result.subject, undefined);
        await queue.drain();
    } finally { await queue.close(); }
});

test("an unknown classification asks for clarification without invoking any subject agent", async () => {
    const routed = createSubjectRoutingAgent(new SubjectClassifier(modelAnswer('{"subject":"unknown"}')),
        { math: unusedAgent, chinese: unusedAgent, english: unusedAgent }, "math");
    const session = sessionFixture();
    const result = await routed.run(session, { ...current });
    assert.match(result.content, /学科|具体题目/);
    assert.equal(result.modelTurns, 0);
    assert.equal(session.subject, undefined);
});

test("cancelling a pending classification prevents late model output from switching mode or solving", { timeout: 3000 }, async () => {
    const started = gate(), release = gate(), controller = new AbortController();
    const classifier = new SubjectClassifier({ async turn() {
        started.resolve();
        await release.promise;
        return { content: '{"subject":"chinese"}', toolCalls: [] };
    } });
    const routed = createSubjectRoutingAgent(classifier, { math: unusedAgent, chinese: unusedAgent, english: unusedAgent });
    const session = sessionFixture(), message = { ...current };
    const result = routed.run(session, message, controller.signal);
    const rejected = assert.rejects(result);
    await started.promise;
    controller.abort();
    await rejected;
    release.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.subject, undefined);
    assert.equal(message.subject, undefined);
});

test("math mode Chinese questions use Chinese solving, independent review and the Chinese skill transaction", { timeout: 10000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "subject-routing-skills-"));
    const records: SolutionSkill[] = [], reads: string[] = [], locks: string[] = [];
    const store: SolutionSkillStore = {
        async initialize() {}, async close() {}, async history() { return []; },
        async list(subject) { reads.push(subject); return records.filter(skill => skill.subject === subject); },
        async withSubjectLock(subject, operation, signal) {
            locks.push(subject);
            return operation({
                async list() { return records.filter(skill => skill.subject === subject); },
                async insert(skill) {
                    signal?.throwIfAborted();
                    assert.equal(skill.subject, subject);
                    records.push(skill);
                },
                async update() { assert.fail("a new library has no experience to update"); },
            });
        },
    };
    const draft: SolutionSkillDraft = {
        name: "reading-character-causality",
        description: "结合人物在前后文中的言行与因果关系，概括行为原因，并用原文证据核对推断。",
        applicability: ["中文叙事阅读中要求分析人物行为原因"],
        steps: ["定位相关行为及前后文中的原因线索", "区分原文明示与合理推断，概括原因并引用支持依据"],
        checks: ["核对人物、时间和因果关系，确保结论有原文支持"],
        exclusions: ["原文未提供足够因果证据时不能作确定推断"],
        keywords: ["人物行为", "因果关系", "原文依据"],
    };
    let classifierCalls = 0, solverCalls = 0, answerReviews = 0, authorCalls = 0;
    const classifierModel: AgentModel = { async turn() {
        classifierCalls++;
        return { content: '{"subject":"chinese"}', toolCalls: [] };
    } };
    const solver: AgentModel = { async turn(messages) {
        solverCalls++;
        assert.match(JSON.stringify(messages), /哥哥先把药送给病人/);
        assert.doesNotMatch(JSON.stringify(messages), /MATH_HISTORY_SECRET/);
        return { content: "哥哥要先兑现送药的承诺。[P1]\n第1题答案：先把药送给病人。", toolCalls: [] };
    } };
    const reviewer: AgentModel = { async turn(messages) {
        const system = messages[0]!.content, payload = JSON.parse(messages.at(-1)!.content);
        assert.doesNotMatch(JSON.stringify(payload), /MATH_HISTORY_SECRET/);
        if (system.includes("整理员")) {
            authorCalls++;
            assert.equal(payload.subject, "chinese");
            assert.match(JSON.stringify(payload.original), /哥哥先把药送给病人/);
            return { content: JSON.stringify(draft), toolCalls: [] };
        }
        if (system.includes("独立核验员")) {
            answerReviews++;
            assert.match(system, /阅读原文/);
            assert.match(JSON.stringify(payload.evidence.original), /哥哥先把药送给病人/);
        }
        if (payload.evidence?.subject) assert.equal(payload.evidence.subject, "chinese");
        return { content: JSON.stringify({ verdict: "pass", reason: "人物行为、承诺与原文因果依据相符。", issues: [] }), toolCalls: [] };
    } };
    const config = loadConfig({ NODE_ENV: "test", SCHOOL_SUBJECT: "math", MATH_AGENT_VARIANT: "adaptive",
        ANSWER_REVIEW_ENABLED: "true", AUTH_ENABLED: "false", AGENT_TRACE_ENABLED: "false",
        AGENT_MODEL_RETRIES: "0", AGENT_TOOL_RETRIES: "0" });
    const library = new SolutionSkillLibrary(store, root);
    const dependencies = createDependencies({ agentModel: solver, classifierModel, reviewerModel: reviewer, logger,
        chatSessionRepository: new InMemoryChatSessionRepository(), solutionSkills: library }, config);
    const queue = new BackgroundWorkQueue(16, 5000, 0);
    const service = new ChatSessionService(dependencies.chatSessionRepository, dependencies.agentHarness, undefined, 5000, undefined, queue);
    try {
        const session = await service.create("跨学科测试", "request");
        session.subject = "math";
        session.messages = [
            { id: "previous-question", role: "user", content: "MATH_HISTORY_SECRET：解方程x²-5x+6=0", subject: "math" },
            { id: "previous-answer", role: "assistant", content: "2和3。", subject: "math" },
        ];
        await dependencies.chatSessionRepository.save(session);
        const answer = await service.send(session.id, "[数学]\n[原文]哥哥答应送药，哥哥先把药送给病人，然后才回家。\n[题目]1.哥哥为什么没有先回家？",
            undefined, "send-request", "math");
        assert.equal(answer.sessionStatus, "finished");
        assert.equal(answer.subject, "chinese");
        assert.match(answer.messages.at(-1)!.content, /先把药送给病人/);
        assert.deepEqual(answer.messages.slice(-2).map(message => message.subject), ["chinese", "chinese"]);
        await queue.drain();
        assert.equal(classifierCalls, 1, "title generation must reuse the saved classification");
        assert.equal(solverCalls, 1);
        assert.equal(answerReviews, 1);
        assert.equal(authorCalls, 1);
        assert.ok(reads.length > 0);
        assert.ok(reads.every(subject => subject === "chinese"));
        assert.deepEqual(locks, ["chinese"]);
        assert.equal(records.length, 1);
        assert.equal(records[0]!.subject, "chinese");
    } finally { await queue.close(); await dependencies.mcp.close(); }
});

test("HTTP validates mode hints and correlation IDs, then echoes the exact pending classification request", { timeout: 5000 }, async () => {
    const solveStarted = gate(), releaseSolve = gate();
    let classifierCalls = 0;
    const classifier = new SubjectClassifier({ async turn(messages) {
        classifierCalls++;
        assert.equal(JSON.parse(messages.at(-1)!.content).preferredSubject, "math");
        return { content: '{"subject":"chinese"}', toolCalls: [] };
    } });
    const chinese: ChatAgent = {
        async run() { solveStarted.resolve(); await releaseSolve.promise; return { content: "比喻表现人物坚韧的品质。" }; },
        async titleFor(session) { return session.title; },
    };
    const settings = loadConfig({ NODE_ENV: "test", AGENT_TRACE_ENABLED: "false", AUTH_ENABLED: "false" });
    const dependencies = createDependencies({ logger, chatSessionRepository: new InMemoryChatSessionRepository(),
        agentHarness: createSubjectRoutingAgent(classifier, { math: unusedAgent, chinese, english: unusedAgent }) }, settings);
    const app = createApp(settings, dependencies), server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat/sessions`;
    const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let pending: Promise<Response> | undefined;
    try {
        const created = await (await post(base, { title: "学科识别" })).json();
        const url = `${base}/${created.data.id}`, sendUrl = `${url}/messages`;
        const invalid = [
            ...["physics", "Math", null, 3].map(preferredSubject => ({ preferredSubject })),
            ...["", "bad id", "../request", "a".repeat(65), null, 3].map(clientRequestId => ({ clientRequestId })),
        ];
        for (const fields of invalid) {
            const response = await post(sendUrl, { content: current.content, ...fields });
            assert.equal(response.status, 400);
            assert.equal((await response.json()).error.code, "VALIDATION_ERROR");
        }
        assert.equal(classifierCalls, 0, "invalid input must be rejected before model work starts");
        pending = post(sendUrl, { content: current.content, preferredSubject: "math", clientRequestId: "tab-7-request-123" });
        await solveStarted.promise;
        const running = (await (await fetch(url)).json()).data;
        assert.equal(running.sessionStatus, "pending");
        assert.equal(running.subject, "chinese");
        assert.equal(running.clientRequestId, "tab-7-request-123");
        assert.equal(typeof running.modelRequestId, "string");
        assert.notEqual(running.modelRequestId, running.clientRequestId);
        releaseSolve.resolve();
        const response = await pending;
        assert.equal(response.status, 200);
        const answer = (await response.json()).data;
        assert.equal(answer.subject, "chinese");
        assert.equal(answer.clientRequestId, "tab-7-request-123");
        assert.equal(answer.modelRequestId, running.modelRequestId);
        assert.deepEqual(answer.messages.map((message: ChatMessage) => message.subject), ["chinese", "chinese"]);
        assert.equal(classifierCalls, 1);
    } finally {
        releaseSolve.resolve();
        await pending?.catch(() => {});
        await app.locals.chatBackground.close();
        await dependencies.mcp.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
