import assert from "node:assert/strict";
import test from "node:test";
import { CorpusLibrary } from "../src/modules/subjects/corpus-library.js";
import { createReadingChatAgent } from "../src/bootstrap/reading-chat-agent.js";
import { ReadingLibrary } from "../src/modules/reading/library.js";
import { loadConfig } from "../src/config/env.js";
import type { ChatSession } from "../src/modules/chat/entity/chat-session.entity.js";

test("shared corpus loading coalesces concurrent requests, retries failures and rejects dangling passages", async () => {
    let loads = 0;
    const corpus = { passages: [{ id: "p", text: "original" }], knowledge: [{ id: "q", passageId: "p", answer: "private" }] };
    const library = new CorpusLibrary(async () => {
        if (++loads === 1) throw new Error("disk unavailable");
        return corpus;
    }, (passage, question) => ({ passage, id: question.id }), () => new Error("corpus unavailable"));

    const failed = await Promise.allSettled([library.corpus(), library.corpus()]);
    assert.equal(loads, 1);
    assert.ok(failed.every(result => result.status === "rejected" && result.reason.message === "corpus unavailable"));
    const [first, second] = await Promise.all([library.corpus(), library.corpus()]);
    assert.equal(loads, 2);
    assert.equal(first, second);
    assert.deepEqual(await library.question("q"), { passage: corpus.passages[0], id: "q" });
    assert.equal(await library.question("unknown"), undefined);
    corpus.knowledge[0]!.passageId = "missing";
    await assert.rejects(library.question("q"), /references missing passage/);
});

test("Chinese follow-ups isolate subject history and incomplete new material cannot reuse an old passage", async () => {
    const config = loadConfig({ NODE_ENV: "test", AGENT_TRACE_ENABLED: "false" });
    let calls = 0;
    const agent = createReadingChatAgent({ async turn(messages) {
        calls++;
        const evidence = messages.find(message => message.role === "tool")!.content;
        assert.match(evidence, /哥哥先送药/);
        assert.doesNotMatch(JSON.stringify(messages), /ENGLISH_ONLY_ORIGINAL/);
        return { content: "他先兑现承诺。\n第1题答案：先送药。", toolCalls: [] };
    } }, config, { info() {}, error() {} }, new ReadingLibrary("unused-corpus.json"));
    const session: ChatSession = { id: "session", requestId: "request", title: "阅读", createdAt: new Date(), updatedAt: new Date(),
        sessionStatus: "finished", sessionError: null, messages: [
            { id: "c", role: "user", content: "[语文阅读]\n[原文]哥哥先送药，再回家。\n[题目]1. 哥哥先做了什么？" },
            { id: "e", role: "user", content: "[英语]\n[原文]ENGLISH_ONLY_ORIGINAL\n[题目]1. What happened?\nA. One\nB. Two\nC. Three\nD. Four" },
        ] };
    const followUp = { id: "next", role: "user" as const, content: "第1题请解释依据。" };
    assert.match((await agent.run(session, followUp)).content, /先兑现承诺/);
    assert.equal(calls, 1);

    const incomplete = await agent.run(session, { ...followUp, content: "[原文]这是一篇新文章，但没有提供题目。" });
    assert.match(incomplete.content, /不完整/);
    const anotherSubject = await agent.run({ ...session, messages: session.messages.slice(1) }, followUp);
    assert.match(anotherSubject.content, /请提供完整阅读材料/);
    assert.equal(calls, 1);
});
