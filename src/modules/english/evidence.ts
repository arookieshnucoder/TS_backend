import type { TokenBudget } from "../harness/context/tokens.js";
import type { EnglishPassage } from "./contracts.js";
export interface EnglishEvidence { paragraphs: { id: string; text: string }[]; omitted: number; summary?: string; }
export function fullEnglishEvidence(passage: EnglishPassage): EnglishEvidence {
    return { paragraphs: passage.paragraphs.map((text, i) => ({ id: `P${i + 1}`, text })), omitted: 0 };
}
/** Verbatim English sentences plus neighbors protect negation, pronoun antecedents and cloze context. */
export function selectEnglishEvidence(passage: EnglishPassage, query: string, budget: number, tokens: TokenBudget): EnglishEvidence {
    const stop = new Set(["the", "and", "which", "what", "following", "passage", "according", "true", "false", "that", "this", "with", "from", "question"]);
    const terms = [...new Set(query.toLowerCase().match(/[a-z]+(?:'[a-z]+)?|\d+/g) ?? [])].filter(t => t.length > 2 && !stop.has(t));
    const global = /main idea|best title|mainly|purpose|infer|except|not true|cloze|主旨|完形/i.test(query);
    const chunks = passage.paragraphs.flatMap((paragraph, p) => {
        const sentences = paragraph.match(/[\s\S]+?(?:[.!?](?=\s+[A-Z“"])|$)/g)?.filter(Boolean) ?? [paragraph];
        return sentences.map((text, s) => ({ p, s, text, sentences,
            score: terms.reduce((score, term) => score + (text.toLowerCase().includes(term) ? 1 : 0), 0) + (global && (p === 0 || p === passage.paragraphs.length - 1) ? 4 : 0) +
                (/\[\[\d+\]\]/.test(text) ? 3 : 0) }));
    }).sort((a, b) => b.score - a.score || a.p - b.p || a.s - b.s);
    const selected = new Map<number, Map<number, string>>();
    const render = () => [...selected].sort(([a], [b]) => a - b).map(([p, sentences]) => ({ id: `P${p + 1}`, text: [...sentences].sort(([a], [b]) => a - b)
        .map(([s, text], i, all) => (i && s > all[i - 1]![0] + 1 ? " […omitted…] " : "") + text).join("") }));
    for (const chunk of chunks) for (const s of [chunk.s, chunk.s - 1, chunk.s + 1]) {
        if (s < 0 || s >= chunk.sentences.length) continue;
        const values = selected.get(chunk.p) ?? new Map<number, string>();
        if (values.has(s)) continue;
        values.set(s, chunk.sentences[s]!); selected.set(chunk.p, values);
        if (tokens.count(JSON.stringify(render())) > budget) { values.delete(s); if (!values.size) selected.delete(chunk.p); }
    }
    const paragraphs = render();
    return { paragraphs, omitted: passage.paragraphs.length - paragraphs.length };
}
