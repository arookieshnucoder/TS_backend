import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { AgentMessage, AgentResult } from "../src/modules/agent/contracts.js";
import type { AgentModel } from "../src/modules/agent/model.js";
import { SingleTurnAgent } from "../src/modules/agent/single-turn-agent.js";
import { parseReviewReport } from "../src/modules/agent/answer-review.js";
import { AgentHarness } from "../src/modules/harness/agent-harness.js";
import { withAnswerReview, mathReviewEvidence } from "../src/bootstrap/answer-review.js";
import { loadConfig } from "../src/config/env.js";
import { createMathProfile } from "../src/modules/math/profile.js";
import { createReadingChatAgent } from "../src/bootstrap/reading-chat-agent.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { ALL_MATH_VARIANTS } from "../src/modules/math/contracts.js";
import { ReadingLibrary } from "../src/modules/reading/library.js";
import { readingTask } from "../src/modules/reading/contracts.js";
import { readingFixture } from "./reading-fixtures.js";
import { fixture } from "./math-fixtures.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";

const logger = { info() {}, error() {} };
const config = loadConfig({ NODE_ENV: "test", MATH_AGENT_VARIANT: "adaptive", ANSWER_REVIEW_ENABLED: "true", AGENT_MODEL_RETRIES: "0" });
const input = { question: "解方程 x²-7x+12=0", history: [], tools: [], metadata: {} };
const report = (verdict: "pass" | "fail" | "uncertain") => JSON.stringify({ verdict, reason: "代回原方程核对两根及乘积。", issues: verdict === "fail" ? ["根之和与系数不符"] : [] });
const text = (content: string): AgentModel => ({ async turn() { return { content, toolCalls: [] }; } });
const run = (solver: AgentModel, reviewer: AgentModel, extra = {}) => new AgentHarness(solver, new SingleTurnAgent(), { system: "solve", final: "answer" }, config.context, logger,
    withAnswerReview(extra, solver, reviewer, config, "math", mathReviewEvidence)).run(input);
const session = { id: "session", requestId: "request", title: "title", messages: [], createdAt: new Date(), updatedAt: new Date(), sessionStatus: "finished" as const, sessionError: null };

test("review receives the exact candidate and current question; successful output is unchanged", async () => {
    const candidate = "(x-3)(x-4)=0。\n答案：3和4";
    const result = await run(text(candidate), { async turn(messages, tools) {
        assert.deepEqual(tools, []);
        const payload = JSON.parse(messages.at(-1)!.content);
        assert.equal(payload.candidate, candidate); assert.equal(payload.evidence.question, input.question);
        assert.deepEqual(payload.evidence.checks.quadratic.realRoots, [3, 4]);
        return { content: report("pass"), toolCalls: [] };
    } });
    assert.equal(result.content, candidate);
    assert.deepEqual(result.review, { status: "passed", attempts: 1, revised: false });
    assert.equal(result.modelTurns, 2);
});

test("a rejected candidate is repaired by the solver and the actual replacement is reviewed again", async () => {
    const order: string[] = []; let solves = 0, reviews = 0;
    const solver: AgentModel = { async turn(messages) {
        order.push("solver"); solves++;
        if (solves > 1) {
            const payload = JSON.parse(messages.at(-1)!.content);
            assert.equal(payload.candidate, "wrong"); assert.equal(payload.review.verdict, "fail");
        }
        return { content: solves === 1 ? "wrong" : "corrected", toolCalls: [] };
    } };
    const reviewer: AgentModel = { async turn(messages) {
        order.push("reviewer"); reviews++;
        assert.equal(JSON.parse(messages.at(-1)!.content).candidate, reviews === 1 ? "wrong" : "corrected");
        return { content: report(reviews === 1 ? "fail" : "pass"), toolCalls: [] };
    } };
    const result = await run(solver, reviewer);
    assert.deepEqual(order, ["solver", "reviewer", "solver", "reviewer"]);
    assert.equal(result.content, "corrected"); assert.equal(result.modelTurns, 4);
    assert.deepEqual(result.review, { status: "passed", attempts: 2, revised: true });
});

