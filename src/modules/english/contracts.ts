import type { CorpusSplits, Passage, PassageQuestion, PassageTask } from "../subjects/contracts.js";
export { PASSAGE_VARIANTS as ENGLISH_VARIANTS } from "../subjects/contracts.js";
export type { PassageVariant as EnglishVariant } from "../subjects/contracts.js";
export const ENGLISH_KINDS = ["reading", "grammar", "cloze"] as const;
export type EnglishKind = typeof ENGLISH_KINDS[number];
/** 英语原文及出处，保留数据集划分和许可供追溯。 */
export interface EnglishPassage extends Passage {
    source: { kind: "race-middle" | "authored"; urls: string[]; sha256: string; originalId: string; license: string; originalSplit?: string };
}
/** 英语题库只支持单选；kind 区分题型，blank 定位完形空格。 */
export interface EnglishQuestion extends PassageQuestion {
    type: "single-choice";
    passageId: string; kind: EnglishKind; category: string; answer: string; family?: string; blank?: number;
}
/** 运行时保留英语题型和空格号，排除参考答案及评测标签。 */
export type EnglishTask = PassageTask<EnglishPassage, Pick<EnglishQuestion, "id" | "number" | "question" | "options" | "type" | "kind" | "blank">>;
/** 英语练习题库，额外记录排除题目及数据限制。 */
export interface EnglishCorpus extends CorpusSplits<EnglishQuestion> {
    version: 1; id: string; subject: "english"; targetGrade: 9; scope: "grade9-practice";
    passages: EnglishPassage[];
    excluded: { id: string; reason: string }[]; limitations: string[];
}
/** 逐字段构造模型输入，带答案的题库对象不能直接展开到任务中。 */
export function englishTask(passage: EnglishPassage, questions: EnglishQuestion[]): EnglishTask {
    return { passage, questions: questions.map(({ id, number, question, options, type, kind, blank }) =>
        ({ id, number, question, options: [...options], type, kind, ...(blank ? { blank } : {}) })) };
}
export function englishQuestions(task: EnglishTask) {
    return task.questions.map(q => `第${q.number}题（单选；${q.kind}${q.blank ? `，空格${q.blank}` : ""}）：${q.question}\n` +
        q.options.map((option, i) => `${"ABCD"[i]}. ${option}`).join("\n")).join("\n\n");
}
