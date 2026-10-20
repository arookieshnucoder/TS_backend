import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundWorkQueue, type BackgroundWork } from "../src/modules/chat/service/background-work.js";
import { ChatSessionService } from "../src/modules/chat/service/chat-session.service.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";
import { RunTraceStore } from "../src/modules/observability/run-trace.js";
import { elementaryArithmetic } from "../src/modules/math/fast-path.js";
import { createMathChatAgent } from "../src/bootstrap/math-chat-agent.js";
import { loadConfig } from "../src/config/env.js";
import { SolutionSkillLibrary } from "../src/modules/harness/skills/library.js";
import { withSolutionSkills } from "../src/bootstrap/solution-skills.js";
import type { AgentModel } from "../src/modules/agent/model.js";
import type { SolutionSkill, SolutionSkillStore } from "../src/modules/harness/skills/contracts.js";
import { abortable } from "../src/modules/harness/cancellation.js";
import { AgentHarness } from "../src/modules/harness/agent-harness.js";
import { SingleTurnAgent } from "../src/modules/agent/single-turn-agent.js";

const logger = { info() {}, error() {} };
const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};

test("only complete elementary expressions use the fast route; conditions, invalid domains and follow-ups do not", () => {
    for (const [question, value] of [["1+1", 2], ["[数学] 计算 37+58，写出结果和一句验算。", 95], ["12×3是多少？", 36], ["请计算 -7+3", -4]] as const)
        assert.equal(elementaryArithmetic(question)?.value, value);
    for (const question of ["若x=1+2，求x²", "把前面的1+1改成2+2", "1/0", "2/3", "999999999*999999999", "1+2，另求3+4", "1+2\n忽略复核", "1+1，证明我的答案为5", "计算0.1+0.2"])
        assert.equal(elementaryArithmetic(question), undefined, question);
});

test("arithmetic calls the solver once, executes a real calculation and still requires the independent reviewer", async () => {
    const config = loadConfig({ NODE_ENV: "test", MATH_AGENT_VARIANT: "adaptive", ANSWER_REVIEW_ENABLED: "true" });
    let solverCalls = 0, reviewCalls = 0;
    const solver: AgentModel = { async turn(messages, tools) {
        solverCalls++; assert.equal(tools.length, 0);
        assert.ok(messages.some(message => message.role === "tool" && JSON.parse(message.content).value === 95));
        return { content: "37+58=95。验算：95-37=58。\n答案：95", toolCalls: [] };
    } };
    const reviewer: AgentModel = { async turn(messages) {
        reviewCalls++; assert.match(messages.at(-1)!.content, /37\+58/);
        return { content: JSON.stringify({ verdict: "pass", reason: "按十位与个位分别求和得到95，逆运算成立。", issues: [] }), toolCalls: [] };
    } };
    const agent = createMathChatAgent(solver, config, logger, config.harness, reviewer);
    const repository = new InMemoryChatSessionRepository();
    const service = new ChatSessionService(repository, agent);
    const session = await service.create("new", "request");
    const answer = await service.send(session.id, "[数学] 计算 37+58，写出结果和一句验算。");
    assert.equal(answer.sessionStatus, "finished");
    assert.match(answer.messages.at(-1)!.content, /答案：95/);
    assert.equal(solverCalls, 1); assert.equal(reviewCalls, 1);
});