test("uncertain, still-wrong and malformed reports never release a failed candidate as verified", async () => {
    for (const [response, status] of [[report("uncertain"), "uncertain"], [report("fail"), "failed"], ["not JSON", "unavailable"],
        [JSON.stringify({ verdict: "pass", reason: "", issues: [] }), "unavailable"]]) {
        const result = await run(text("known wrong answer"), text(response));
        assert.equal(result.review?.status, status);
        assert.doesNotMatch(result.content, /known wrong answer/);
    }
    assert.throws(() => parseReviewReport('{"verdict":"fail","reason":"x","issues":[]}'), /INVALID_REVIEW/);
    assert.throws(() => parseReviewReport('{"verdict":"pass","reason":"x","issues":["wrong"]}'), /INVALID_REVIEW/);
    assert.equal(parseReviewReport("```json\n" + report("pass") + "\n```").verdict, "pass");
});

test("review outages are explicit and parent cancellation propagates during child execution", async () => {
    const failed = await run(text("candidate"), { async turn() { throw new Error("private api key"); } });
    assert.equal(failed.review?.status, "unavailable"); assert.equal(failed.modelTurns, 2);
    assert.doesNotMatch(JSON.stringify(failed), /private api key|candidate/);
    const keepAlive = setTimeout(() => {}, 1000);
    try {
        const short = { ...config, verification: { ...config.verification, timeoutMs: 20 } };
        const solver = text("candidate"), hanging: AgentModel = { async turn() { return new Promise(() => {}); } };
        const harness = new AgentHarness(solver, new SingleTurnAgent(), { system: "solve", final: "answer" }, config.context, logger,
            withAnswerReview({}, solver, hanging, short, "math", mathReviewEvidence));
        assert.equal((await harness.run(input)).review?.status, "unavailable");
        const abort = new AbortController();
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        const pending = new AgentHarness(solver, new SingleTurnAgent(), { system: "solve", final: "answer" }, config.context, logger,
            withAnswerReview({}, solver, { async turn() { started(); return new Promise(() => {}); } }, config, "math", mathReviewEvidence)).run(input, abort.signal);
        await ready; abort.abort(); await assert.rejects(pending, { name: "AbortError" });
    } finally { clearTimeout(keepAlive); }
});

test("every math profile runs post-answer review, including native probability answers", async () => {
    for (const variant of ALL_MATH_VARIANTS) {
        const f = fixture(); let reviews = 0;
        const solver = text("两根3和4。\n答案：B");
        const reviewer: AgentModel = { async turn() { reviews++; return { content: report("pass"), toolCalls: [] }; } };
        const profile = createMathProfile(variant, f.rag, solver, config.context, logger,
            withAnswerReview({}, solver, reviewer, config, "math", mathReviewEvidence));
        const result = await profile.harness.run({ ...input, tools: [f.rag.tool(profile.mode)] });
        assert.equal(reviews, 1, variant); assert.equal(result.review?.status, "passed", variant);
    }
    const f = fixture(), solver: AgentModel = { async turn() { assert.fail("native solver should handle this"); } };
    const profile = createMathProfile("adaptive", f.rag, solver, config.context, logger,
        withAnswerReview({}, solver, text(report("pass")), config, "math", mathReviewEvidence));
    const result = await profile.harness.run({ ...input, question: "袋中有3个红球和2个白球，大小相同，随机不放回连续取2球。两球都是红球的概率是多少？", tools: [f.rag.tool(profile.mode)] });
    assert.equal(result.review?.status, "passed"); assert.equal(result.modelTurns, 1); assert.match(result.content, /3\/10/);
});

