import { authoredEnglish } from "./authored-bank.js";
import { englishHash, validateEnglishCorpus } from "./corpus.js";
import type { EnglishCorpus, EnglishQuestion, EnglishPassage } from "./contracts.js";
export interface RaceRow { example_id: string; article: string; question: string; options: string[]; answer: string; row: number; }
export interface RaceSource { split: "train" | "validation" | "test"; rows: RaceRow[]; }
const canonical = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const category = (stem: string) => /not true|except|not correct|false/i.test(stem) ? "negation" : /mainly|main idea|best title|purpose/i.test(stem) ? "main-idea" :
    /mean|refer to|underlined|word /i.test(stem) ? "vocabulary-reference" : /infer|probably|suggest|learn from/i.test(stem) ? "inference" : "detail";
/** Labels remain in the corpus only; original official RACE split boundaries are preserved. */
export function prepareEnglish(sources: RaceSource[], quotas = { knowledge: 180, development: 60, test: 60 }): EnglishCorpus {
    const authored = authoredEnglish();
    const corpus: EnglishCorpus = { version: 1, id: "tspj-english-grade9-500-v1", subject: "english", targetGrade: 9, scope: "grade9-practice", ...authored,
        excluded: [], limitations: ["RACE-M is public middle-school English exam material, not an independently grade-9-certified collection; authored grammar and cloze target grade-9 preparation.",
            "RACE-M passages retain the dataset's non-commercial research terms and original wording; references may contain source errors.",
            "Authored grammar families and complete passages are held out together. No writing or listening tasks are included.",
            "Public RACE material may have appeared in model pretraining; scores do not establish performance on unseen private examinations."] };
    const seenPassages = new Map<string, string>(), seenQuestions = new Set<string>();
    for (const [rawSplit, target] of [["train", "knowledge"], ["validation", "development"], ["test", "test"]] as const) {
        const rows = sources.find(s => s.split === rawSplit)?.rows;
        if (!rows) throw new Error(`Missing RACE-M ${rawSplit} source`);
        const groups = new Map<string, RaceRow[]>();
        for (const row of rows) {
            if (typeof row.article !== "string" || typeof row.question !== "string" || !row.example_id?.startsWith("middle") ||
                row.article.split(/\s+/).length < 70 || row.article.length > 14000 || !/^[ABCD]$/.test(row.answer) ||
                !Array.isArray(row.options) || row.options.length !== 4 || row.options.some(o => typeof o !== "string" || !o.trim()) ||
                new Set(row.options.map(canonical)).size !== 4 || /<img|\.(?:png|jpg)|listen to (?:the )?(?:recording|tape)|听录音|听力|following (?:picture|chart)|in the (?:picture|chart)/i.test(row.article + "\n" + row.question)) {
                corpus.excluded.push({ id: `${rawSplit}:${row.row}`, reason: "unsupported, incomplete or invalid source item" }); continue;
            }
            const digest = englishHash(canonical(row.article));
            if (seenPassages.has(digest) && seenPassages.get(digest) !== target) { corpus.excluded.push({ id: `${rawSplit}:${row.row}`, reason: "cross-split article duplicate" }); continue; }
            const group = groups.get(digest) ?? []; group.push(row); groups.set(digest, group);
        }
        let selected = 0;
        for (const [digest, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
            if (selected >= quotas[target]) break;
            const first = group[0]!, passageId = `english-race-${digest.slice(0, 16)}`;
            const passage: EnglishPassage = { id: passageId, title: `RACE-M ${first.example_id}`, paragraphs: first.article.split(/\r?\n+/).map(p => p.trim()).filter(Boolean),
                source: { kind: "race-middle", originalId: first.example_id, originalSplit: rawSplit, sha256: englishHash(first.article), license: "RACE: non-commercial research only",
                    urls: ["https://www.cs.cmu.edu/~glai1/data/race/", `https://datasets-server.huggingface.co/rows?dataset=ehovy%2Frace&config=middle&split=${rawSplit}&offset=${first.row}&length=1`] } };
            const items: EnglishQuestion[] = [];
            for (const row of group) {
                const questionDigest = englishHash(digest + canonical(row.question) + row.options.map(canonical).join("|"));
                if (seenQuestions.has(questionDigest) || selected >= quotas[target]) continue;
                items.push({ id: `${passageId}-q${items.length + 1}`, passageId, number: items.length + 1, question: row.question.trim(), options: [...row.options], answer: row.answer,
                    kind: "reading", category: category(row.question), type: "single-choice" });
                seenQuestions.add(questionDigest); selected++;
            }
            if (items.length) { corpus.passages.push(passage); corpus[target].push(...items); seenPassages.set(digest, target); }
        }
        if (selected !== quotas[target]) throw new Error(`Not enough clean RACE-M ${rawSplit} questions: ${selected}/${quotas[target]}`);
    }
    return validateEnglishCorpus(corpus);
}
