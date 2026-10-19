import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { GlmModel } from "../src/infrastructure/llm/glm-model.js";
import type { AgentModel } from "../src/modules/agent/model.js";
import { draftSchema, skillRevision } from "../src/modules/harness/skills/document.js";
import type { SolutionSkillDraft } from "../src/modules/harness/skills/contracts.js";

for (const key of ["LLM_API_KEY", "AUTH_DATABASE_URL", "SKILLS_SMOKE_PASSWORD"]) if (!process.env[key]) throw new Error(`Set ${key} in the launching process`);
const output = resolve(process.env.SKILLS_SMOKE_OUT ?? `data/skills-smoke/${new Date().toISOString().replace(/[:.]/g, "-")}`);
const config = loadConfig({ ...process.env, NODE_ENV: "test", AUTH_ENABLED: "true", SCHOOL_SUBJECT: "auto", MATH_AGENT_VARIANT: "adaptive",
    SOLUTION_SKILLS_ENABLED: "true", GLM_THINKING: "disabled", ENGLISH_THINKING: "disabled", LLM_MODEL: "glm-4.5-air",
    LLM_BASE_URL: "https://open.bigmodel.cn/api/paas/v4", ANSWER_REVIEW_ENABLED: "true", ANSWER_REVIEW_MODEL: "glm-4.7",
    LLM_TIMEOUT_MS: "240000", AGENT_MODEL_ATTEMPT_TIMEOUT_MS: "90000", AGENT_TRACE_ENABLED: "true", AGENT_TRACE_MAX_EVENTS: "1024",
    SESSION_DATA_DIR: join(output, "sessions"), AGENT_RUN_DATA_DIR: join(output, "runs"), AGENT_WORKSPACE_ENABLED: "false",
});
const calls: { model: string; toolDefinitions: string[]; inputTokens?: number; outputTokens?: number }[] = [];
const model = (name: string): AgentModel => {
    const inner = new GlmModel({ llmModel: name, llmApiKey: config.llmApiKey, llmBaseUrl: config.llmBaseUrl, llmTimeoutMs: config.llmTimeoutMs });
    return { async turn(messages, tools, signal, maxOutput) {
        const entry = { model: name, toolDefinitions: tools.map(tool => tool.name) }; calls.push(entry);
        try { const result = await inner.turn(messages, tools, signal, maxOutput); Object.assign(entry, result.usage, { response: result.content }); return result; }
        catch (error) { Object.assign(entry, { failure: { name: error instanceof Error ? error.name : "Error", status: (error as { status?: number })?.status } }); throw error; }
    } };
};
const dependencies = createDependencies({ agentModel: model("glm-4.5-air"), reviewerModel: model("glm-4.7"), logger: { info() {}, error() {} } }, config);
const server = createApp(config, dependencies).listen(0, "127.0.0.1");
const listening = once(server, "listening");
const defaultCases = [
    { id: "math-new", subject: "math", question: "解方程 x²-7x+12=0，给出全部实数根并代回检验。" },
    { id: "math-number", subject: "math", question: "解方程 x²-9x+20=0，给出全部实数根并代回检验。", reuse: true },
    { id: "math-paraphrase", subject: "math", question: "已知二次多项式 x²-11x+30 的值为零，请用因式分解法求出所有满足条件的x，并验证。", reuse: true },
    { id: "math-distinct", subject: "math", question: "圆的半径为5，圆心到弦AB的距离为3，求弦AB的长度。" },
    { id: "english", subject: "english", question: "[英语]\n第1题：By the time we arrived, the train ____.\nA. leaves\nB. has left\nC. had left\nD. will leave" },
    { id: "chinese", subject: "chinese", question: "[原文]\n小林第一次参加朗读比赛时，因为紧张忘了词。他低着头走下台，决定再也不参加比赛。\n老师没有责备他，而是每天陪他练习，提醒他先理解文章，再慢慢读出来。\n一个月后，小林再次站上讲台。他仍有些紧张，却顺利读完了全文。他望向老师，露出了笑容。\n[题目]\n第1题：小林前后发生了怎样的变化？请结合原文简要分析变化的原因。" },
];
const cases: { id: string; subject: string; question: string; reuse?: boolean; expect?: string; updateFields?: (keyof SolutionSkillDraft)[] }[] =
    (process.env.SKILLS_SMOKE_FIXTURES ? JSON.parse(await readFile(process.env.SKILLS_SMOKE_FIXTURES, "utf8")) : defaultCases)
        .filter((item: { id: string }) => !process.env.SKILLS_SMOKE_CASES || process.env.SKILLS_SMOKE_CASES.split(",").includes(item.id));
