import type { CorpusSplits } from "../subjects/contracts.js";
export type MathVariant = "baseline" | "agent" | "harness" | "combined" | "lexical" | "rerank" | "memory" | "batch" | "adaptive";
export const MATH_VARIANTS: MathVariant[] = ["baseline", "agent", "harness", "combined"];
export const OPTIMIZED_MATH_VARIANTS: MathVariant[] = ["lexical", "rerank", "memory", "batch", "adaptive"];
export const isOptimizedMathVariant = (variant: MathVariant | "general") => OPTIMIZED_MATH_VARIANTS.includes(variant as MathVariant);
/** Existing combined architecture plus five individually selectable experiments. */
export const MATH_EXPERIMENTS: MathVariant[] = ["combined", ...OPTIMIZED_MATH_VARIANTS];
export const ALL_MATH_VARIANTS = [...new Set([...MATH_VARIANTS, ...MATH_EXPERIMENTS])];
/** 数学题库条目，包含来源、题型和参考解法；评测标签不得传给解题模型。 */
export interface MathQuestion {
    id: string;
    question: string;
    options: string[];
    answer: string;
    topic: string;
    source: { url: string; dataset: string; row: number; sha256: string; kind?: "authored" };
    solution?: string;
    solutionOrigin?: "glm-4.7" | "authored-formula";
    grade?: 9;
    family?: string;
    difficulty?: "standard" | "long-hard";
    skills?: string[];
    /** Grader-only labels. Never passed to runtime retrieval or model prompts. */
    relevantIds?: string[];
    textAudit?: { originalQuestion: string; evidenceUrl: string; page: number; reason: string };
}
/** 数学题库及版本信息，知识、开发和测试分区共用公共题库契约。 */
export interface MathCorpus extends CorpusSplits<MathQuestion> {
    version: 1;
    id: string;
    excluded: { row: number; reason: string }[];
}
/** 文本向量提供者接口，明确模型名与维度，便于校验索引是否匹配。 */
export interface Embeddings {
    readonly model: string;
    readonly dimensions: number;
    embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
/** 图片识别出的一个文本区域，记录置信度及可选边框坐标。 */
export interface OcrRegion { text: string; confidence: number; box?: [number, number, number, number]; }
/** 数学图片识别接口；只有真实提供者返回结果后才能使用识别文本。 */
export interface MathOcrProvider {
    recognize(input: { bytes: Uint8Array; mimeType: "image/jpeg" | "image/png"; language: "zh-CN" }, signal?: AbortSignal): Promise<{
        text: string; regions: OcrRegion[]; warnings: string[];
    }>;
}
export const renderQuestion = (q: Pick<MathQuestion, "question" | "options">) =>
    `${q.question}\n${q.options.map((v, i) => `${"ABCD"[i]}. ${v}`).join("\n")}`;
