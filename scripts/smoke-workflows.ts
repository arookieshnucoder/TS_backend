import assert from "node:assert/strict";
import { graphIssues } from "../src/modules/workflows/definition.js";

// Live test credentials are process-only; do not bake them into scripts or reports.
const base = process.env.APP_BASE_URL ?? "http://localhost:8080";
const username = process.env.SMOKE_USERNAME, password = process.env.SMOKE_PASSWORD;
if (!username || !password) throw new Error("SMOKE_USERNAME and SMOKE_PASSWORD are required");
const headers = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000" };
const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers, body: JSON.stringify({ username, password }) });
assert.equal(login.status, 200, "administrator login");
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
async function request(path: string, body?: unknown) {
    const response = await fetch(base + "/api" + path, { method: body === undefined ? "GET" : "POST", headers: { ...headers, Cookie: cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180000) });
    const payload = await response.json() as any;
    // A failed chat still returns its recorded session, which must be inspected
    // before asserting success so provider failures remain visible in the report.
    assert.ok(response.ok || response.status === 400 && path.endsWith('/messages') && payload.data?.id, `${path}: HTTP ${response.status}`);
    return payload.data;
}
const cases = [
    { subject: "math", question: "[数学] 解方程 2x+3=11，写出计算步骤。" },
    { subject: "chinese", question: "[语文]\n[原文]\n放学时下起了雨。小林把自己的伞递给忘带伞的同学，自己跑回了家。\n[题目]\n1. 小林把伞递给同学体现了什么品质？请结合原文回答。" },
    { subject: "english", question: "[英语]\n1. She ____ to school every day.\nA. go\nB. goes\nC. going\nD. gone" },
];
async function runCase(item: typeof cases[number]) {
    const session = await request("/chat/sessions", { title: `画布联调 · ${item.subject}` });
    const result = await request(`/chat/sessions/${session.id}/messages`, { content: item.question });
    const list = await request(`/observability/sessions/${session.id}/runs`);
    const trace = await request(`/observability/sessions/${session.id}/runs/${list.runs[0].id}`);
    assert.equal(trace.workflow?.subject, item.subject); assert.deepEqual(graphIssues(trace.workflow.graph), []);
    const main = trace.events.filter((e: any) => e.name === "agent.model.started").map((e: any) => e.fields.model);
    const child = trace.events.filter((e: any) => e.name === "agent.subagent.event" && e.fields.event === "agent.model.started").map((e: any) => ({ model: e.fields.model, agent: e.fields.agent }));
    const review = trace.events.filter((e: any) => e.name === "agent.review.completed").map((e: any) => e.fields.status);
    const report = { subject: item.subject, sessionId: session.id, runId: trace.id, revision: trace.workflow.revision, status: trace.status, solver: [...new Set(main)], reviewers: child.filter((e: any) => e.agent.endsWith("_reviewer")), review, events: trace.events.length, answer: result.messages.at(-1)?.content };
    console.log(JSON.stringify(report));
    assert.ok(main.includes("glm-4.5-air"));
    assert.ok(child.some((e: any) => e.model === "glm-4.7" && e.agent.endsWith("_reviewer")));
    assert.ok(review.includes("passed"));
    assert.equal(result.sessionStatus, "finished"); assert.equal(trace.status, "success");
}
// One API key may have a small concurrency quota. Exercise the three subjects
// serially; retries inside a run remain owned by the existing harness.
for (const item of cases.filter(c => !process.env.SMOKE_SUBJECT || c.subject === process.env.SMOKE_SUBJECT)) {
    try { await runCase(item); }
    catch (failure) { console.error(`${item.subject}: ${failure instanceof Error ? failure.message : "live test failed"}`); process.exitCode = 1; }
}
