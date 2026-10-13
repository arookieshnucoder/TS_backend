import { hash } from "../src/modules/math/corpus.js";
import { MathRag, corpusDigest, type VectorIndex } from "../src/modules/math/rag.js";
import type { Embeddings, MathQuestion } from "../src/modules/math/contracts.js";

export const question = (id: string, text: string, topic = "algebra"): MathQuestion => ({
    id, question: text, topic, options: ["1", "2", "3", "4"], answer: "B",
    source: { url: "https://example.com/public-math", row: 1, sha256: hash(text), dataset: "test-only" },
    solution: "这是测试解析，使用代入原方程的方法进行核验。",
});
export const examples = [question("quadratic", "解一元二次方程x^2-3x+2=0", "quadratic"),
    question("statistics", "计算数据的众数和中位数", "statistics"), question("circle", "求圆的面积", "geometry")];
export function fixture() {
    let calls = 0;
    const embeddings: Embeddings = { model: "test-only", dimensions: 3, async embed(texts, signal) {
        calls++; signal?.throwIfAborted();
        return texts.map(text => /中位数|众数/.test(text) ? [0, 1, 0] : /圆/.test(text) ? [0, 0, 1] : [1, 0, 0]);
    } };
    const index: VectorIndex = { version: 1, corpusHash: corpusDigest(examples), model: embeddings.model, dimensions: 3,
        ids: examples.map(q => q.id), vectors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
    return { embeddings, index, rag: new MathRag(examples, index, embeddings), calls: () => calls };
}
