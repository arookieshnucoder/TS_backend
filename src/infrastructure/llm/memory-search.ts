import { createHash } from "node:crypto";
import type { ChatSession } from "../../modules/chat/entity/chat-session.entity.js";
import type { MemoryChunk, MemorySearch } from "../../modules/chat/service/memory-search.js";
import type { ContextConfig } from "../../modules/harness/context/config.js";
import { TokenBudget } from "../../modules/harness/context/tokens.js";

const terms = (text: string): string[] => text.toLowerCase().match(/\p{Script=Han}|[\p{L}\p{N}]+/gu) ?? [];
/** 索引服务请求失败，保留状态码供上层判断错误，不自动改用本地检索。 */
class IndexRequestError extends Error {
    constructor(readonly status: number, readonly reason?: string) { super(`Memory index request failed (HTTP ${status})`); }
}
/**
 * 基于 BM25 算法的本地文本检索实现。
 * 用于在不依赖 Elasticsearch 的情况下进行快速原型开发和本地测试。
 */
export function bm25(query: string, documents: string[]): number[] {
    const tokenized = documents.map(terms), queryTerms = [...new Set(terms(query))];
    const average = tokenized.reduce((n, t) => n + t.length, 0) / (documents.length || 1) || 1;
    const frequency = new Map<string, number>();
    const counts = tokenized.map(tokens => {
        const counts = new Map<string, number>();
        for (const word of tokens) counts.set(word, (counts.get(word) ?? 0) + 1);
        for (const word of counts.keys()) frequency.set(word, (frequency.get(word) ?? 0) + 1);
        return counts;
    });
    return tokenized.map((tokens, index) => queryTerms.reduce((score, word) => {
        const df = frequency.get(word) ?? 0;
        const tf = counts[index]!.get(word) ?? 0;
        return score + Math.log(1 + (documents.length - df + .5) / (df + .5)) *
            tf * 2.2 / (tf + 1.2 * (.25 + .75 * tokens.length / average));
    }, 0));
}

function memoryChunks(sessions: ChatSession[], tokens: TokenBudget): MemoryChunk[] {
    return sessions.flatMap(s => s.messages.flatMap(m => tokens.chunks(m.content).map((text, index) => ({
        id: `${s.id}-${m.id}-${index}`, sessionId: s.id, title: s.title, text: `${m.role}: ${text}`,
    }))));
}
/**
 * 本地内存检索实现。
 * 使用 BM25 算法对本地存储的聊天会话进行快速检索。
 */
export class LocalMemorySearch implements MemorySearch {
    protected sessions: ChatSession[] = [];
    protected chunks: MemoryChunk[] = [];
    constructor(protected readonly tokens: TokenBudget) { }
    async sync(sessions: ChatSession[], signal?: AbortSignal) {
        signal?.throwIfAborted();
        this.sessions = structuredClone(sessions);
        this.chunks = memoryChunks(sessions, this.tokens);
    }
    async titles(query: string, ids: string[], signal?: AbortSignal) {
        signal?.throwIfAborted();
        const sessions = this.sessions.filter(s => ids.includes(s.id));
        const scores = bm25(query, sessions.map(s => s.title));
        return sessions.map((s, i) => ({ id: s.id, score: scores[i]! })).filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score).slice(0, 3).map(s => s.id);
    }
    async search(query: string, ids: string[], limit: number, signal?: AbortSignal) {
        signal?.throwIfAborted();
        const chunks = this.chunks.filter(c => ids.includes(c.sessionId));
        const scores = bm25(query, chunks.map(c => c.text));
        return chunks.map((chunk, i) => ({ chunk, score: scores[i]! })).filter(c => c.score > 0)
            .sort((a, b) => b.score - a.score).slice(0, limit).map(c => c.chunk);
    }
}

/**
 * 基于 Elasticsearch 的内存检索实现。
 * 使用 Elasticsearch 提供的全文检索和向量检索能力，对存储的聊天会话进行高效检索。
 */
