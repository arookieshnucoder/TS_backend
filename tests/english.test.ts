import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { AgentMessage } from "../src/modules/agent/contracts.js";
import type { AgentModel } from "../src/modules/agent/model.js";
import { ModelProtocolError } from "../src/modules/agent/model.js";
import { englishFixture } from "./english-fixtures.js";
import { englishTask, englishQuestions, ENGLISH_VARIANTS } from "../src/modules/english/contracts.js";
import { englishHash, validateEnglishCorpus, loadEnglishCorpus } from "../src/modules/english/corpus.js";
import { authoredEnglish } from "../src/modules/english/authored-bank.js";
import { prepareEnglish } from "../src/modules/english/prepare.js";
import { EnglishLibrary, parseEnglishInput } from "../src/modules/english/library.js";
import { EnglishHarness } from "../src/modules/english/harness.js";
import { englishChoice } from "../src/modules/english/agent.js";
import { selectEnglishEvidence } from "../src/modules/english/evidence.js";
import { TokenBudget } from "../src/modules/harness/context/tokens.js";
import { createEnglishChatAgent } from "../src/bootstrap/english-chat-agent.js";
import { routeSchoolSubject } from "../src/bootstrap/school-subject.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { loadConfig } from "../src/config/env.js";
import { createApp } from "../src/app.js";
import { ReadingLibrary } from "../src/modules/reading/library.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";
const config = loadConfig({ NODE_ENV: "test", SCHOOL_SUBJECT: "english", ENGLISH_WORKFLOW: "direct", AGENT_MODEL_RETRIES: "0", AGENT_TOOL_RETRIES: "0", AGENT_WORKSPACE_ENABLED: "false" });
const logger = { info() {}, error() {} }, input = { history: [], question: "", tools: [], metadata: {} };
const session = { id: "session", requestId: "r", title: "t", messages: [], createdAt: new Date(), updatedAt: new Date(), sessionStatus: "finished" as const, sessionError: null };
const text = (content = "先送药再回家[P3]。\n第1题答案：A\n第2题答案：B"): AgentModel => ({ async turn() { return { content, toolCalls: [] }; } });

