import { passageQuestionRouter } from "../../common/http/question-library-router.js";
import type { EnglishLibrary } from "./library.js";
export function englishRouter(library: EnglishLibrary, variant = "adaptive") {
    return passageQuestionRouter(library, { subject: "english", role: "初三英语选择题", variant, path: "/api/english", errorPrefix: "ENGLISH",
        question: ({ id, passageId, number, question, options, type, kind, category, blank }) => ({ id, passageId, number, question, options, type, kind, category, ...(blank ? { blank } : {}) }),
        extraCapabilities: { kinds: ["reading", "grammar", "cloze"], listening: false, writing: false, review: "not_configured" },
    });
}