test("Chinese review receives the complete original and all requested questions, never corpus gold", async () => {
    const corpus = readingFixture(), task = readingTask(corpus.passages[0]!, corpus.knowledge);
    const library = new ReadingLibrary("unused"); library.question = async () => task;
    let reviews = 0;
    const reviewer: AgentModel = { async turn(messages) {
        reviews++;
        const payload = JSON.parse(messages.at(-1)!.content);
        assert.deepEqual(payload.evidence.original.paragraphs.map((p: any) => p.text), corpus.passages[0]!.paragraphs);
        assert.match(payload.evidence.question, /第1题/); assert.match(payload.evidence.question, /第2题/);
        assert.doesNotMatch(JSON.stringify(messages), /GOLD_PRIVATE_REFERENCE|synthetic-reference/);
        return { content: report("pass"), toolCalls: [] };
    } };
    const agent = createReadingChatAgent(text("先送药再回家[P3]。\n第1题答案：A\n第2题答案：履行送药的承诺。"), config, logger, library, {}, reviewer);
    const result = await agent.run(session, { id: "q", role: "user", content: "[语文题:reading-ab12-q1]" }) as AgentResult;
    assert.equal(reviews, 1); assert.equal(result.review?.status, "passed"); assert.equal(result.modelTurns, 2);
});

test("configured GLM models remain separate on the real HTTP adapter and feedback loop", async () => {
    const bodies: any[] = []; let reviewCalls = 0;
    const server = createServer(async (req, res) => {
        let raw = ""; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); bodies.push(body);
        const content = body.model === "glm-4.7" ? report(++reviewCalls === 1 ? "fail" : "pass") : bodies.length === 1 ? "wrong" : "corrected";
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
        const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const settings = loadConfig({ NODE_ENV: "test", SCHOOL_SUBJECT: "chinese", LLM_MODEL: "glm-4.5-air", LLM_API_KEY: "test-main-key", LLM_BASE_URL: baseUrl,
            ANSWER_REVIEW_ENABLED: "true", ANSWER_REVIEW_MODEL: "glm-4.7", ANSWER_REVIEW_BASE_URL: baseUrl, AGENT_TRACE_ENABLED: "false" });
        const library = new ReadingLibrary("unused"), corpus = readingFixture();
        library.question = async () => readingTask(corpus.passages[0]!, corpus.knowledge.slice(0, 1));
        const dependencies = createDependencies({ chatSessionRepository: new InMemoryChatSessionRepository(), readingLibrary: library, logger }, settings);
        const result = await dependencies.agentHarness.run(session, { id: "q", role: "user", content: "[语文题:reading-ab12-q1]" }) as AgentResult;
        assert.equal(result.content, "corrected"); assert.equal(result.review?.status, "passed");
        assert.deepEqual(bodies.map(body => body.model), ["glm-4.5-air", "glm-4.7", "glm-4.5-air", "glm-4.7"]);
        assert.ok(bodies.every(body => !body.tools));
        assert.ok(bodies.filter(body => body.model === "glm-4.7").every(body => body.response_format?.type === "json_object"));
        assert.ok(bodies.filter(body => body.model === "glm-4.5-air").every(body => !body.response_format));
        assert.doesNotMatch(JSON.stringify(result), /test-main-key/);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("malformed review gets one protocol correction without rerunning the solver or changing the candidate", async () => {
    let solves = 0, reviews = 0;
    const result = await run({ async turn() { solves++; return { content: "verified candidate", toolCalls: [] }; } }, {
        async turn(messages) {
            const payload = JSON.parse(messages.at(-1)!.content);
            assert.equal(payload.candidate, "verified candidate");
            if (++reviews === 1) return { content: "malformed", toolCalls: [] };
            assert.match(payload.protocolCorrection, /pass\/fail\/uncertain/);
            return { content: report("pass"), toolCalls: [] };
        },
    });
    assert.equal(solves, 1); assert.equal(reviews, 2);
    assert.equal(result.review?.status, "passed"); assert.equal(result.content, "verified candidate");
});
