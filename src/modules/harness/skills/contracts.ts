/** 解题经验归公共宿主管理；学科只提供当前题目与原文证据。 */
export interface SolutionSkillDraft {
    name: string;
    description: string;
    applicability: string[];
    steps: string[];
    checks: string[];
    exclusions: string[];
    keywords: string[];
}
export interface SolutionSkill extends SolutionSkillDraft {
    id: string;
    subject: string;
    fingerprint: string;
    questionShape: string;
    sourceHash: string;
    answerHash: string;
    markdown: string;
    createdAt: string;
    embedding?: { model: string; vector: number[] };
    /** 旧记录视为第1版；组合经验通过ID引用子经验，不复制子经验正文。 */
    revision?: number;
    updatedAt?: string;
    componentIds?: string[];
}
/** 新增、更新和拆分共用提交协议，均须在答案复核后审核并原子提交。 */
export interface SkillChange {
    action: "create" | "update" | "split";
    skillId?: string;
    expectedRevision?: number;
    drafts: SolutionSkillDraft[];
    /** 拆分可直接引用已有子经验，无需让模型抄写整份方法。 */
    componentIds?: string[];
    /** 更新可只替换必要字段，其余内容由宿主从当前版本保留。 */
    patch?: Partial<SolutionSkillDraft>;
    reason: string;
}
export type SkillSelector = (input: { query: string; candidates: SolutionSkill[] }, signal?: AbortSignal) => Promise<string[]>;
export interface SkillTransaction {
    list(): Promise<SolutionSkill[]>;
    insert(skill: SolutionSkill): Promise<void>;
    update(skill: SolutionSkill, expectedRevision: number, reason: string): Promise<void>;
}
export interface SolutionSkillStore {
    initialize(): Promise<void>;
    list(subject: string): Promise<SolutionSkill[]>;
    history(subject: string, skillId: string): Promise<SolutionSkill[]>;
    /** 串行执行同学科的完整比较和提交，包括语义去重。 */
    withSubjectLock<T>(subject: string, operation: (transaction: SkillTransaction) => Promise<T>, signal?: AbortSignal): Promise<T>;
    close(): Promise<void>;
}
export interface SkillEmbeddings {
    readonly model: string;
    embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
export const SKILL_AGENTS = { author: "solution_skill_author", validator: "solution_skill_validator", deduplicator: "solution_skill_deduplicator", matcher: "solution_skill_matcher" } as const;
