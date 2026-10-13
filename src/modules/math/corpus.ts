import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { normalizeMath } from "./normalize.js";
import type { MathCorpus, MathQuestion } from "./contracts.js";
export const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export function validateCorpus(value: unknown): MathCorpus {
    const c = value as MathCorpus;
    if (c?.version !== 1 || typeof c.id !== "string" || ![c.knowledge, c.development, c.test, c.excluded].every(Array.isArray)) throw new Error("Invalid math corpus");
    const ids = new Set<string>(), stems = new Map<string, string>();
    for (const [split, questions] of [["knowledge", c.knowledge], ["development", c.development], ["test", c.test]] as const) {
        for (const q of questions) {
            if (typeof q.id !== "string" || ids.has(q.id) || typeof q.question !== "string" || !q.question.trim() || !Array.isArray(q.options) || q.options.length !== 4 ||
                q.options.some(o => typeof o !== "string" || !o.trim()) || !/^[ABCD]$/.test(q.answer) || !q.topic?.trim() ||
                !q.source?.url?.startsWith("https://") || !Number.isInteger(q.source.row) || !/^[a-f0-9]{64}$/.test(q.source.sha256)) throw new Error("Invalid or duplicate math question");
            ids.add(q.id);
            const stem = normalizeMath(q.question).replace(/[（()）_\s]/g, "");
            if (stems.has(stem) && stems.get(stem) !== split) throw new Error("Knowledge/evaluation question leakage");
            stems.set(stem, split);
        }
    }
    return c;
}
export async function loadCorpus(path: string): Promise<MathCorpus> { return validateCorpus(JSON.parse(await readFile(path, "utf8"))); }
export function retrievalText(q: MathQuestion) { return normalizeMath(`${q.question}\n${q.topic}`); }
