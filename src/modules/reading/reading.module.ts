import { Router } from "express";
import type { ReadingLibrary } from "./library.js";
import { AppError } from "../../common/errors/app-error.js";

/** Public question browsing uses the same corpus loader as chat; references are opt-in, solver tasks omit them. */
export function readingRouter(library: ReadingLibrary, variant = "adaptive"): Router {
    const router = Router();
    router.get("/capabilities", (_req, res) => res.json({ data: { role: "初中语文阅读理解", variant, text: true, questionsPath: "/api/reading/questions" } }));
    router.get("/questions", async (req, res) => {
        const limit = Number(req.query.limit ?? 20), offset = Number(req.query.offset ?? 0);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0) {
            throw new AppError(400, "READING_INVALID_QUERY", "题目分页参数无效。");
        }
        const corpus = await library.corpus();
        const titles = new Map(corpus.passages.map(passage => [passage.id, passage.title]));
        res.json({ data: { subject: "chinese", targetGrade: 9, scope: corpus.scope, total: corpus.knowledge.length,
            questions: corpus.knowledge.slice(offset, offset + limit).map(({ id, number, passageId, question, options, type, category }) =>
                ({ id, number, passageId, title: titles.get(passageId), question, options, type, category })) } });
    });
    router.get("/questions/:id", async (req, res) => {
        const task = await library.question(req.params.id!);
        if (!task) throw new AppError(404, "READING_QUESTION_NOT_FOUND", "语文题目不存在。");
        const reference = req.query.reference === "true" ? (await library.corpus()).knowledge.find(question => question.id === req.params.id)?.answer : undefined;
        res.json({ data: { ...task, ...(reference ? { reference } : {}) } });
    });
    return router;
}
