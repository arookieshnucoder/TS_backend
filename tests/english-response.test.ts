import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EnglishHarness } from "../src/modules/english/harness.js";
import { canonicalEnglishResponse } from "../src/modules/english/response.js";
import { englishTask } from "../src/modules/english/contracts.js";
import { englishChoice } from "../src/modules/english/agent.js";
import { englishFixture } from "./english-fixtures.js";
import { loadConfig } from "../src/config/env.js";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createDependencies } from "../src/bootstrap/container.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";
const corpus = englishFixture(), task = englishTask(corpus.passages[0]!, corpus.knowledge);
task.questions.forEach(q => q.kind = "grammar");
const response = "先送药后回家[P3]，履行承诺体现责任感[P1]。\n第1题答案：A\n第2题答案：B";
const config = loadConfig({ NODE_ENV: "test", AGENT_MODEL_RETRIES: "0", AGENT_MAX_TOOL_STEPS: "1" }), logger = { info() {}, error() {} };
const input = { history: [], question: "", tools: [], metadata: {} };

test("Harness canonicalizes identical repeated conclusions while the strict grader still rejects raw repetition", () => {
    const raw = response + "\n第1题答案：A\n第2题答案：B";
    assert.equal(englishChoice(raw, 1), undefined);
    const result = canonicalEnglishResponse(raw, task)!;
    assert.equal(englishChoice(result, 1), "A"); assert.equal(englishChoice(result, 2), "B");
    assert.match(result, /履行承诺/);
    for (const invalid of ["第1题答案：A", response + "\n第1题答案：D", response + "\n第1题答案：AB", "第1题答案：AB\n第2题答案：B", "只有解释没有答案"]) assert.equal(canonicalEnglishResponse(invalid, task), undefined);
});

test("grounded harness repairs missing or conflicting conclusions once from original evidence", async () => {
    let calls = 0; const events: string[] = [];
    const result = await new EnglishHarness({ async turn(messages) {
        calls++; const prompt = JSON.stringify(messages);
        assert.doesNotMatch(prompt, /english-fixture-q|"expected"|"category"|referenceUrls/);
        if (calls === 1) return { content: "第1题答案：A\n第1题答案：D", toolCalls: [] };
        assert.match(prompt, /遗漏或冲突/);
        return { content: response, toolCalls: [] };
    } }, task, "adaptive", config.context, logger).run({ ...input, onEvent(name) { events.push(name); } });
    assert.equal(calls, 2); assert.equal(result.modelTurns, 2); assert.equal(englishChoice(result.content, 2), "B");
    assert.equal(result.review, undefined); assert.ok(events.includes("english.response.invalid")); assert.ok(events.includes("english.response.validated"));
});

test("permanent malformed responses stop after one repair and never manufacture answer labels", async () => {
    let calls = 0;
    const result = await new EnglishHarness({ async turn() { calls++; return { content: "第1题答案：A\n第1题答案：D", toolCalls: [] }; } }, task, "adaptive", config.context, logger).run(input);
    assert.equal(calls, 2); assert.match(result.content, /遗漏或冲突/); assert.equal(englishChoice(result.content, 1), undefined);
});

test("flipping all reference labels cannot change the grounded prompt, context or answer", async () => {
    const prompts: string[] = [];
    for (const flip of [false, true]) {
        const copy = structuredClone(corpus); if (flip) copy.knowledge.forEach(q => q.answer = q.answer === "A" ? "D" : "A");
        const result = await new EnglishHarness({ async turn(messages) { prompts.push(JSON.stringify(messages)); return { content: response, toolCalls: [] }; } },
            { ...englishTask(copy.passages[0]!, copy.knowledge), questions: task.questions }, "adaptive", config.context, logger).run(input);
        assert.equal(englishChoice(result.content, 1), "A");
    }
    assert.equal(prompts[0], prompts[1]);
    for (const file of ["agent.ts", "harness.ts", "response.ts", "evidence.ts"]) assert.doesNotMatch(await readFile("src/modules/english/" + file, "utf8"), /from.*(?:bank|corpus|library)/);
});

test("bounded answer repair respects cancellation and does not leave a valid-looking stale answer", async () => {
    const controller = new AbortController(); let calls = 0;
    await assert.rejects(new EnglishHarness({ async turn() { calls++; controller.abort(); return { content: response, toolCalls: [] }; } }, task, "adaptive", config.context, logger).run(input, controller.signal), { name: "AbortError" });
    assert.equal(calls, 1);
});

