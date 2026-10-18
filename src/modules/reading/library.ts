import { loadReadingCorpus, readingHash, readingLayout } from "./corpus.js";
import { readingTask, type ReadingCorpus, type ReadingTask } from "./contracts.js";
import { AppError } from "../../common/errors/app-error.js";
import { CorpusLibrary } from "../subjects/corpus-library.js";
import { readingOptionParts } from "./question-text.js";

/** 语文题库入口，浏览和解题共用缓存；投影时排除参考答案。 */
export class ReadingLibrary extends CorpusLibrary<ReadingCorpus, ReadingTask> {
    constructor(path: string) {
        super(() => loadReadingCorpus(path), (passage, question) => readingTask(passage, [question]),
            () => new AppError(503, "READING_CORPUS_UNAVAILABLE", "语文题库暂不可用，请提供完整阅读原文和题目。"));
    }
}

/** Explicit material boundaries keep original articles out of lossy chat-history inference. */
export function parseReadingInput(content: string): ReadingTask | undefined {
    const match = content.match(/(?:\[原文\]|【原文】|(?:^|\n)原文[：:])\s*([\s\S]+?)\s*(?:\[题目\]|【题目】|(?:^|\n)题目[：:])\s*([\s\S]+)/);
    let article: string, questionText: string;
    if (match) { article = match[1]!; questionText = match[2]!; }
    else {
        // Accept the usual pasted exam layout as well as explicit API boundaries.
        if (!/阅读(?:下面|以下|下列|下文)|语文|选文/.test(content)) return undefined;
        const first = [...content.matchAll(/(?:^|\n)\s*(?:第\d+题[：:]|\d{1,2}[.．、])\s*([^\n]+)/g)]
            .find(candidate => candidate.index! > 80 && /文中|作者|文章|修辞|赏析|段落|选文|主旨|线索|概括|为什么|理解/.test(candidate[1]!));
        if (!first) return undefined;
        article = content.slice(0, first.index); questionText = content.slice(first.index!);
    }
    const { paragraphs, headings } = readingLayout(article);
    if (!paragraphs.length || article.length > 40000) throw new Error("Reading article must contain 1..40000 characters");
    const blocks = [...questionText.matchAll(/(?:^|\n)\s*(?:第(\d+)题[：:]|([0-9]{1,2})[.．、])\s*/g)];
    const sections = blocks.length ? blocks.map((block, index) => ({ number: Number(block[1] ?? block[2]),
        text: questionText.slice(block.index! + block[0].length, blocks[index + 1]?.index).trim() })) : [{ number: 1, text: questionText.trim() }];
    if (sections.length > 8 || sections.some(section => !section.text)) throw new Error("Provide 1..8 reading questions");
    const passageId = `user-reading-${readingHash(article).slice(0, 16)}`;
    return {
        passage: { id: passageId, title: "用户提供的阅读材料", headings, paragraphs, source: { urls: ["urn:chat:user-provided"], answerUrls: [],
            sha256: readingHash(article), publisher: "用户提供", stage: "junior-exam-preparation" } },
        questions: sections.map(section => {
            const { question, options } = readingOptionParts(section.text);
            return { id: `${passageId}-q${section.number}`, number: section.number,
                question, options,
                type: options.length ? /两项|多选|所有.*项/.test(section.text) ? "multiple-choice" : "single-choice" : "open" };
        }),
    };
}

export function isReadingRequest(content: string): boolean {
    return /\[语文(?:阅读|题)?(?:[：:].*)?\]|【语文(?:阅读|题).*?】|(?:\[原文\]|【原文】)[\s\S]*(?:\[题目\]|【题目】)|阅读理解|现代文阅读|文言文阅读/.test(content) ||
        /阅读(?:下面|以下|下列|下文)/.test(content) && !!parseReadingInput(content);
}
