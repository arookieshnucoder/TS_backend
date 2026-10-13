import type { HarnessInput, HarnessRunner } from "../harness/agent-harness.js";
import { MathRag } from "./rag.js";
/** Harness-only ablation leaves AskAgent intact, supplying evidence before the first decision turn. */
export class MathRetrievalHarness implements HarnessRunner {
    constructor(private readonly inner: HarnessRunner, private readonly rag: MathRag) {}
    async run(input: HarnessInput, signal?: AbortSignal) {
        const result = await this.rag.search(input.question, "hybrid", signal);
        input.onEvent?.("math.retrieval", { mode: "hybrid", cacheHit: result.cacheHit, durationMs: result.durationMs,
            ids: result.hits.map(h => h.question.id), topics: result.hits.map(h => h.question.topic), prefetched: true, checks: result.checks ? Object.keys(result.checks) : [] });
        return this.inner.run({ ...input, history: [...input.history, { role: "user", content: `[数学检索资料]\n${this.rag.evidence(result, true)}` }] }, signal);
    }
}
