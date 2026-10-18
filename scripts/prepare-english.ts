import { mkdir, readFile, writeFile } from "node:fs/promises";
import { prepareEnglish, type RaceSource } from "../src/modules/english/prepare.js";
import { englishHash } from "../src/modules/english/corpus.js";
const sources: RaceSource[] = [];
for (const split of ["train", "validation", "test"] as const) {
    const path = `data/english/raw/${split}`, raw = await readFile(`${path}.json`, "utf8");
    if (englishHash(raw) !== (await readFile(`${path}.sha256`, "utf8")).trim()) throw new Error(`Source checksum mismatch: ${split}`);
    sources.push(JSON.parse(raw));
}
const corpus = prepareEnglish(sources);
const questions = [...corpus.knowledge, ...corpus.development, ...corpus.test];
if (questions.length !== 500) throw new Error("Expected exactly 500 English questions");
await mkdir("evals/english", { recursive: true });
await writeFile("evals/english/corpus.json", JSON.stringify(corpus, null, 2));
const manifest = { id: corpus.id, total: questions.length, passages: corpus.passages.length,
    splits: { knowledge: corpus.knowledge.length, development: corpus.development.length, test: corpus.test.length },
    kinds: Object.fromEntries(["reading", "grammar", "cloze"].map(kind => [kind, questions.filter(q => q.kind === kind).length])),
    corpusHash: englishHash(JSON.stringify(corpus)), limitations: corpus.limitations };
await writeFile("evals/english/manifest.json", JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));