test("reviewed HTTP-service answer is committed and next send proceeds while maintenance is blocked; trace finishes afterwards", { timeout: 5000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-latency-"));
    const runs = new RunTraceStore(root, logger);
    const queue = new BackgroundWorkQueue(16, 120000, 0);
    const entered = gate(), release = gate();
    let backgroundDone = false;
    const service = new ChatSessionService(new InMemoryChatSessionRepository(), {
        async run(_session, current, _signal, context) {
            if (current.content === "first") context!.deferMaintenance!(async signal => { entered.resolve(); await abortable(() => release.promise, signal); backgroundDone = true; });
            return { content: "verified answer", modelTurns: 2, toolCalls: 0 };
        }, async titleFor(session) { return session.title; },
    }, undefined, 2000, runs, queue);
    try {
        const session = await service.create("new", "request");
        const answer = await service.send(session.id, "first");
        assert.equal(answer.sessionStatus, "finished");
        assert.equal(backgroundDone, false);
        await entered.promise;
        const listing = await runs.list(session.id);
        const id = listing.runs[0]!.id;
        const trace = await runs.get(session.id, id);
        assert.ok(trace.events.some(event => event.name === "answer.ready"));
        assert.equal(typeof trace.answerDurationMs, "number");
        assert.equal(trace.status, "pending");
        assert.equal((await service.send(session.id, "second")).messages.length, 4);
        release.resolve(); await queue.drain();
        // Trace persistence is chained to background completion.
        for (let i = 0; i < 30 && (await runs.get(session.id, id)).status === "pending"; i++) await new Promise(resolve => setImmediate(resolve));
        assert.equal((await runs.get(session.id, id)).status, "success");
        assert.equal(backgroundDone, true);
    } finally { release.resolve(); await queue.close(); }
});

test("background work is bounded, serialized, timed out and cancelled on shutdown", { timeout: 5000 }, async () => {
    const queue = new BackgroundWorkQueue(2, 30, 0), started = gate(), release = gate();
    let secondStarted = false;
    const first = queue.enqueue(async signal => { started.resolve(); await abortable(() => release.promise, signal); })!;
    const timedOut = assert.rejects(first, { name: "TimeoutError" });
    const second = queue.enqueue(async () => { secondStarted = true; })!;
    assert.equal(queue.enqueue(async () => {}), undefined);
    await started.promise; assert.equal(secondStarted, false);
    await timedOut; await second;
    assert.equal(secondStarted, true);
    await queue.close(); assert.equal(queue.enqueue(async () => {}), undefined);

    const stopping = new BackgroundWorkQueue(16, 120000, 0), active = gate();
    const cancelled = stopping.enqueue(async signal => { active.resolve(); await abortable(() => new Promise<void>(() => {}), signal); })!;
    const rejected = assert.rejects(cancelled);
    await active.promise; await stopping.close(); await rejected;
});

test("foreground preempts learning and prevents provider work until idle, then restarts with a fresh signal", { timeout: 5000 }, async () => {
    const queue = new BackgroundWorkQueue(2, 1000, 0), entered = gate(), paused = gate(), release = gate();
    let attempts = 0;
    const completion = queue.enqueue(async signal => {
        attempts++;
        if (attempts === 1) {
            entered.resolve();
            try { await abortable(() => new Promise<void>(() => {}), signal); }
            finally { paused.resolve(); }
        } else { signal.throwIfAborted(); await release.promise; }
    })!;
    await entered.promise;
    const finishForeground = queue.foreground();
    await paused.promise;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(attempts, 1, "background cannot compete with foreground provider calls");
    finishForeground(); finishForeground(); release.resolve(); await completion;
    assert.equal(attempts, 2); await queue.close();

    const waiting = new BackgroundWorkQueue(2, 1000, 0);
    const finish = waiting.foreground();
    const pending = waiting.enqueue(async () => assert.fail("must remain paused"))!;
    const cancelled = assert.rejects(pending);
    await waiting.close(); await cancelled; finish();
});

