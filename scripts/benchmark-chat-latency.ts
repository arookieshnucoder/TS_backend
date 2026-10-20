import { createApp } from "../src/app.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { loadConfig } from "../src/config/env.js";
import { loadEnvironment } from "../src/config/environment.js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Real login -> HTTP chat -> PostgreSQL experience library -> provider calls.
// Credentials are inherited from the process and never included in the report.
if (!process.env.LLM_API_KEY || !process.env.BENCH_LOGIN_PASSWORD) throw new Error("Process credentials required");
const label = process.argv[2] ?? "after";
if (!/^[a-z0-9-]+$/.test(label)) throw new Error("Invalid benchmark label");
const suite = process.env.BENCH_SUITE ?? "standard";
if (!["standard", "equations"].includes(suite)) throw new Error("Invalid benchmark suite");
const maxResponseMs = Number(process.env.BENCH_MAX_RESPONSE_MS ?? "60000");
if (!Number.isSafeInteger(maxResponseMs) || maxResponseMs < 1) throw new Error("Invalid latency limit");
const directory = resolve("data/chat-latency", label);
const config = loadConfig({ ...loadEnvironment(), SESSION_DATA_DIR: resolve(directory, "sessions"), AGENT_RUN_DATA_DIR: resolve(directory, "runs") });
const dependencies = createDependencies({ logger: { info() {}, error(name) { console.error(name); } } }, config);
await dependencies.auth!.initialize();
await dependencies.solutionSkills!.store.initialize();
await dependencies.workflows!.initialize();
const app = createApp(config, dependencies);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let cookie = "";
async function request(path: string, body?: unknown) {
    const response = await fetch(origin + path, { method: body ? "POST" : "GET", signal: AbortSignal.timeout(180000),
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Cookie: cookie },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    if (path === "/api/auth/login") cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const result = await response.json() as any;
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${result.error?.code ?? ""}`);
    return result.data;
}
const standardQuestions = [
    "[数学] 计算 37+58，写出结果和一句验算。",
    "[数学] 一盒彩笔有若干支，取出7支后，剩余支数的3倍是54支。原来有多少支？列方程并验算。",
    "[数学] 计算 2468+1357，写出结果和一句验算。",
    "[英语] [Passage]\nLina planted six seeds on Monday. She watered them every morning. On Friday, two green shoots appeared.\n[Questions]\n1. When did the shoots appear?\nA. Monday\nB. Tuesday\nC. Friday\nD. Sunday",
    "[语文] [原文]\n放学后，小川看到窗台的花垂下了叶子。他接来一杯水，沿盆边慢慢浇下。第二天清晨，叶子又舒展开了，他露出了笑容。\n[题目]\n1. 小川为什么露出了笑容？请结合原文回答。",
];
const questions = suite === "equations" ? [
    "[数学] 解方程 3x+7=22，并验算。",
    "[数学] 解方程 -4x-9=19，并验算。",
    "[数学] 解方程 2x+3=11，并验算。",
    "[数学] 把刚才方程右边的11改成15，再解并验算。",
] : standardQuestions;
const expected = suite === "equations" ? [/答案[：:][^\n]*5/, /答案[：:][^\n]*-7/, /答案[：:][^\n]*4/, /答案[：:][^\n]*6/] :
    [/95/, /25/, /3825/, /第1题答案[：:]\s*C/, /花|叶子/];
const rows: { responseMs: number; [key: string]: unknown }[] = [];
let sharedSession: any;
try {
    const login = await request("/api/auth/login", { username: process.env.BENCH_LOGIN_EMAIL ?? "admin@123.com", password: process.env.BENCH_LOGIN_PASSWORD });
    if (login.user.role !== "admin") throw new Error("Admin login required");
    for (const [index, question] of questions.slice(0, Number(process.env.BENCH_CASES ?? questions.length)).entries()) {
        // Equation cases deliberately share history; the last correction must use the full workflow.
        const session = suite === "equations" && sharedSession ? sharedSession : await request("/api/chat/sessions", { title: `性能联调 ${label}` });
        sharedSession = session;
        const started = performance.now();
        const answer = await request(`/api/chat/sessions/${session.id}/messages`, { content: question });
        const responseMs = Math.round(performance.now() - started);
        const traces = await dependencies.runs!.list(session.id);
        const trace = await dependencies.runs!.get(session.id, traces.runs[0]!.id);
        const review = trace.events.filter(event => event.name === "agent.review.completed").at(-1)?.fields.status;
        const modelEvents = trace.events.filter(event => event.name === "agent.model.completed" ||
            event.name === "agent.subagent.event" && event.fields.event === "agent.model.completed");
        const modelMs = modelEvents.reduce((total, event) => total + Number(event.fields.durationMs ?? 0), 0);
        const reviewMs = modelEvents.filter(event => String(event.fields.agent ?? "").endsWith("_reviewer"))
            .reduce((total, event) => total + Number(event.fields.durationMs ?? 0), 0);
        const ready = trace.events.find(event => event.name === "answer.ready");
        const row = { question, responseMs, status: answer.sessionStatus, review, answer: answer.messages.at(-1)?.content,
            modelCalls: modelEvents.length, modelMs, reviewMs, afterAnswerMs: responseMs - (trace.answerDurationMs ?? responseMs),
            toolCalls: ready?.fields.toolCalls, retries: trace.events.filter(event => event.name === "agent.retry" ||
                event.name === "agent.subagent.event" && event.fields.event === "agent.retry").length,
            fastPath: trace.events.find(event => event.name === "math.fast_path")?.fields.reason,
            stages: trace.events.filter(event => /skills.search|workflow.completed|review.completed|maintenance|answer.ready|model.completed|subagent.completed/.test(event.name))
                .map(event => ({ name: event.name, elapsedMs: event.elapsedMs, fields: event.fields })) };
        rows.push(row);
        console.log(JSON.stringify({ question, responseMs, review, modelCalls: row.modelCalls, modelMs, reviewMs, fastPath: row.fastPath, answer: row.answer }));
        await mkdir("benchmarks", { recursive: true });
        const times = rows.map(row => row.responseMs).sort((a, b) => a - b);
        await writeFile(resolve("benchmarks", `chat-latency-${label}.json`), JSON.stringify({ label, suite,
            solver: config.llmModel, reviewer: config.verification.model, maxResponseMs,
            summary: { cases: times.length, p50Ms: times[Math.ceil(times.length * .5) - 1], p95Ms: times[Math.ceil(times.length * .95) - 1], maxMs: times.at(-1) }, rows }, null, 2));
        if (answer.sessionStatus !== "finished" || review !== "passed" || !expected[index]!.test(row.answer ?? ""))
            throw new Error(`Case ${index + 1} did not return the expected independently reviewed answer`);
        if (responseMs > maxResponseMs) throw new Error(`Case ${index + 1} exceeded ${maxResponseMs}ms latency limit`);
    }
    if (process.env.BENCH_WAIT_MAINTENANCE === "true") await app.locals.chatBackground?.drain();
} finally {
    await app.locals.chatBackground?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.allSettled([dependencies.mcp.close(), dependencies.auth!.store.close(), dependencies.solutionSkills!.store.close(), dependencies.workflows!.close()]);
}
