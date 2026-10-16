export type MathVariant = "baseline" | "agent" | "harness" | "combined" | "lexical" | "rerank" | "memory" | "batch" | "adaptive";
export const MATH_VARIANTS: MathVariant[] = ["baseline", "agent", "harness", "combined"];
export const OPTIMIZED_MATH_VARIANTS: MathVariant[] = ["lexical", "rerank", "memory", "batch", "adaptive"];
export const isOptimizedMathVariant = (variant: MathVariant | "general") => OPTIMIZED_MATH_VARIANTS.includes(variant as MathVariant);
/** Existing combined architecture plus five individually selectable experiments. */
export const MATH_EXPERIMENTS: MathVariant[] = ["combined", ...OPTIMIZED_MATH_VARIANTS];
export const ALL_MATH_VARIANTS = [...new Set([...MATH_VARIANTS, ...MATH_EXPERIMENTS])];
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
export interface MathCorpus {
    version: 1;
    id: string;
    knowledge: MathQuestion[];
    development: MathQuestion[];
    test: MathQuestion[];
    excluded: { row: number; reason: string }[];
}
export interface Embeddings {
    readonly model: string;
    readonly dimensions: number;
    embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
export interface OcrRegion { text: string; confidence: number; box?: [number, number, number, number]; }
/** Provider boundary for future photo search. No image is considered recognized without a provider. */
export interface MathOcrProvider {
    recognize(input: { bytes: Uint8Array; mimeType: "image/jpeg" | "image/png"; language: "zh-CN" }, signal?: AbortSignal): Promise<{
        text: string; regions: OcrRegion[]; warnings: string[];
    }>;
}
export const renderQuestion = (q: Pick<MathQuestion, "question" | "options">) =>
    `${q.question}\n${q.options.map((v, i) => `${"ABCD"[i]}. ${v}`).join("\n")}`;
