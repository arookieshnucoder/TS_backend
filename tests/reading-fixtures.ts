import type { ReadingCorpus, ReadingPassage } from "../src/modules/reading/contracts.js";
import { readingHash } from "../src/modules/reading/corpus.js";

export function readingFixture(): ReadingCorpus {
    const passage: ReadingPassage = { id: "fixture-reading", title: "合成阅读测试夹具", paragraphs: [
        "①那晚，母亲在屋内等候。哥哥没有先回家，他答应把药及时送到山后的病人手上。",
        "②村口的桥正在修建，村民谈起木材和工具。".repeat(25),
        "③直到天亮，他先把药送给病人，才回到家里。母亲没有责备他，而是给他盛了一碗热粥。",
    ], source: { urls: ["https://example.com/synthetic-reading"], answerUrls: ["https://example.com/synthetic-reference"],
        sha256: readingHash("synthetic"), publisher: "offline-test-fixture", stage: "junior-exam-preparation" } };
    return { version: 1, subject: "chinese", targetGrade: 9, scope: "public-junior-exam-preparation", passages: [passage],
        knowledge: [
            { id: "fixture-q1", passageId: passage.id, number: 1, question: "下列叙述正确的是？", options: ["他先送药，才回家", "他先回家，没有送药", "母亲责备了他", "他没有回家"], type: "single-choice", answer: "A", category: "detail" },
            { id: "fixture-q2", passageId: passage.id, number: 2, question: "为什么哥哥没有先回家？结合第三自然段说明。", options: [], type: "open", answer: "GOLD_PRIVATE_REFERENCE_只用于判卷", category: "inference" },
        ], development: [], test: [], excluded: [] };
}
