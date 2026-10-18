import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Embeddings } from "./contracts.js";
import { normalizeMath } from "./normalize.js";
/** 保存用户题目和解题结果，管理规范化文本、向量及提交状态。 */
export class MathSubmissions {
    constructor(private readonly directory: string, private readonly embeddings: Embeddings) {}
    async ingest(text: string, signal?: AbortSignal, vectorize=true) {
        if (!text.trim() || text.length > 12000) throw new Error("Invalid math question text");
        const normalized = normalizeMath(text), [vector] = vectorize?await this.embeddings.embed([normalized], signal):[];
        if (vectorize&&(!vector || vector.length !== this.embeddings.dimensions || vector.some(n => !Number.isFinite(n)))) throw new Error("Invalid submission embedding");
        signal?.throwIfAborted();
        const record = { id: randomUUID(), text, normalized, vector:vector??null, embeddingStatus:vectorize?"stored":"retrieval_owned", embeddingModel: this.embeddings.model, dimensions: this.embeddings.dimensions,
            createdAt: new Date().toISOString(), status: "pending", trusted: false, answer: null as string | null };
        await mkdir(this.directory, { recursive: true });
        await writeFile(join(this.directory, `${record.id}.json`), JSON.stringify(record), { flag: "wx" });
        return { record, finish: async (answer: string) => { record.answer = answer; record.status = "solved_unverified";
            const file = join(this.directory, `${record.id}.json`); await writeFile(file, JSON.stringify(record)); } };
    }
}
