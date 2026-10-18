import { readFile, mkdir, writeFile } from "node:fs/promises";
import { englishHash, loadEnglishCorpus } from "../src/modules/english/corpus.js";
import { prepareEnglish, type RaceSource } from "../src/modules/english/prepare.js";
import { dirname } from "node:path";

// Freeze a fresh reading-only holdout before inspecting its labels or running the model.
// Exclude entire passages from ALL existing splits, including the library and development.
const existing = await loadEnglishCorpus("evals/english/corpus.json");
const args = process.argv.slice(2), options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--out", "--exclude", "--extra-test"].includes(key) || !value || options.has(key)) throw new Error("Invalid holdout arguments");
    options.set(key, value);
}
const output = options.get("--out") ?? "evals/english/fresh-holdout.json";
if (!output.endsWith(".json")) throw new Error("Holdout output must end with .json");
const canonical = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const used = new Set(existing.passages.map(p => englishHash(canonical(p.paragraphs.join(" ")))));
const excluded = options.has("--exclude") ? await loadEnglishCorpus(options.get("--exclude")!) : undefined;
excluded?.passages.forEach(p => used.add(englishHash(canonical(p.paragraphs.join(" ")))));
const sources: RaceSource[] = [];
for (const split of ["train", "validation", "test"] as const) {
    const path = `data/english/raw/${split}`, raw = await readFile(`${path}.json`, "utf8");
    if (englishHash(raw) !== (await readFile(`${path}.sha256`, "utf8")).trim()) throw new Error(`Source checksum mismatch: ${split}`);
    const source: RaceSource = JSON.parse(raw);
    if (split === "test" && options.has("--extra-test")) {
        const path = options.get("--extra-test")!, extra = await readFile(path, "utf8");
        if (englishHash(extra) !== (await readFile(path.replace(/\.json$/, ".sha256"), "utf8")).trim()) throw new Error("Extra source checksum mismatch");
        const addition: RaceSource = JSON.parse(extra);
        if (addition.split !== "test") throw new Error("Extra source must be official test split");
        source.rows.push(...addition.rows);
    }
    sources.push({ ...source, rows: source.rows.filter(r => !used.has(englishHash(canonical(r.article)))) });
}
const corpus = prepareEnglish(sources, { knowledge: 0, development: 0, test: 100 });
corpus.id = "tspj-english-fresh-reading-holdout-100-v1";
corpus.knowledge = []; corpus.development = []; corpus.test = corpus.test.filter(q => q.kind === "reading");
const ids = new Set(corpus.test.map(q => q.passageId)); corpus.passages = corpus.passages.filter(p => ids.has(p.id));
corpus.limitations.push("Fresh passage-disjoint reading-only holdout, selected by deterministic passage hash, never added to the runtime library. Public source pretraining overlap remains possible.");
if (corpus.test.length !== 100 || corpus.passages.some(p => used.has(englishHash(canonical(p.paragraphs.join(" ")))))) throw new Error("Holdout isolation failed");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(corpus, null, 2), { flag: "wx" });
await writeFile(output.replace(/\.json$/, "-manifest.json"), JSON.stringify({ id: corpus.id, questions: corpus.test.length, passages: corpus.passages.length,
    corpusHash: englishHash(JSON.stringify(corpus)), excludedCorpusHash: englishHash(JSON.stringify(existing)), createdAt: new Date().toISOString(),
    ...(excluded ? { additionallyExcludedCorpusHash: englishHash(JSON.stringify(excluded)) } : {}),
    selection: "Remaining official test source rows; whole-passage exclusion of every existing split and optional additional holdout; deterministic hash order; no selection by correctness." }, null, 2), { flag: "wx" });
console.log(JSON.stringify({ questions: corpus.test.length, passages: corpus.passages.length }));
