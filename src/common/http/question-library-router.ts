import { Router } from "express";
import { AppError } from "../errors/app-error.js";

/** Shared pagination, opt-in references, and lazy availability handling for subject libraries. */
export function passageQuestionRouter<P extends { id: string; title: string }, Q extends { id: string; passageId: string; answer: string }, T>(
    library: { corpus(): Promise<{ scope: string; passages: P[]; knowledge: Q[] }>; question(id: string): Promise<T | undefined> },
    policy: { subject: string; role: string; variant: string; path: string; errorPrefix: string; question(q: Q): object; extraCapabilities?: object }) {
    const router = Router();
    router.get("/capabilities", (_req, res) => res.json({ data: { role: policy.role, variant: policy.variant, text: true, questionsPath: `${policy.path}/questions`, ...policy.extraCapabilities } }));
    router.get("/questions", async (req, res) => {
        const limit = Number(req.query.limit ?? 20), offset = Number(req.query.offset ?? 0);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0)
            throw new AppError(400, `${policy.errorPrefix}_INVALID_QUERY`, "题目分页参数无效。");
        const corpus = await library.corpus(), titles = new Map(corpus.passages.map(p => [p.id, p.title]));
        res.json({ data: { subject: policy.subject, targetGrade: 9, scope: corpus.scope, total: corpus.knowledge.length,
            questions: corpus.knowledge.slice(offset, offset + limit).map(q => ({ ...policy.question(q), title: titles.get(q.passageId) })) } });
    });
    router.get("/questions/:id", async (req, res) => {
        const task = await library.question(req.params.id!);
        if (!task) throw new AppError(404, `${policy.errorPrefix}_QUESTION_NOT_FOUND`, "题目不存在。");
        const reference = req.query.reference === "true" ? (await library.corpus()).knowledge.find(q => q.id === req.params.id)?.answer : undefined;
        res.json({ data: { ...task, ...(reference ? { reference } : {}) } });
    });
    return router;
}