test("grounded reading delegates each question through generic capabilities with isolated originals and current requirements", async () => {
    const reading = englishTask(corpus.passages[0]!, corpus.knowledge); let calls = 0;
    const result = await new EnglishHarness({ async turn(messages, tools) {
        calls++; assert.deepEqual(tools, []);
        if (messages.some(m => m.role === "tool")) return { content: response, toolCalls: [] };
        assert.deepEqual(messages.map(m => m.role), ["system", "user"]);
        const prompt = messages.at(-1)!.content;
        assert.match(prompt, /Mia did not return home/); assert.match(prompt, /解释简短/);
        assert.doesNotMatch(prompt, /PRIVATE_HISTORY|PREVIOUS_ASSISTANT|"answer"|"category"/);
        const number = Number(prompt.match(/第(\d+)题（/)![1]);
        assert.equal([...prompt.matchAll(/第\d+题（/g)].length, 1);
        return { content: `证据[P1]。\n第${number}题答案：${number === 1 ? "A" : "B"}`, toolCalls: [] };
    } }, reading, "adaptive", config.context, logger).run({ ...input, question: "解释简短", history: [{ role: "user", content: "PRIVATE_HISTORY" }, { role: "assistant", content: "PREVIOUS_ASSISTANT" }] });
    assert.equal(calls, 3); assert.equal(result.modelTurns, 3); assert.equal(result.toolCalls, 1);
    assert.equal(englishChoice(result.content, 1), "A"); assert.equal(englishChoice(result.content, 2), "B"); assert.equal(result.review, undefined);
});

test("a failed English worker uses one bounded parent solve for remaining questions and retains measured usage", async () => {
    const reading = englishTask(corpus.passages[0]!, corpus.knowledge); let calls = 0;
    const result = await new EnglishHarness({ async turn(messages) {
        calls++;
        if (calls === 1) return { content: response, toolCalls: [] };
        if (calls === 3) throw new Error("unavailable isolated worker");
        if (calls === 4) assert.match(messages.at(-1)!.content, /尚未完成的题号2/);
        return { content: `第${calls === 2 ? 1 : 2}题答案：${calls === 2 ? "A" : "B"}`, toolCalls: [] };
    } }, reading, "adaptive", config.context, logger, 1800, { recovery: { modelRetries: 0 } }).run(input);
    assert.equal(calls, 4); assert.equal(result.modelTurns, 4); assert.equal(englishChoice(result.content, 2), "B");
});

test("English GLM thinking configuration is independent of mathematics and matches the live evaluation mode", async () => {
    const received: string[] = [];
    const server = createServer(async (request, response) => {
        let body = ""; for await (const chunk of request) body += chunk;
        received.push(JSON.parse(body).thinking.type);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "第1题答案：A" } }] }));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
        for (const thinking of [undefined, "enabled"]) {
            const settings = loadConfig({ NODE_ENV: "test", SCHOOL_SUBJECT: "english", LLM_MODEL: "glm-4.5-air", GLM_THINKING: "enabled",
                ENGLISH_THINKING: thinking, LLM_API_KEY: "local-fixture-only", LLM_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
            assert.equal(settings.math.thinking, "enabled"); assert.equal(settings.english.thinking, thinking ?? "disabled");
            const dependencies = createDependencies({ logger, chatSessionRepository: new InMemoryChatSessionRepository() }, settings);
            const session = { id: "s", requestId: "r", title: "t", messages: [], createdAt: new Date(), updatedAt: new Date(), sessionStatus: "finished" as const, sessionError: null };
            const result = await dependencies.agentHarness.run(session, { id: "q", role: "user", content: "[英语]\nHe has lived here ___ 2020.\nA. since\nB. for\nC. at\nD. from" });
            assert.equal(englishChoice(result.content, 1), "A");
        }
        assert.deepEqual(received, ["disabled", "enabled"]);
        assert.throws(() => loadConfig({ ENGLISH_THINKING: "unknown" }), /English configuration/);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("disagreement arbitration sees only the current question's model candidates and never sibling answers", async () => {
    let calls = 0;
    const result = await new EnglishHarness({ async turn(messages) {
        calls++;
        if (calls === 1) return { content: "第1题答案：D\n第2题答案：B", toolCalls: [] };
        const prompt = messages.at(-1)!.content, number = Number(prompt.match(/第(\d+)题（/)![1]);
        if (calls === 3) {
            assert.match(prompt, /模型候选/); assert.match(prompt, /A\. She delivered/); assert.match(prompt, /D\. Her mother/);
            assert.doesNotMatch(prompt, /第2题|Responsibility|Fear/);
        }
        return { content: `第${number}题答案：${number === 1 ? "A" : "B"}`, toolCalls: [] };
    } }, englishTask(corpus.passages[0]!, corpus.knowledge), "adaptive", config.context, logger).run(input);
    assert.equal(calls, 4); assert.equal(result.modelTurns, 4); assert.equal(englishChoice(result.content, 1), "A");
});
