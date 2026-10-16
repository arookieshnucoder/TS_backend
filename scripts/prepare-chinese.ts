import { mkdir, readFile, writeFile } from "node:fs/promises";
import { importReadingPage, readingHash, validateReadingCorpus, type PublicReadingPage } from "../src/modules/reading/corpus.js";
import type { ReadingCorpus } from "../src/modules/reading/contracts.js";

const raw = JSON.parse(await readFile("data/chinese/source/public-reading-pages.json", "utf8")) as { imported: PublicReadingPage[] };
const emptyCorpus = (): ReadingCorpus => ({ version: 1, subject: "chinese", targetGrade: 9, scope: "public-junior-exam-preparation",
    passages: [], knowledge: [], development: [], test: [], excluded: [] });
const corpus = emptyCorpus(), holdout = emptyCorpus();
const groups: ReturnType<typeof importReadingPage>[] = [];
const hashes = new Set<string>();
const paragraphOwners = new Map<string, string>();
for (const page of raw.imported) {
    try {
        const group = importReadingPage(page);
        const normalized = group.passage.paragraphs.join("").replace(/[\s\p{P}\p{S}]/gu, "");
        const key = readingHash(normalized);
        if (hashes.has(key)) throw new Error("Duplicate article edition");
        const fingerprints = group.passage.paragraphs.map(text => text.replace(/[\s\p{P}\p{S}]/gu, "")).filter(text => text.length >= 120);
        const matches = fingerprints.filter(text => paragraphOwners.has(readingHash(text)));
        if (matches.length >= 2 || matches.some(text => text.length >= 400)) throw new Error("Duplicate article paragraphs across editions");
        hashes.add(key); groups.push(group);
        for (const text of fingerprints) paragraphOwners.set(readingHash(text), group.passage.id);
    } catch (error) { corpus.excluded.push({ title: page.title, reason: error instanceof Error ? error.message : "Import error" }); }
}
// Sort by content hash, so website chronology does not define the train/test distribution.
groups.sort((a, b) => a.passage.id.localeCompare(b.passage.id));
const pool = groups.reduce((count, group) => count + group.questions.length, 0);
console.log(JSON.stringify({ articles: groups.length, questions: pool, excluded: corpus.excluded.length,
    reasons: Object.fromEntries([...new Set(corpus.excluded.map(item => item.reason))].map(reason => [reason, corpus.excluded.filter(item => item.reason === reason).length])) }));
if (pool < 760) {
    await writeFile("data/chinese/import-audit.json", JSON.stringify({ available: groups.length, pool, excluded: corpus.excluded }, null, 2));
    throw new Error(`Need at least 760 matched public questions for library/development/test/final holdout; found ${pool}`);
}
for (const group of groups) {
    if (corpus.knowledge.length >= 500) {
        if (holdout.test.length >= 100) break;
        holdout.passages.push(group.passage);
        holdout.test.push(...group.questions.slice(0, 100 - holdout.test.length));
        continue;
    }
    const split = corpus.test.length < 100 ? "test" : corpus.development.length < 60 ? "development" : "knowledge";
    const remaining = split === "knowledge" ? 500 - corpus.knowledge.length : split === "test" ? 100 - corpus.test.length : 60 - corpus.development.length;
    if (remaining <= 0) break;
    corpus.passages.push(group.passage);
    corpus[split].push(...group.questions.slice(0, remaining));
}
validateReadingCorpus(corpus);
validateReadingCorpus(holdout);
await mkdir("evals/chinese", { recursive: true });
await writeFile("evals/chinese/corpus.json", JSON.stringify(corpus, null, 2));
await writeFile("evals/chinese/holdout.json", JSON.stringify(holdout, null, 2));
await writeFile("data/chinese/import-audit.json", JSON.stringify({ knowledge: corpus.knowledge.length, development: corpus.development.length, test: corpus.test.length,
    passages: corpus.passages.length, finalHoldoutQuestions: holdout.test.length, finalHoldoutPassages: holdout.passages.length,
    types: Object.fromEntries(["open", "single-choice", "multiple-choice"].map(type => [type, corpus.knowledge.filter(question => question.type === type).length])),
    datasetHash: readingHash(JSON.stringify(corpus)), excluded: corpus.excluded }, null, 2));
console.log(JSON.stringify({ status: "prepared", knowledge: corpus.knowledge.length, development: corpus.development.length, test: corpus.test.length }));
