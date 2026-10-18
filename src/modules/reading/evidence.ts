import type { ReadingPassage } from "./contracts.js";
import type { TokenBudget } from "../harness/context/tokens.js";

export type { PassageEvidence as ReadingEvidence } from "../subjects/contracts.js";
import type { PassageEvidence as ReadingEvidence } from "../subjects/contracts.js";
export { fullPassageEvidence as fullReadingEvidence } from "../subjects/contracts.js";
const quoted = (text: string) => [...text.matchAll(/[“「"‘]([^”」"’]{2,100})[”」"’]/g)].map(match => match[1]!);
const terms = (text: string) => {
    const result = new Set(text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
    for (const word of text.match(/[\u3400-\u9fff]{2,}/g) ?? []) for (let index = 0; index < word.length - 1; index++) result.add(word.slice(index, index + 2));
    return [...result].filter(term => !["文章", "作者", "下列", "一项", "结合", "选文", "第题", "理解", "内容"].includes(term)).slice(0, 512);
};

/** Select verbatim evidence, not generated facts. Adjacent sentences protect negation, subjects and causal links. */
export function selectReadingEvidence(passage: ReadingPassage, query: string, budget: number, tokens: TokenBudget): ReadingEvidence {
    const needles = terms(query), quotes = quoted(query);
    const global = /主旨|主题|标题|结构|线索|全文|变化|概括|人物形象|感情|情感/.test(query);
    const candidates = passage.paragraphs.flatMap((paragraph, index) => {
        const sentences = paragraph.match(/[^。！？!?]+[。！？!?]?/g) ?? [paragraph];
        const paragraphNumber = paragraph.match(/^([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])/)?.[1];
        const number = paragraphNumber ? "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳".indexOf(paragraphNumber) + 1 : index + 1;
        const chineseNumber = number && number <= 10 ? "一二三四五六七八九十"[number - 1] : number && number < 20 ? `十${"一二三四五六七八九"[number - 11] ?? ""}` : "二十";
        const explicit = number !== undefined && new RegExp(`第\\s*(?:${number}|${paragraphNumber}|${chineseNumber})\\s*(?:自然)?段`).test(query);
        return sentences.map((sentence, offset) => ({ index, offset, sentence,
            score: needles.reduce((score, term) => score + (sentence.toLowerCase().includes(term) ? 1 : 0), 0) +
                quotes.reduce((score, quote) => score + (sentence.includes(quote) ? 40 : 0), 0) + (explicit ? 80 : 0) +
                (global && (index < 3 || index >= passage.paragraphs.length - 2) ? 10 : 0), sentences }));
    });
    candidates.sort((a, b) => b.score - a.score || a.index - b.index || a.offset - b.offset);
    const selected = new Map<number, Map<number, string>>();
    const render = () => [...selected].sort(([a], [b]) => a - b).map(([index, values]) => {
        const ordered = [...values].sort(([a], [b]) => a - b);
        return { id: `P${index + 1}`, text: ordered.map(([offset, sentence], position) =>
            (position && offset > ordered[position - 1]![0] + 1 ? "[…省略…]" : "") + sentence).join("") };
    });
    for (const candidate of candidates) {
        const offsets = [candidate.offset, candidate.offset - 1, candidate.offset + 1].filter(offset => offset >= 0 && offset < candidate.sentences.length);
        for (const offset of offsets) {
            const values = selected.get(candidate.index) ?? new Map<number, string>();
            if (values.has(offset)) continue;
            values.set(offset, candidate.sentences[offset]!); selected.set(candidate.index, values);
            if (tokens.count(JSON.stringify(render())) > budget) {
                values.delete(offset);
                if (!values.size) selected.delete(candidate.index);
            }
        }
    }
    const paragraphs = render();
    return { paragraphs, omitted: passage.paragraphs.length - paragraphs.length };
}
