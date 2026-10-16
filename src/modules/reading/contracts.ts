/** Reading data stays separate from runtime messages: gold answers never enter solver prompts. */
export const READING_VARIANTS = ["full", "summary", "extractive", "hybrid", "adaptive"] as const;
export type ReadingVariant = typeof READING_VARIANTS[number];
export interface ReadingSource {
    urls: string[];
    answerUrls: string[];
    sha256: string;
    publisher: string;
    stage: "junior-exam-preparation";
}
export interface ReadingPassage { id: string; title: string; headings?: string[]; paragraphs: string[]; source: ReadingSource; }
export interface ReadingQuestion {
    id: string; passageId: string; number: number; question: string; options: string[];
    type: "single-choice" | "multiple-choice" | "open";
    /** Reference answer is used only by corpus browsing and evaluation, never by the reading workflow. */
    answer: string;
    category: "detail" | "inference" | "structure" | "expression" | "theme";
}
export interface ReadingCorpus {
    version: 1; subject: "chinese"; targetGrade: 9; scope: "public-junior-exam-preparation";
    passages: ReadingPassage[]; knowledge: ReadingQuestion[]; development: ReadingQuestion[]; test: ReadingQuestion[];
    excluded: { title: string; reason: string }[];
}
export interface ReadingTask {
    passage: ReadingPassage;
    /** Solver receives only question fields; references cannot be copied through a spread. */
    questions: Pick<ReadingQuestion, "id" | "number" | "question" | "options" | "type">[];
}
export function readingTask(passage: ReadingPassage, questions: ReadingQuestion[]): ReadingTask {
    return { passage, questions: questions.map(({ id, number, question, options, type }) => ({ id, number, question, options: [...options], type })) };
}
export function readingQuestions(task: ReadingTask): string {
    return task.questions.map(question => `第${question.number}题（${question.type === "open" ? "简答" : question.type === "multiple-choice" ? "多选" : "单选"}）：${question.question}\n` +
        question.options.map((option, index) => `${"ABCDEF"[index]}. ${option}`).join("\n")).join("\n\n");
}
