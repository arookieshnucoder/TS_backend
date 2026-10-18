import { passageQuestionRouter } from "../../common/http/question-library-router.js";
import type { ReadingLibrary } from "./library.js";

/** 语文题库浏览接口，共用分页与参考答案显式查询规则。 */
export function readingRouter(library: ReadingLibrary, variant = "adaptive") {
    return passageQuestionRouter(library, {
        subject: "chinese", role: "初中语文阅读理解", variant, path: "/api/reading", errorPrefix: "READING",
        notFoundMessage: "语文题目不存在。",
        question: ({ id, number, passageId, question, options, type, category }) => ({ id, number, passageId, question, options, type, category }),
    });
}
