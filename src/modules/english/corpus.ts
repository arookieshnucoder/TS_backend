import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ENGLISH_KINDS, type EnglishCorpus } from "./contracts.js";
export const englishHash = (text: string) => createHash("sha256").update(text).digest("hex");
const normalized = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
export function validateEnglishCorpus(value: unknown): EnglishCorpus {
    const c = value as EnglishCorpus;
    if (c?.version !== 1 || c.subject !== "english" || c.targetGrade !== 9 || c.scope !== "grade9-practice" || !c.id?.trim() ||
        ![c.passages, c.knowledge, c.development, c.test, c.excluded, c.limitations].every(Array.isArray)) throw new Error("Invalid English corpus");
    const passages = new Map<string, string>(), hashes = new Set<string>();
    for (const p of c.passages) {
        if (typeof p.id !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(p.id) || passages.has(p.id) || !p.title?.trim() || !Array.isArray(p.paragraphs) || !p.paragraphs.length ||
            p.paragraphs.some(text => typeof text !== "string" || !text.trim()) || !["race-middle", "authored"].includes(p.source?.kind) ||
            !p.source.originalId?.trim() || !p.source.license?.trim() || !/^[a-f0-9]{64}$/.test(p.source.sha256) || !p.source.urls?.length ||
            p.source.urls.some(url => !url.startsWith("https://") && !(p.source.kind === "authored" && url.startsWith("urn:tspj:english:")))) throw new Error("Invalid English passage");
        const digest = englishHash(normalized(p.paragraphs.join("\n")));
        if (hashes.has(digest)) throw new Error("Duplicate English passage");
        hashes.add(digest); passages.set(p.id, digest);
    }
    const ids = new Set<string>(), splits = new Map<string, string>(), families = new Map<string, string>(), numbers = new Set<string>();
    for (const [split, questions] of [["knowledge", c.knowledge], ["development", c.development], ["test", c.test]] as const) {
        for (const q of questions) {
            const numberKey = `${q.passageId}:${q.number}`;
            if (typeof q.id !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(q.id) || ids.has(q.id) || !passages.has(q.passageId) || !Number.isSafeInteger(q.number) || q.number < 1 || numbers.has(numberKey) ||
                typeof q.question !== "string" || !q.question.trim() || q.type !== "single-choice" || !ENGLISH_KINDS.includes(q.kind) || !q.category?.trim() ||
                !Array.isArray(q.options) || q.options.length !== 4 || q.options.some(o => typeof o !== "string" || !o.trim()) ||
                new Set(q.options.map(normalized)).size !== 4 || !/^[ABCD]$/.test(q.answer) ||
                q.kind === "cloze" && (!Number.isSafeInteger(q.blank) || q.blank! < 1)) throw new Error("Invalid English choice question");
            if (splits.has(q.passageId) && splits.get(q.passageId) !== split) throw new Error("English passage leaked across splits");
            if (q.family && families.has(q.family) && families.get(q.family) !== split) throw new Error("Authored English family leaked across splits");
            splits.set(q.passageId, split); if (q.family) families.set(q.family, split);
            ids.add(q.id); numbers.add(numberKey);
        }
    }
    return c;
}
export async function loadEnglishCorpus(path: string): Promise<EnglishCorpus> { return validateEnglishCorpus(JSON.parse(await readFile(path, "utf8"))); }