test("English modules implement generic contracts and never import mathematics, Chinese, or a subject harness", async () => {
    const files = await readdir("src/modules/english");
    for (const file of files.filter(f => f.endsWith(".ts"))) {
        const source = await readFile(join("src/modules/english", file), "utf8");
        assert.doesNotMatch(source, /from\s+["'][^"']*(?:\/reading\/|\/math\/|\/chinese\/|\/language\/)/);
    }
    assert.match(await readFile("src/modules/english/agent.ts", "utf8"), /implements AgentWorkflow/);
    assert.match(await readFile("src/modules/english/harness.ts", "utf8"), /extends PassageHarness/);
});

test("corpus rejects answer, option, type, article and family leakage errors", () => {
    const corpus = englishFixture(); validateEnglishCorpus(corpus);
    for (const mutate of [(c: any) => { c.knowledge[0].answer = "E"; }, (c: any) => { c.knowledge[0].options[1] = c.knowledge[0].options[0]; },
        (c: any) => { c.knowledge[0].type = "open"; }, (c: any) => { c.knowledge[0].kind = "listening"; },
        (c: any) => { c.test = [c.knowledge.pop()]; }, (c: any) => { c.passages.push({ ...c.passages[0], id: "other" }); },
        (c: any) => { c.passages[0].id = "../../escape"; }, (c: any) => { c.knowledge[0].id = "x/../escape"; }]) {
        const broken = structuredClone(corpus); mutate(broken); assert.throws(() => validateEnglishCorpus(broken));
    }
    const authored = authoredEnglish();
    assert.equal([...authored.knowledge, ...authored.development, ...authored.test].length, 200);
    for (const q of [...authored.knowledge, ...authored.development, ...authored.test]) {
        assert.equal(new Set(q.options).size, 4);
        if (q.kind === "cloze") assert.ok(authored.passages.find(p => p.id === q.passageId)!.paragraphs.join("").includes(`[[${q.blank}]]`));
    }
});

test("preparation deterministically builds exactly 500 attributed choice items with passage/family isolation", () => {
    const sources = (["train", "validation", "test"] as const).map(split => ({ split, rows: Array.from({ length: 190 }, (_, i) => ({
        example_id: `middle-${split}-${i}`, row: i, article: `${split} source article ${i}. ` + ("A school team visited a local history museum and carefully read each notice before choosing which exhibition to see. ").repeat(5),
        question: `What did the ${split} team number ${i} visit?`, options: ["A museum", "A farm", "A park", "A lake"], answer: "A",
    })) }));
    const corpus = prepareEnglish(sources), all = [...corpus.knowledge, ...corpus.development, ...corpus.test];
    assert.equal(all.length, 500); assert.deepEqual([corpus.knowledge.length, corpus.development.length, corpus.test.length], [300, 100, 100]);
    assert.deepEqual(["reading", "grammar", "cloze"].map(k => all.filter(q => q.kind === k).length), [300, 100, 100]);
    assert.equal(englishHash(JSON.stringify(corpus)), englishHash(JSON.stringify(prepareEnglish(sources))));
    assert.ok(all.every(q => q.type === "single-choice"));
});

test("pasted grammar, multi-question reading and cloze preserve sources and reject missing original or excluded tasks", () => {
    const grammar = parseEnglishInput("[英语]\nAlex has lived here ___ 2020.\nA. since\nB. for\nC. at\nD. from")!;
    assert.equal(grammar.questions[0]!.kind, "grammar");
    const reading = parseEnglishInput("[Passage]\nMia did not go home first.\nShe delivered medicine before returning.\n[Questions]\n1. Which statement is true?\nA. She delivered first.\nB. She went home first.\nC. She stayed at school.\nD. She lost it.")!;
    assert.equal(reading.passage.paragraphs.length, 2); assert.equal(reading.questions[0]!.kind, "reading");
    assert.match(JSON.stringify(reading), /did not/); assert.equal("answer" in reading.questions[0]!, false);
    assert.equal(parseEnglishInput("[英语]\nAccording to the passage, what happened?\nA. One\nB. Two\nC. Three\nD. Four"), undefined);
    assert.equal(parseEnglishInput("[英语]\nWrite an essay about your holiday."), undefined);
    assert.equal(parseEnglishInput("[英语]\nListen to the recording and choose."), undefined);
    assert.equal(parseEnglishInput("[英语] 请帮我写一篇英语作文"), undefined);
    assert.equal(parseEnglishInput("[英语] He ___ here.\nA. lives\nB. lives\nC. lived\nD. living"), undefined);
    const cloze = parseEnglishInput("[Passage]\nHe wanted to [[1]] a book.\n[Questions]\n1. Choose the word for blank [[1]].\nA. read\nB. sleep\nC. swim\nD. cook")!;
    assert.equal(cloze.questions[0]!.blank, 1);
});

test("English extraction preserves not/unless and antecedent neighbors within its token budget", () => {
    const corpus = englishFixture(), passage = corpus.passages[0]!;
    passage.paragraphs.splice(1, 0, ...Array.from({ length: 20 }, () => "Clouds moved slowly across the sky. ".repeat(30)));
    const tokens = new TokenBudget(config.context), evidence = selectEnglishEvidence(passage, "Did Mia return home before delivering medicine?", 240, tokens);
    assert.ok(tokens.count(JSON.stringify(evidence.paragraphs)) <= 240);
    assert.match(JSON.stringify(evidence), /did not return home/); assert.ok(evidence.omitted > 0);
});

test("all English context variants use original generic harness, omit labels and skip semantic review", async () => {
    const corpus = englishFixture(); let calls = 0;
    for (const variant of ENGLISH_VARIANTS) {
        const events: string[] = [], model: AgentModel = { async turn(messages) {
            calls++; assert.doesNotMatch(JSON.stringify(messages), /"answer"\s*:|"category"\s*:|referenceUrls/);
            return { content: "证据[P1]。\n第1题答案：A\n第2题答案：B", toolCalls: [] };
        } };
        const result = await new EnglishHarness(model, englishTask(corpus.passages[0]!, corpus.knowledge), variant, config.context, logger, 1800, {}, "direct")
            .run({ ...input, onEvent(name) { events.push(name); } });
        assert.equal(englishChoice(result.content, 1), "A"); assert.equal(englishChoice(result.content, 2), "B"); assert.equal(result.review, undefined);
        assert.ok(events.includes("english.context")); assert.ok(events.includes("english.review.skipped"));
        assert.ok(!events.includes("agent.subagent.started"));
    }
    assert.ok(calls >= 5);
});

test("adaptive reads complete originals once and cloze questions share all numbered blanks", async () => {
    const authored = authoredEnglish(), qs = authored.knowledge.filter(q => q.passageId === "english-cloze-1"), passage = authored.passages.find(p => p.id === qs[0]!.passageId)!;
    let turns = 0;
    const result = await new EnglishHarness({ async turn(messages, tools) {
        turns++; assert.deepEqual(tools, []);
        const content = messages.map(m => m.content).join("\n"); for (let i = 1; i <= 5; i++) assert.ok(content.includes(`[[${i}]]`));
        return { content: qs.map(q => `第${q.number}题答案：${q.answer}`).join("\n"), toolCalls: [] };
    } }, englishTask(passage, qs), "adaptive", config.context, logger, 1800, {}, "direct").run(input);
    assert.equal(turns, 1); assert.equal(result.toolCalls, 1);
});

test("cropped originals can be reacquired with English-only tools; protocol repair stays inside English", async () => {
    const corpus = englishFixture(), passage = corpus.passages[0]!;
    passage.paragraphs = Array.from({ length: 28 }, (_, i) => `${i}. ` + "A club met at the library to discuss a novel and share their ideas. ".repeat(8));
    let turns = 0;
    const result = await new EnglishHarness({ async turn(messages, tools) {
        turns++;
        if (turns === 1) { assert.ok(tools.some(t => t.name === "english_lookup")); return { content: "", toolCalls: [{ id: "read-more", name: "english_lookup", arguments: { startParagraph: 3, endParagraph: 4 } }] }; }
        assert.ok(messages.some(m => m.toolCallId === "read-more")); return { content: "依据[P3]。\n第1题答案：A\n第2题答案：B", toolCalls: [] };
    } }, englishTask(passage, corpus.knowledge), "adaptive", { ...config.context, maxInputTokens: 4096 }, logger, 600, {}, "direct").run(input);
    assert.equal(result.modelTurns, 2); assert.equal(result.toolCalls, 2);
    let repairs = 0;
    const fallback = await new EnglishHarness({ async turn(messages) {
        repairs++; assert.match(messages[0]!.content, /初三学生的英语/);
        if (repairs === 1) throw new ModelProtocolError("INVALID_TOOL_CALLS");
        return { content: "第1题答案：A\n第2题答案：B", toolCalls: [] };
    } }, englishTask(passage, corpus.knowledge), "adaptive", { ...config.context, maxInputTokens: 4096 }, logger, 600, {}, "direct").run(input);
    assert.equal(repairs, 2); assert.equal(fallback.modelTurns, 2);
});

test("choice grader rejects missing, conflicting, repeated and multiple-choice conclusions", () => {
    assert.equal(englishChoice("第1题答案：A", 1), "A");
    assert.equal(englishChoice("根据原文，先送药再回家。第1题答案：A", 1), "A");
    assert.equal(englishChoice("**第1题答案**：**A**", 1), "A");
    for (const answer of ["选项A不正确。", "第1题答案：AB", "第1题答案：A\n第1题答案：B", "第1题答案：A\n第1题答案：A", "第2题答案：A"]) assert.equal(englishChoice(answer, 1), undefined);
});

test("routing respects explicit subjects and English history without cross-subject fallback", () => {
    assert.equal(routeSchoolSubject("[英语] 不会的题", []), "english");
    assert.equal(routeSchoolSubject("Please write an essay about school.", []), "english");
    assert.equal(routeSchoolSubject("继续第1题", [{ role: "user", content: "[英语] grammar" }]), "english");
    assert.equal(routeSchoolSubject("[数学] 求根", [{ role: "user", content: "[英语] grammar" }]), "math");
    assert.equal(routeSchoolSubject("[语文] 阅读", [{ role: "user", content: "[英语] grammar" }]), "chinese");
});

test("English follow-ups isolate original evidence and assistant history from other subjects", async () => {
    const english = "[Passage]\nMia delivered the medicine before going home.\n[Questions]\n1. What happened first?\nA. Medicine was delivered.\nB. She went home.\nC. She went shopping.\nD. She lost the medicine.";
    const mixed = { ...session, messages: [
        { id: "e", role: "user" as const, content: english }, { id: "ea", role: "assistant" as const, content: "English prior answer" },
        { id: "c", role: "user" as const, content: "[语文] PRIVATE_CHINESE_MATERIAL" }, { id: "ca", role: "assistant" as const, content: "PRIVATE_CHINESE_ANSWER" },
        { id: "m", role: "user" as const, content: "[数学] PRIVATE_MATH_CONDITION" }, { id: "ma", role: "assistant" as const, content: "PRIVATE_MATH_ANSWER" },
    ] };
    let calls = 0;
    const agent = createEnglishChatAgent({ async turn(messages) { calls++; const prompt = JSON.stringify(messages);
        assert.match(prompt, /Mia delivered/); assert.doesNotMatch(prompt, /PRIVATE_CHINESE|PRIVATE_MATH/);
        return { content: "第1题答案：A", toolCalls: [] };
    } }, config, logger, new EnglishLibrary("unused"));
    const result = await agent.run(mixed, { id: "q", role: "user", content: "[英语] 请继续解释第1题" });
    assert.equal(calls, 1); assert.match(result.content, /答案：A/);
});

test("English errors never load another subject, call its reviewer, or silently reuse stale source", async () => {
    const library = new EnglishLibrary("missing"), reading = new ReadingLibrary("missing");
    reading.corpus = async () => { assert.fail("Chinese corpus must not load"); };
    let calls = 0;
    const dependencies = createDependencies({ englishLibrary: library, readingLibrary: reading, logger, chatSessionRepository: new InMemoryChatSessionRepository(),
        agentModel: { async turn(messages) { calls++; assert.match(messages[0]!.content, /初三学生的英语/); throw new Error("English provider unavailable"); } },
        reviewerModel: { async turn() { assert.fail("English semantic review is intentionally absent"); } },
    }, { ...config, schoolSubject: "auto", verification: { ...config.verification, enabled: true } });
    const unsupported = await dependencies.agentHarness.run(session, { id: "q", role: "user", content: "[英语]\nWrite an essay about school." });
    assert.match(unsupported.content, /暂未开放/); assert.equal(calls, 0);
    await assert.rejects(dependencies.agentHarness.run(session, { id: "q", role: "user", content: "[英语题:english-missing-q1]" }), { code: "ENGLISH_CORPUS_UNAVAILABLE" });
    const grammar = "[英语]\nAlex has lived here ___ 2020.\nA. since\nB. for\nC. at\nD. from";
    await assert.rejects(dependencies.agentHarness.run(session, { id: "q", role: "user", content: grammar }), /English provider unavailable/); assert.equal(calls, 1);
    const stale = { ...session, messages: [{ id: "old", role: "user" as const, content: grammar }] };
    const response = await createEnglishChatAgent(text(), config, logger, library).run(stale, { id: "q", role: "user", content: "[Passage]\nmissing questions" });
    assert.match(response.content, /不完整/);
});

test("English cancellation and oversized full originals stop before any model or other subject is used", async () => {
    const corpus = englishFixture(), task = englishTask(corpus.passages[0]!, corpus.knowledge);
    const model: AgentModel = { async turn() { assert.fail("No model should run for cancelled or invalid evidence"); } };
    const harness = new EnglishHarness(model, task, "adaptive", config.context, logger, 1800, {}, "direct");
    await assert.rejects(harness.run(input, AbortSignal.abort()), { name: "AbortError" });
    task.passage.paragraphs = ["This sentence is part of a very long English text. ".repeat(3000)];
    await assert.rejects(new EnglishHarness(model, task, "full", { ...config.context, maxInputTokens: 4096 }, logger, 1800, {}, "direct").run(input), /ENGLISH_EVIDENCE_UNAVAILABLE/);
});

test("library errors retry after recovery; HTTP keeps references opt-in with English-only capabilities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "english-library-")), path = join(directory, "corpus.json"), corpus = englishFixture(), library = new EnglishLibrary(path);
    await assert.rejects(library.corpus(), { code: "ENGLISH_CORPUS_UNAVAILABLE" });
    await writeFile(path, JSON.stringify(corpus)); assert.equal((await library.corpus()).id, corpus.id);
    const settings = { ...config, english: { ...config.english, corpusPath: path } };
    const dependencies = createDependencies({ englishLibrary: library, logger, agentModel: text(), chatSessionRepository: new InMemoryChatSessionRepository() }, settings);
    const server = createApp(settings, dependencies).listen(0, "127.0.0.1"); await once(server, "listening");
    try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const capabilities = await (await fetch(`${url}/api/english/capabilities`)).json();
        assert.equal(capabilities.data.review, "not_configured"); assert.equal(capabilities.data.listening, false);
        const list = await (await fetch(`${url}/api/english/questions`)).json(); assert.equal(list.data.total, 2); assert.equal("answer" in list.data.questions[0], false);
        const detail = await (await fetch(`${url}/api/english/questions/${corpus.knowledge[0]!.id}`)).json(); assert.equal(detail.data.reference, undefined); assert.equal("answer" in detail.data.questions[0], false);
        assert.equal((await (await fetch(`${url}/api/english/questions/${corpus.knowledge[0]!.id}?reference=true`)).json()).data.reference, "A");
        assert.equal((await fetch(`${url}/api/english/questions?limit=100`)).status, 400);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
