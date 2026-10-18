export const ENGLISH_VARIANTS = ["full", "summary", "extractive", "hybrid", "adaptive"] as const;
export type EnglishVariant = typeof ENGLISH_VARIANTS[number];
export const ENGLISH_KINDS = ["reading", "grammar", "cloze"] as const;
export type EnglishKind = typeof ENGLISH_KINDS[number];
export interface EnglishPassage {
    id: string; title: string; paragraphs: string[];
    source: { kind: "race-middle" | "authored"; urls: string[]; sha256: string; originalId: string; license: string; originalSplit?: string };
}
export interface EnglishQuestion {
    id: string; number: number; question: string; options: string[]; type: "single-choice";
    passageId: string; kind: EnglishKind; category: string; answer: string; family?: string; blank?: number;
}
export interface EnglishTask { passage: EnglishPassage; questions: Pick<EnglishQuestion, "id" | "number" | "question" | "options" | "type" | "kind" | "blank">[]; }
export interface EnglishCorpus {
    version: 1; id: string; subject: "english"; targetGrade: 9; scope: "grade9-practice";
    passages: EnglishPassage[]; knowledge: EnglishQuestion[]; development: EnglishQuestion[]; test: EnglishQuestion[];
    excluded: { id: string; reason: string }[]; limitations: string[];
}
/** Explicit projection is the sole corpus-to-runtime boundary: never spread a labelled question. */
export function englishTask(passage: EnglishPassage, questions: EnglishQuestion[]): EnglishTask {
    return { passage, questions: questions.map(({ id, number, question, options, type, kind, blank }) =>
        ({ id, number, question, options: [...options], type, kind, ...(blank ? { blank } : {}) })) };
}
export function englishQuestions(task: EnglishTask) {
    return task.questions.map(q => `第${q.number}题（单选；${q.kind}${q.blank ? `，空格${q.blank}` : ""}）：${q.question}\n` +
        q.options.map((option, i) => `${"ABCD"[i]}. ${option}`).join("\n")).join("\n\n");
}