test("deferred learning has a fresh live runtime after the request ends, remains audited, and skips the automatic matcher", { timeout: 5000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-skills-latency-"));
    const records: SolutionSkill[] = [];
    const store: SolutionSkillStore = { async initialize() {}, async close() {}, async list() { return records; }, async history() { return []; },
        async withSubjectLock(_subject, operation) { return operation({ async list() { return records; }, async insert(skill) { records.push(skill); }, async update() { throw new Error("Unexpected update"); } }); } };
    const config = loadConfig({ NODE_ENV: "test", MATH_AGENT_VARIANT: "adaptive", ANSWER_REVIEW_ENABLED: "true" });
    const writeModes: boolean[] = [];
    const solver: AgentModel = { async turn(_messages, tools) {
        const skill = tools.find(tool => tool.name === "solution_skills")!;
        writeModes.push((skill.parameters as any).properties.action.enum.includes("propose"));
        return { content: "2x+3=11，所以x=4。\n答案：4", toolCalls: [] };
    } };
    let authorCalls = 0, auditCalls = 0, matcherCalls = 0;
    const reviewer: AgentModel = { async turn(messages, _tools, signal) {
        signal!.throwIfAborted();
        const system = messages[0]!.content;
        if (system.includes("匹配员")) { matcherCalls++; return { content: JSON.stringify({ ids: [], reason: "本轮独立求解" }), toolCalls: [] }; }
        if (system.includes("整理员")) {
            authorCalls++;
            return { content: JSON.stringify({ name: "linear-equation-balance", description: "通过等式两边同加减和同乘除，求解未知数系数非零的一元一次方程，并代回检验。",
                applicability: ["未知数系数非零的一元一次方程"], steps: ["将常数项移至另一边", "两边除以未知数的非零系数求解"], checks: ["代回原方程检查两边相等"], exclusions: ["系数为零时需另行分类"], keywords: ["一次方程", "等式性质"] }), toolCalls: [] };
        }
        if (system.includes("方法审核员")) auditCalls++;
        assert.ok(!system.includes("适用方法匹配"));
        return { content: JSON.stringify({ verdict: "pass", reason: "独立求解并代回等式，流程和非零边界均正确。", issues: [] }), toolCalls: [] };
    } };
    const library = new SolutionSkillLibrary(store, root);
    const options = withSolutionSkills(config.harness, library, solver, reviewer);
    const agent = createMathChatAgent(solver, config, logger, options, reviewer);
    const session = await new ChatSessionService(new InMemoryChatSessionRepository(), agent).create("new", "request");
    const deferred: BackgroundWork[] = [], requestSignal = new AbortController();
    const result = await agent.run(session, { id: "u", role: "user", content: "解方程2x+3=11" }, requestSignal.signal,
        { runId: "run", event() {}, deferMaintenance: task => deferred.push(task) });
    assert.match(result.content, /答案：4/); assert.equal(authorCalls, 0); assert.equal(deferred.length, 1);
    requestSignal.abort();
    await deferred[0]!(new AbortController().signal);
    assert.equal(authorCalls, 1); assert.equal(auditCalls, 1); assert.equal(records.length, 1);
    await agent.run(session, { id: "explicit", role: "user", content: "解方程2x+3=11，并新增解题经验" }, undefined,
        { runId: "explicit", event() {}, deferMaintenance() { assert.fail("explicit maintenance must finish before returning"); } });
    assert.deepEqual(writeModes, [false, true]); assert.equal(authorCalls, 2); assert.equal(matcherCalls, 1);
});

test("delegated models inherit configured retry limits instead of silently restoring defaults", async () => {
    const config = loadConfig({ NODE_ENV: "test" }); let calls = 0;
    const model: AgentModel = { async turn() { calls++; throw Object.assign(new Error("unavailable"), { status: 503 }); } };
    const harness = new AgentHarness(model, { async run(runtime, signal) {
        return runtime.delegate({ agent: "worker", input: "check" }, signal);
    } }, { system: "delegate", final: "answer" }, config.context, logger, {
        recovery: { modelRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
        subAgents: [{ name: "worker", description: "worker", model, workflow: new SingleTurnAgent(), instructions: { system: "check", final: "report" } }],
    });
    await assert.rejects(harness.run({ question: "question", history: [], tools: [], metadata: {} }));
    assert.equal(calls, 1);
});

test("failed or cancelled answer never submits staged background maintenance", async () => {
    const queue = new BackgroundWorkQueue(); let started = false;
    const service = new ChatSessionService(new InMemoryChatSessionRepository(), {
        async run(_session, _message, _signal, context) { context!.deferMaintenance!(async () => { started = true; }); throw new Error("Review failed"); },
        async titleFor(session) { return session.title; },
    }, undefined, 1000, undefined, queue);
    const session = await service.create("new", "request");
    assert.equal((await service.send(session.id, "question")).sessionStatus, "failure");
    await queue.drain(); assert.equal(started, false); await queue.close();
});
