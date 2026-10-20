import type { AgentResult, AgentResultContext, AgentResultProcessor, AgentRuntime } from "./contracts.js";

/** 独立核验结果：通过、确定错误或无法确认，并附理由和问题列表。 */
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

/** 答案发布前的核验阶段；确定错误时让主模型修正，再核验修正版。 */
export class AnswerReview implements AgentResultProcessor {
    constructor(private readonly reviewer: string, private readonly reviser: string,
        private readonly evidence: (context: AgentResultContext) => unknown, private readonly maxRevisions = 1) {
        if (!Number.isInteger(maxRevisions) || maxRevisions < 0 || maxRevisions > 2) throw new TypeError("Invalid review revision limit");
    }
    async process(result: AgentResult, runtime: AgentRuntime, context: AgentResultContext, signal?: AbortSignal): Promise<AgentResult> {
        let candidate = result.content, attempts = 0, revised = false, protocolRepairs = 0;
        const finish = (status: NonNullable<AgentResult["review"]>["status"], content: string) => {
            runtime.event("agent.review.completed", { status, attempts, revised });
            return { ...result, content, review: { status, attempts, revised } };
        };
        try {
            const evidence = this.evidence(context);
            runtime.event("agent.review.loop.started", { maxRevisions: this.maxRevisions, maxAttempts: this.maxRevisions + 2, maxProtocolRepairs: 1 });
            for (let revision = 0; ; revision++) {
                signal?.throwIfAborted();
                attempts++;
                runtime.event("agent.review.started", { attempt: attempts });
                let review = await runtime.delegate({ agent: this.reviewer, input: JSON.stringify({ evidence, candidate }) }, signal);
                let report: ReviewReport;
                try { report = parseReviewReport(review.content); }
                catch (error) {
                    if (!(error instanceof Error) || error.message !== "INVALID_REVIEW_REPORT" || protocolRepairs >= 1) throw error;
                    protocolRepairs++;
                    signal?.throwIfAborted();
                    runtime.event("agent.review.protocol_repair", { attempt: attempts, maxRepairs: 1 });
                    attempts++;
                    review = await runtime.delegate({ agent: this.reviewer, input: JSON.stringify({ evidence, candidate,
                        protocolCorrection: "上次报告格式不合法。重新独立核验相同candidate，只输出JSON对象，verdict只能是pass/fail/uncertain之一，reason是非空字符串，issues是字符串数组。pass必须issues为空，fail必须列出确定错误。不要输出Markdown或额外文字。" }) }, signal);
                    report = parseReviewReport(review.content);
                }
                runtime.event("agent.review.report", { attempt: attempts, verdict: report.verdict, reason: report.reason, issues: report.issues });
                const canRevise = report.verdict === "fail" && revision < this.maxRevisions;
                runtime.event("agent.review.decision", { attempt: attempts, verdict: report.verdict, canRevise, remainingRevisions: Math.max(0, this.maxRevisions - revision) });
                if (report.verdict === "pass") return finish("passed", candidate);
                if (report.verdict === "uncertain") return finish("uncertain", "现有信息下暂时无法可靠确认答案。请检查题目条件、原文或图示是否完整。");
                if (revision >= this.maxRevisions) return finish("failed", "这次解答未能通过复核，暂时无法给出可靠答案。");
                runtime.event("agent.review.revision.started", { attempt: attempts, revision: revision + 1, agent: this.reviser });
                const repair = await runtime.delegate({ agent: this.reviser, input: JSON.stringify({ evidence, candidate, review: report }) }, signal);
                candidate = repair.content; revised = true;
                runtime.event("agent.review.revision.completed", { attempt: attempts, revision: revision + 1, nextAttempt: attempts + 1 });
            }
        } catch (error) {
            signal?.throwIfAborted();
            runtime.event("agent.review.failed", { code: error instanceof Error && error.message === "INVALID_REVIEW_REPORT" ? "INVALID_REVIEW_REPORT" : "REVIEW_UNAVAILABLE" });
            return finish("unavailable", "本次解答未能完成复核，暂时无法确认答案，请稍后重试。");
        }
    }
}
