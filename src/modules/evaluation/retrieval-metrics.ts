import { percentile, rate } from "./statistics.js";

export interface RetrievalCase {
    id: string;
    subject: string;
    category: string;
    query: string;
    relevantIds: string[];
}
export interface RetrievalObservation { ids: string[]; durationMs: number; failed?: boolean; }
export type RetrievalRow = RetrievalCase & RetrievalObservation & { at: Record<number, ReturnType<typeof scoreRetrieval>> };

/** 重复ID占用名次但不重复得分；空标签表示没有适用经验。 */
export function scoreRetrieval(ids: string[], relevantIds: string[], k: number, expand: (id: string) => string[] = id => [id]) {
    if (!Number.isSafeInteger(k) || k < 1) throw new Error("Invalid retrieval cutoff");
    const gold = new Set(relevantIds), seen = new Set<string>();
    let hits = 0, first = 0, dcg = 0;
    ids.slice(0, k).forEach((id, index) => {
        if (gold.has(id) && !seen.has(id)) {
            hits++; dcg += 1 / Math.log2(index + 2); first ||= index + 1;
        }
        seen.add(id);
    });
    const ideal = Array.from({ length: Math.min(k, gold.size) }, (_, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0);
    const covered = new Set(ids.slice(0, k).flatMap(expand));
    return { relevantCount: gold.size, retrievedCount: ids.slice(0, k).length, relevantRetrieved: hits,
        recall: gold.size ? hits / gold.size : null, precision: gold.size ? hits / k : null,
        returnedPrecision: gold.size ? hits / Math.max(1, ids.slice(0, k).length) : null,
        coverageRecall: gold.size ? [...gold].filter(id => covered.has(id)).length / gold.size : null,
        hit: gold.size ? Number(hits > 0) : null, mrr: gold.size ? (first ? 1 / first : 0) : null,
        ndcg: gold.size ? dcg / ideal : null, recallCeiling: gold.size ? Math.min(k, gold.size) / gold.size : null };
}

export function validateRetrievalCases(value: unknown, catalog: ReadonlyMap<string, string>): RetrievalCase[] {
    if (!Array.isArray(value) || !value.length) throw new Error("Retrieval cases must be nonempty");
    const seen = new Set<string>(), queries = new Set<string>();
    for (const item of value) {
        const c = item as RetrievalCase;
        if (!c || [c.id, c.subject, c.category, c.query].some(v => typeof v !== "string" || !v.trim()) ||
            c.query.length > 12000 || !Array.isArray(c.relevantIds) || c.relevantIds.some(id => typeof id !== "string") ||
            new Set(c.relevantIds).size !== c.relevantIds.length || seen.has(c.id)) throw new Error("Invalid retrieval case");
        const queryKey = `${c.subject}:${c.query.normalize("NFKC").replace(/\s+/g, " ").trim()}`;
        if (queries.has(queryKey)) throw new Error(`Duplicate query: ${c.id}`);
        for (const id of c.relevantIds) if (catalog.get(id) !== c.subject) throw new Error(`Gold ID missing or in another subject: ${c.id}`);
        seen.add(c.id); queries.add(queryKey);
    }
    return value as RetrievalCase[];
}

const mean = (values: (number | null)[]) => {
    const applicable = values.filter((v): v is number => v !== null);
    return applicable.length ? applicable.reduce((a, b) => a + b, 0) / applicable.length : null;
};

/** 检索器只接收题目和学科，不能读取标签；故障始终留在统计分母中。 */
export async function evaluateRetrieval(cases: RetrievalCase[], retrieve: (input: Pick<RetrievalCase, "query" | "subject">) => Promise<RetrievalObservation>, cutoffs = [1, 3], expand?: (id: string) => string[], concurrency = 1) {
    if (!cases.length || !cutoffs.length || new Set(cutoffs).size !== cutoffs.length || cutoffs.some(k => !Number.isSafeInteger(k) || k < 1) || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Invalid retrieval evaluation");
    const rows: RetrievalRow[] = [];
    const run = async (c: RetrievalCase): Promise<RetrievalRow> => {
        const started = performance.now();
        let observation: RetrievalObservation;
        try {
            observation = await retrieve({ query: c.query, subject: c.subject });
            if (!Array.isArray(observation.ids) || observation.ids.some(id => typeof id !== "string") || !Number.isFinite(observation.durationMs) || observation.durationMs < 0) throw new Error("Invalid observation");
        } catch { observation = { ids: [], durationMs: performance.now() - started, failed: true }; }
        if (observation.failed) observation = { ...observation, ids: [] };
        return { ...c, ...observation, at: Object.fromEntries(cutoffs.map(k => [k, scoreRetrieval(observation.ids, c.relevantIds, k, expand)])) };
    };
    for (let offset = 0; offset < cases.length; offset += concurrency) rows.push(...await Promise.all(cases.slice(offset, offset + concurrency).map(run)));
    const summarize = (items: typeof rows) => {
        const positive = items.filter(r => r.relevantIds.length), negative = items.filter(r => !r.relevantIds.length);
        return { n: items.length, positive: positive.length, noAnswer: negative.length,
            failureRate: rate(items.filter(r => r.failed).length, items.length),
            noAnswerFalsePositiveRate: negative.length ? rate(negative.filter(r => !r.failed && r.ids.length > 0).length, negative.length) : null,
            noAnswerCorrectAbstentionRate: negative.length ? rate(negative.filter(r => !r.failed && !r.ids.length).length, negative.length) : null,
            latencyMs: { p50: percentile(items.map(r => r.durationMs), .5), p95: percentile(items.map(r => r.durationMs), .95) },
            at: Object.fromEntries(cutoffs.map(k => [k, { recall: mean(positive.map(r => r.at[k]!.recall)),
                precision: mean(positive.map(r => r.at[k]!.precision)), returnedPrecision: mean(positive.map(r => r.at[k]!.returnedPrecision)), coverageRecall: mean(positive.map(r => r.at[k]!.coverageRecall)),
                hit: positive.length ? rate(positive.filter(r => r.at[k]!.hit === 1).length, positive.length) : null,
                mrr: mean(positive.map(r => r.at[k]!.mrr)), ndcg: mean(positive.map(r => r.at[k]!.ndcg)),
                recallCeiling: mean(positive.map(r => r.at[k]!.recallCeiling)) }])) };
    };
    const group = (key: "subject" | "category") => Object.fromEntries([...new Set(rows.map(r => r[key]))].sort().map(value => [value, summarize(rows.filter(r => r[key] === value))]));
    return { summary: summarize(rows), bySubject: group("subject"), byCategory: group("category"), rows };
}
