import type { AgentResult, AgentResultContext, AgentResultProcessor, AgentRuntime } from "./contracts.js";

export interface ReviewReport { verdict: "pass" | "fail" | "uncertain"; reason: string; issues: string[]; }
export function parseReviewReport(content: string): ReviewReport {
    const text = content.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, "$1");
    let value: ReviewReport;
    try { value = JSON.parse(text); } catch { throw new Error("INVALID_REVIEW_REPORT"); }
    if (!value || !["pass", "fail", "uncertain"].includes(value.verdict) || typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 4000 ||
        !Array.isArray(value.issues) || value.issues.length > 8 || value.issues.some(issue => typeof issue !== "string" || !issue.trim() || issue.length > 1000) ||
        value.verdict === "pass" && value.issues.length !== 0 || value.verdict === "fail" && !value.issues.length) throw new Error("INVALID_REVIEW_REPORT");
    return { verdict: value.verdict, reason: value.reason, issues: value.issues };
}

/** Domain-independent result stage: review, one optional repair, then review the actual repaired output. */
export class AnswerReview implements AgentResultProcessor {
    constructor(private readonly reviewer: string, private readonly reviser: string,
        private readonly evidence: (context: AgentResultContext) => unknown, private readonly maxRevisions = 1) {
        if (!Number.isInteger(maxRevisions) || maxRevisions < 0 || maxRevisions > 2) throw new TypeError("Invalid review revision limit");
    }
    async process(result: AgentResult, runtime: AgentRuntime, context: AgentResultContext, signal?: AbortSignal): Promise<AgentResult> {
        let candidate = result.content, attempts = 0, revised = false;
        const finish = (status: NonNullable<AgentResult["review"]>["status"], content: string) => {
            runtime.event("agent.review.completed", { status, attempts, revised });
            return { ...result, content, review: { status, attempts, revised } };
        };
        try {
            const evidence = this.evidence(context);
            for (let revision = 0; ; revision++) {
                signal?.throwIfAborted();
                attempts++;
                runtime.event("agent.review.started", { attempt: attempts });
                const review = await runtime.delegate({ agent: this.reviewer, input: JSON.stringify({ evidence, candidate }) }, signal);
                const report = parseReviewReport(review.content);
                runtime.event("agent.review.report", { attempt: attempts, verdict: report.verdict, reason: report.reason, issues: report.issues });
                if (report.verdict === "pass") return finish("passed", candidate);
                if (report.verdict === "uncertain") return finish("uncertain", "现有信息下暂时无法可靠确认答案。请检查题目条件、原文或图示是否完整。");
                if (revision >= this.maxRevisions) return finish("failed", "这次解答未能通过复核，暂时无法给出可靠答案。");
                const repair = await runtime.delegate({ agent: this.reviser, input: JSON.stringify({ evidence, candidate, review: report }) }, signal);
                candidate = repair.content; revised = true;
            }
        } catch (error) {
            signal?.throwIfAborted();
            runtime.event("agent.review.failed", { code: error instanceof Error && error.message === "INVALID_REVIEW_REPORT" ? "INVALID_REVIEW_REPORT" : "REVIEW_UNAVAILABLE" });
            return finish("unavailable", "本次解答未能完成复核，暂时无法确认答案，请稍后重试。");
        }
    }
}