const results: unknown[] = [];
const failures: string[] = [];
try {
    await dependencies.auth!.initialize(); await dependencies.solutionSkills!.store.initialize();
    await listening; const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let cookie = "";
    async function request(path: string, body?: unknown): Promise<any> {
        const response = await fetch(`${base}/api${path}`, { method: body === undefined ? "GET" : "POST", headers: {
            "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: config.frontendOrigin, ...(cookie ? { Cookie: cookie } : {}),
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(250000) });
        const rawCookie = response.headers.get("set-cookie"); if (rawCookie) cookie = rawCookie.split(";")[0]!;
        const result = await response.json(); if (!response.ok) throw new Error(`HTTP ${response.status} ${result.error?.code ?? "request_failed"}`); return result.data;
    }
    const login = await request("/auth/login", { username: process.env.SKILLS_SMOKE_USERNAME ?? "admin@123.com", password: process.env.SKILLS_SMOKE_PASSWORD });
    assert.equal(login.user.role, "admin"); console.log("login: passed (existing administrator)");
    for (const item of cases) {
        const currentSkills = await dependencies.solutionSkills!.store.list("math");
        const quadratic = currentSkills.find(skill => skill.name === "quadratic-equation-solving");
        const composite = currentSkills.find(skill => skill.name === "quadratic-chord-composite");
        const question = item.question.replace(/\{\{quadraticId\}\}/g, quadratic?.id ?? "missing").replace(/\{\{quadraticRevision\}\}/g, String(quadratic?.revision ?? 1))
            .replace(/\{\{compositeId\}\}/g, composite?.id ?? "missing").replace(/\{\{compositeRevision\}\}/g, String(composite?.revision ?? 1));
        const beforeSkills = await dependencies.solutionSkills!.store.list(item.subject), before = beforeSkills.length;
        const session = await request("/chat/sessions", { title: `Skills smoke ${item.id}` });
        const started = Date.now(), callStart = calls.length;
        const answered = await request(`/chat/sessions/${session.id}/messages`, { content: question });
        assert.equal(answered.sessionStatus, "finished");
        const summaries = await request(`/observability/sessions/${session.id}/runs`);
        const trace = await request(`/observability/sessions/${session.id}/runs/${summaries.runs[0].id}`);
        const events = trace.events as { name: string; fields: Record<string, any> }[];
        assert.ok(events.some(event => event.name === "agent.review.completed" && event.fields.status === "passed"));
        assert.ok(events.some(event => event.name === "agent.skills.search"));
        assert.ok(!events.some(event => event.name === "math.retrieval"));
        const learning = events.filter(event => ["agent.skills.created", "agent.skills.updated", "agent.skills.split", "agent.skills.reused", "agent.skills.rejected", "agent.skills.skipped"].includes(event.name));
        const afterSkills = await dependencies.solutionSkills!.store.list(item.subject), after = afterSkills.length;
        const caseFailures: string[] = [];
        const updates = [];
        for (const event of learning.filter(event => event.name === "agent.skills.updated")) {
            const oldSkill = beforeSkills.find(skill => skill.id === event.fields.id)!, newSkill = afterSkills.find(skill => skill.id === event.fields.id)!;
            const history = await dependencies.solutionSkills!.store.history(item.subject, newSkill.id);
            assert.equal(skillRevision(newSkill), skillRevision(oldSkill) + 1);
            assert.deepEqual(history.at(-2), oldSkill); assert.deepEqual(history.at(-1), newSkill);
            // 指定局部变更范围的案例，必须逐字段验证其余方法内容没有被重写。
            for (const field of Object.keys(draftSchema.properties) as (keyof SolutionSkillDraft)[])
                if (item.updateFields && !item.updateFields.includes(field) && JSON.stringify(oldSkill[field]) !== JSON.stringify(newSkill[field])) caseFailures.push(`局部更新改动了未授权字段 ${field}`);
            updates.push({ id: newSkill.id, beforeRevision: skillRevision(oldSkill), afterRevision: skillRevision(newSkill), versions: history.length });
        }
        if (item.reuse && (after !== before || !events.some(event => event.name === "agent.skills.loaded") && !learning.some(event => ["agent.skills.reused", "agent.skills.updated"].includes(event.name))))
            caseFailures.push("复用题不应新增记录，且应读取或完善已有经验");
        if (!item.reuse && !learning.some(event => ["agent.skills.created", "agent.skills.updated", "agent.skills.split", "agent.skills.reused"].includes(event.name))) caseFailures.push("新题未形成可审核的新经验或复用关系");
        if (item.expect && !events.some(event => event.name === item.expect)) caseFailures.push(`缺少预期事件 ${item.expect}`);
        failures.push(...caseFailures.map(failure => `${item.id}: ${failure}`));
        for (const skill of await dependencies.solutionSkills!.store.list(item.subject)) {
            assert.equal(await readFile(join(config.skills.directory, item.subject, skill.id, "SKILL.md"), "utf8"), skill.markdown);
        }
        results.push({ id: item.id, sessionId: session.id, question, answer: answered.messages.at(-1)?.content, durationMs: Date.now() - started,
            before, after, learning, updates, failures: caseFailures, calls: calls.slice(callStart), trace: { status: trace.status, eventCount: events.length } });
        console.log(`${item.id}: answer reviewed; skills ${before} -> ${after}; ${learning.map(event => event.name).join(", ")}`);
    }
    await request("/auth/logout", {});
} finally {
    await mkdir(output, { recursive: true }); await writeFile(join(output, "report.json"), JSON.stringify({ models: [config.llmModel, config.verification.model], failures, results, calls }, null, 2));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all([dependencies.mcp.close(), dependencies.auth?.store.close(), dependencies.solutionSkills?.store.close()]);
    console.log(`report: ${join(output, "report.json")}`);
    if (failures.length) { console.error(`${failures.length} experience checks failed; inspect report`); process.exitCode = 1; }
}
