import type { CorpusSplits, Passage, PassageQuestion, PassageTask } from "../subjects/contracts.js";
export { PASSAGE_VARIANTS as READING_VARIANTS } from "../subjects/contracts.js";
export type { PassageVariant as ReadingVariant } from "../subjects/contracts.js";
/** 公开语文材料的出处和校验信息，答案页面只供题库整理与评测。 */
export interface ReadingSource {
    urls: string[];
    answerUrls: string[];
    sha256: string;
    publisher: string;
    stage: "junior-exam-preparation";
}
/** 语文原文及标题作者信息；headings 不计入正文段号。 */
export interface ReadingPassage extends Passage { headings?: string[]; source: ReadingSource; }
/** 带分类和参考答案的题库题目，须通过 readingTask 转为解题输入。 */
export interface ReadingQuestion extends PassageQuestion {
    passageId: string;
    /** 参考答案只供题库浏览和评测，不提供给解题模型。 */
    answer: string;
    category: "detail" | "inference" | "structure" | "expression" | "theme";
}
/** 初三语文题库及其来源范围，题目分区沿用公共契约。 */
export interface ReadingCorpus extends CorpusSplits<ReadingQuestion> {
    version: 1; subject: "chinese"; targetGrade: 9; scope: "public-junior-exam-preparation";
    passages: ReadingPassage[];
    excluded: { title: string; reason: string }[];
}
/** 语文任务只携带原文、题干和选项，不携带参考答案。 */
export type ReadingTask = PassageTask<ReadingPassage, Pick<ReadingQuestion, "id" | "number" | "question" | "options" | "type">>;
/** 逐字段构造模型输入，防止题库答案随对象展开泄漏。 */
export function readingTask(passage: ReadingPassage, questions: ReadingQuestion[]): ReadingTask {
    return { passage, questions: questions.map(({ id, number, question, options, type }) => ({ id, number, question, options: [...options], type })) };
}
export function readingQuestions(task: ReadingTask): string {
    return task.questions.map(question => `第${question.number}题（${question.type === "open" ? "简答" : question.type === "multiple-choice" ? "多选" : "单选"}）：${question.question}\n` +
        question.options.map((option, index) => `${"ABCDEF"[index]}. ${option}`).join("\n")).join("\n\n");
}