export class ElasticsearchMemorySearch implements MemorySearch {
    private ready?: Promise<void>;
    private readonly documentIds = new Map<string, { title: string[]; chunk: string[] }>();
    private syncQueue: Promise<void> = Promise.resolve();

    constructor(private readonly tokens: TokenBudget, private readonly config: ContextConfig) { }

    private async request(path: string, body: unknown, signal?: AbortSignal, method = "POST") {
        const response = await fetch(`${this.config.elasticsearchUrl}/${this.config.index}${path}`, {
            method, signal, headers: {
                "Content-Type": "application/json",
                ...(this.config.elasticsearchApiKey ? { Authorization: `ApiKey ${this.config.elasticsearchApiKey}` } : {})
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({})) as { error?: { type?: string } };
            throw new IndexRequestError(response.status, payload.error?.type);
        }
        return response.json() as Promise<any>;
    }
    /**
     * 初始化 Elasticsearch 索引，如果索引不存在则创建。
     * @param signal 可选的中止信号，用于取消初始化请求。
     * @returns 初始化完成的 Promise。
     */
    private async initialize(signal?: AbortSignal) {
        const response = await fetch(`${this.config.elasticsearchUrl}/${this.config.index}`, {
            method: "HEAD", signal,
            headers: this.config.elasticsearchApiKey ? { Authorization: `ApiKey ${this.config.elasticsearchApiKey}` } : {}
        });
        if (response.ok) return;
        if (response.status !== 404) throw new Error(`Memory index unavailable (HTTP ${response.status})`);
        try {
            await this.request("", {
                mappings: {
                    properties: {
                        id: { type: "keyword" }, sessionId: { type: "keyword" }, kind: { type: "keyword" },
                        title: { type: "text", analyzer: "cjk" }, text: { type: "text", analyzer: "cjk" },
                        ...(this.config.embeddingModel ? { vector: { type: "dense_vector", dims: this.config.embeddingDimensions, index: true, similarity: "cosine" } } : {}),
                    }
                }
            }, signal, "PUT");
        }
        catch (error) {
            // Another request may have created the same index after our HEAD.
            if (!(error instanceof IndexRequestError && error.status === 400 && error.reason === "resource_already_exists_exception")) throw error;
        }
    }
    /**
     * 获取文本的向量表示。
     * @param text 需要进行向量化的文本。
     * @param signal 可选的中止信号，用于取消向量化请求。
     * @returns 文本的向量表示。
     */
    private async embed(text: string, signal?: AbortSignal): Promise<number[]> {
        const response = await fetch(`${this.config.embeddingBaseUrl}/embeddings`, {
            method: "POST", signal,
            headers: { "Content-Type": "application/json", ...(this.config.embeddingApiKey ? { Authorization: `Bearer ${this.config.embeddingApiKey}` } : {}) },
            body: JSON.stringify({ model: this.config.embeddingModel, input: text }),
        });
        if (!response.ok) throw new Error(`Embedding failed (HTTP ${response.status})`);
        const body = await response.json() as any;
        const vector = body.data?.[0]?.embedding;
        if (!Array.isArray(vector) || vector.length !== this.config.embeddingDimensions || !vector.every(Number.isFinite))
            throw new Error("Invalid embedding dimensions or values");
        return vector;
    }

    async sync(sessions: ChatSession[], signal?: AbortSignal) {
        // Serialize updates to prevent older concurrent snapshots overwriting newer documents.
        const work = this.syncQueue.then(async () => {
            await (this.ready ??= this.initialize(signal).catch(error => { this.ready = undefined; throw error; }));
            signal?.throwIfAborted();
            const chunks = memoryChunks(sessions, this.tokens);
            for (const session of sessions) {
                const docs = [{ id: `title-${session.id}`, sessionId: session.id, title: session.title, text: session.title, kind: "title" as const },
                ...chunks.filter(c => c.sessionId === session.id).map(c => ({ ...c, kind: "chunk" as const }))].map(doc => ({
                    ...doc, id: createHash("sha256").update(JSON.stringify([doc.id, doc.text,
                    this.config.embeddingModel, this.config.embeddingDimensions])).digest("hex"),
                }));
                this.documentIds.set(session.id, {
                    title: docs.filter(d => d.kind === "title").map(d => d.id),
                    chunk: docs.filter(d => d.kind === "chunk").map(d => d.id)
                });
                // 使用内容寻址的记录是不可变的：并发会话无法覆盖快照。
                // _mget 避免在重启后或每次新的聊天轮次中重复计算向量。
                for (let offset = 0; offset < docs.length; offset += 100) {
                    const batch = docs.slice(offset, offset + 100);
                    const stored = await this.request("/_mget?_source=false", { ids: batch.map(d => d.id) }, signal);
                    if (!Array.isArray(stored.docs) || stored.docs.some((d: any) => d.error)) throw new Error("Memory index lookup failed");
                    const found = new Set(stored.docs.filter((d: any) => d.found).map((d: any) => d._id));
                    for (const doc of batch) {
                        if (found.has(doc.id)) continue;
                        const vector = this.config.embeddingModel ? await this.embed(doc.text, signal) : undefined;
                        await this.request(`/_doc/${encodeURIComponent(doc.id)}`, { ...doc, ...(vector ? { vector } : {}) }, signal, "PUT");
                    }
                }
            }
            await this.request("/_refresh", undefined, signal);
        });
        this.syncQueue = work.catch(() => { });
        return work;
    }
    /**
     * 根据查询在指定的会话中检索相关的内存块。
     * @param query 查询的文本。
     * @param ids 相关的会话 ID 列表。
     * @param kind 内存块的类型，"title" 或 "chunk"。
     * @param limit 返回的内存块数量上限。
     * @param signal 可选的中止信号，用于取消检索请求。
     * @returns 匹配的内存块列表。
     */
    private async retrieve(query: string, ids: string[], kind: "title" | "chunk", limit: number, signal?: AbortSignal): Promise<MemoryChunk[]> {
        if (!ids.length) return [];
        const filter = [{ terms: { sessionId: ids } }, { term: { kind } },
        { terms: { id: ids.flatMap(id => this.documentIds.get(id)?.[kind] ?? []) } }];
        const lexical = await this.request("/_search", {
            size: limit, _source: ["id", "sessionId", "title", "text"],
            query: { bool: { filter, must: [{ match: { [kind === "title" ? "title" : "text"]: query } }] } }
        }, signal);
        const lists: any[][] = [lexical.hits.hits];
        if (this.config.embeddingModel) {
            const vector = await this.embed(this.tokens.truncate(query, 2048), signal);
            const semantic = await this.request("/_search", {
                size: limit, _source: ["id", "sessionId", "title", "text"],
                knn: { field: "vector", query_vector: vector, k: limit, num_candidates: Math.max(50, limit), filter, similarity: .5 }
            }, signal);
            lists.push(semantic.hits.hits);
        }
        // 使用应用端的 RRF（Reciprocal Rank Fusion）方法融合词法和语义检索结果，避免依赖 Elasticsearch 的付费 RRF 检索器。
        const fused = new Map<string, { doc: MemoryChunk; score: number }>();
        for (const list of lists) list.forEach((hit, rank) => {
            const previous = fused.get(hit._id);
            fused.set(hit._id, { doc: hit._source, score: (previous?.score ?? 0) + 1 / (60 + rank + 1) });
        });
        return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(v => v.doc);
    }

    async titles(query: string, ids: string[], signal?: AbortSignal) {
        return (await this.retrieve(query, ids, "title", 3, signal)).map(c => c.sessionId);
    }

    async search(query: string, ids: string[], limit: number, signal?: AbortSignal) {
        return this.retrieve(query, ids, "chunk", limit, signal);
    }
}
