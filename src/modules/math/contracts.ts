export type MathVariant = "baseline" | "agent" | "harness" | "combined";
export const MATH_VARIANTS: MathVariant[] = ["baseline", "agent", "harness", "combined"];
export interface MathQuestion {
    id: string;
    question: string;
    options: string[];
    answer: string;
    topic: string;
    source: { url: string; dataset: string; row: number; sha256: string };
    solution?: string;
    solutionOrigin?: "glm-4.7";
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
