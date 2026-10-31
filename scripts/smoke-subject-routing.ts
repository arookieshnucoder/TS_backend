import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config/env.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { closeApplicationResources } from "../src/bootstrap/lifecycle.js";
import { GlmModel } from "../src/infrastructure/llm/glm-model.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";
import { PostgresSkillStore } from "../src/infrastructure/persistence/postgres/postgres-skill.store.js";
import { SubjectClassifier } from "../src/modules/subjects/subject-classifier.js";
import { SolutionSkillLibrary } from "../src/modules/harness/skills/library.js";
import { ChatSessionService } from "../src/modules/chat/service/chat-session.service.js";
import { BackgroundWorkQueue } from "../src/modules/chat/service/background-work.js";
import type { ChatSession } from "../src/modules/chat/entity/chat-session.entity.js";

// Live providers, in-memory conversations and read-only skill access. Smoke runs cannot learn.
const config = loadConfig();
if (!config.llmApiKey) throw new Error("Set LLM_API_KEY in the launching process");
const empty: ChatSession = { id: "smoke", requestId: "smoke", title: "smoke", messages: [], createdAt: new Date(), updatedAt: new Date(), sessionStatus: "finished", sessionError: null };
const classifier = new SubjectClassifier(new GlmModel({ llmApiKey: config.subjectClassification.apiKey, llmModel: config.subjectClassification.model,
    llmBaseUrl: config.subjectClassification.baseUrl, llmTimeoutMs: config.subjectClassification.timeoutMs }, "disabled", { jsonOutput: true }), config.subjectClassification.timeoutMs);
const results: object[] = [];
const cases = [
    { content: "[数学] 请赏析李白《静夜思》中的思乡之情。", preferred: "math", expected: "chinese" },
    { content: "解方程 x²-5x+6=0", preferred: "chinese", expected: "math" },
    { content: "He has lived here ___ 2020. A. since B. for C. at D. from", preferred: "math", expected: "english" },
    { content: "请继续解释为什么用了比喻。", preferred: "math", expected: "chinese", history: [{ id: "poem", role: "user" as const, content: "赏析古诗词的修辞手法", subject: "chinese" as const }] },
    { content: "你好", preferred: "math", expected: undefined },
] as const;
for (const item of cases) {
    const started = Date.now();
    const subject = await classifier.classify({ ...empty, messages: "history" in item ? [...item.history] : [] }, { id: "q", role: "user", content: item.content }, undefined, item.preferred);
    assert.equal(subject, item.expected);
    results.push({ expected: item.expected ?? "unknown", actual: subject ?? "unknown", durationMs: Date.now() - started });
}

const store = new PostgresSkillStore(config.skills.databaseUrl);
const accessed: string[] = [];
const readOnly = { initialize: () => store.initialize(), list: async (subject: string) => { accessed.push(subject); return store.list(subject); },
    history: store.history.bind(store), withSubjectLock: async () => { throw new Error("SMOKE_WRITES_DISABLED"); }, close: () => store.close() };
const skills = new SolutionSkillLibrary(readOnly, join(config.skills.directory, "smoke-unused-export"));
const repository = new InMemoryChatSessionRepository();
const dependencies = createDependencies({ solutionSkills: skills, chatSessionRepository: repository, logger: { info() {}, error() {} } },
    { ...config, auth: { ...config.auth, enabled: false }, schoolSubject: "math", observability: { ...config.observability, enabled: false } });
const background = new BackgroundWorkQueue();
// Intentionally register, but do not execute, any proposed smoke maintenance.
const agent = dependencies.agentHarness;
const events: { name: string; fields?: Record<string, unknown> }[] = [];
const service = new ChatSessionService(repository, { ...agent, run: (session, current, signal, context) => agent.run(session, current, signal, context ? { ...context,
    event: (name, fields) => { if (["agent.review.completed", "agent.skills.search", "agent.subagent.started"].includes(name)) events.push({ name, fields }); context.event(name, fields); },
    deferMaintenance: () => {} } : undefined) }, undefined, 180000, undefined, background);
try {
    const session = await service.create("跨学科实测", "subject-routing-smoke");
    const started = Date.now();
    const result = await service.send(session.id, "[数学]\n[原文]\n静夜思 李白\n床前明月光，疑是地上霜。举头望明月，低头思故乡。\n[题目]\n第1题：诗中表达了诗人怎样的情感？请结合末句简要分析。", undefined, "live-cross-subject", "math", "live-client-request");
    assert.equal(result.sessionStatus, "finished");
    assert.equal(result.subject, "chinese");
    assert.ok(result.messages.every(message => message.subject === "chinese"));
    assert.ok(accessed.length && accessed.every(subject => subject === "chinese"));
    assert.match(result.messages.at(-1)!.content, /思乡|思念|故乡/);
    assert.ok(events.some(event => event.name === "agent.review.completed" && event.fields?.status === "passed"));
    results.push({ integration: "math mode -> Chinese poetry", subject: result.subject, durationMs: Date.now() - started,
        skillsSubjects: [...new Set(accessed)], answer: result.messages.at(-1)!.content, maintenanceExecuted: false, events });
} finally { await closeApplicationResources(dependencies, background); }
const output = join(config.sessionDataDir, "..", "subject-routing-live");
await mkdir(output, { recursive: true });
await writeFile(join(output, "report.json"), JSON.stringify({ date: new Date().toISOString(), solver: config.llmModel, classifier: config.subjectClassification.model,
    reviewer: config.verification.model, results }, null, 2));
console.log(JSON.stringify({ passed: results.length, results }));
