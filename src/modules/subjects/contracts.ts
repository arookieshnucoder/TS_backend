/** 三种学科的统一标识；通用 agent 由工作流配置选择，不是第四种学科。 */
export type SchoolSubject = "math" | "chinese" | "english";

/** 语文、英语共用的原文保留策略；具体选句规则由各学科实现。 */
export const PASSAGE_VARIANTS = ["full", "summary", "extractive", "hybrid", "adaptive"] as const;
export type PassageVariant = typeof PASSAGE_VARIANTS[number];

/** 一篇原始材料；数组下标加一就是工具和答案引用的 P 段号。 */
export interface Passage {
    id: string;
    title: string;
    paragraphs: string[];
}

/** 解题所需的题干和选项，不包含题库参考答案或评测标签。 */
export interface PassageQuestion {
    id: string;
    number: number;
    question: string;
    options: string[];
    type: "single-choice" | "multiple-choice" | "open";
}

/** 一轮阅读任务：原文加本次要回答的题目。 */
export interface PassageTask<P extends Passage = Passage, Q extends PassageQuestion = PassageQuestion> {
    passage: P;
    questions: Q[];
}

/** 题库的三个分区；知识库可检索，开发集和测试集只供评测。 */
export interface CorpusSplits<Q> {
    knowledge: Q[];
    development: Q[];
    test: Q[];
}

/** 模型可读的原文证据；omitted 是完全未选中的段数，summary 仅作辅助。 */
export interface PassageEvidence {
    paragraphs: { id: string; text: string }[];
    omitted: number;
    summary?: string;
}

/** 给完整原文统一编号，保证两门学科的引用格式一致。 */
export function fullPassageEvidence(passage: Passage): PassageEvidence {
    return { paragraphs: passage.paragraphs.map((text, index) => ({ id: `P${index + 1}`, text })), omitted: 0 };
}
