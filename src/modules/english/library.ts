import { AppError } from "../../common/errors/app-error.js";
import { choiceOptionParts } from "../harness/choice-text.js";
import { englishHash, loadEnglishCorpus } from "./corpus.js";
import { englishTask, type EnglishCorpus, type EnglishPassage, type EnglishQuestion, type EnglishTask } from "./contracts.js";

export class EnglishLibrary {
    private pending?: Promise<EnglishCorpus>;
    constructor(private readonly path: string) {}
    corpus(): Promise<EnglishCorpus> {
        return this.pending ??= loadEnglishCorpus(this.path).catch(() => { this.pending = undefined; throw new AppError(503, "ENGLISH_CORPUS_UNAVAILABLE", "英语题库暂不可用，请直接提供英文原文和完整选择题。"); });
    }
    async question(id: string): Promise<EnglishTask | undefined> {
        const corpus = await this.corpus(), question = corpus.knowledge.find(q => q.id === id);
        if (!question) return undefined;
        const passage = corpus.passages.find(p => p.id === question.passageId);
        return passage ? englishTask(passage, [question]) : undefined;
    }
}
export function unsupportedEnglish(text: string): boolean {
    const task = text.split(/\[(?:Questions?|题目)\]/i).at(-1)!;
    return /(?:^|\n)\s*(?:\[英语\]\s*)?(?:(?:please|can you|could you|help me)\s+)?(?:听力|听录音|Listen to (?:the )?(?:recording|tape)|Write (?:an? |your )?(?:essay|composition)|作文|书面表达)/im.test(task) ||
        /(?:请|帮我|完成|写|撰写).{0,12}(?:英语作文|英语短文|书面表达|听力题)/.test(task);
}
/** Explicit source boundaries; all unknown or excluded task formats stop before the model. */
export function parseEnglishInput(content: string): EnglishTask | undefined {
    if (unsupportedEnglish(content)) return undefined;
    if (content.length > 60000) throw new AppError(400, "ENGLISH_INPUT_TOO_LARGE", "英文材料过长，请分篇提交。");
    const match = content.match(/(?:\[(?:Passage|Article|原文|英语原文)\]|【(?:原文|英语原文)】)\s*([\s\S]*?)\s*(?:\[(?:Questions?|题目)\]|【题目】)\s*([\s\S]+)/i);
    const article = match?.[1]?.trim();
    const questionText = (match?.[2] ?? content.replace(/^\s*(?:\[英语\]|【英语】)\s*/, "")).trim();
    const blocks = [...questionText.matchAll(/(?:^|\n)\s*(?:第\s*(\d+)\s*题[：:]|(?:Question|Q)\s*(\d+)[.:：)]|([0-9]{1,2})[.、)])\s*/gi)];
    const sections = blocks.length ? blocks.map((block, i) => ({ number: Number(block[1] ?? block[2] ?? block[3]),
        text: questionText.slice(block.index! + block[0].length, blocks[i + 1]?.index).trim() })) : [{ number: 1, text: questionText }];
    if (!sections.length || sections.length > 20 || new Set(sections.map(s => s.number)).size !== sections.length || sections.some(s => s.number < 1 || !s.text))
        throw new AppError(400, "ENGLISH_INVALID_QUESTIONS", "请一次提交1至20道编号不重复的选择题。");
    let parsed;
    try { parsed = sections.map(s => ({ ...s, ...choiceOptionParts(s.text) })); }
    catch { throw new AppError(400, "ENGLISH_INVALID_OPTIONS", "英语选择题的选项必须按A至D顺序提供。"); }
    if (parsed.some(s => s.options.length !== 4 || s.options.some(o => !o.trim()) || new Set(s.options.map(o => o.toLowerCase().replace(/\s+/g, " ").trim())).size !== 4 || !s.question.trim())) return undefined;
    if (!article && parsed.some(s => /according to (?:the )?(?:passage|text)|in (?:the )?(?:passage|text)|main idea|best title|文章|原文|完形|cloze/i.test(s.question))) return undefined;
    const id = `user-english-${englishHash(article ?? questionText).slice(0, 16)}`;
    const passage: EnglishPassage = { id, title: "用户提供的英语练习", paragraphs: article ? article.split(/\r?\n+/).map(s => s.trim()).filter(Boolean) : parsed.map(s => s.question),
        source: { kind: "authored", urls: [`urn:tspj:english:${id}`], originalId: id, sha256: englishHash(article ?? questionText), license: "user-provided" } };
    return { passage, questions: parsed.map(({ number, question, options }) => ({ id: `${id}-q${number}`, number, question, options, type: "single-choice",
        kind: article ? /cloze|完形|blank|空格/i.test(questionText) ? "cloze" : "reading" : "grammar",
        ...(/cloze|完形|blank|空格/i.test(questionText) ? { blank: number } : {}) })) };
}
export function isEnglishRequest(content: string): boolean {
    if (unsupportedEnglish(content)) return true;
    if (/\[英语(?:题[：:].*)?\]|【英语】|\[(?:Passage|Article)\]|英语(?:阅读|语法|完形|作文|听力)|English (?:reading|grammar|cloze)/i.test(content)) return true;
    if (/\[原文\][\s\S]*\[题目\]/.test(content)) {
        const article = content.split("[题目]")[0]!;
        return (article.match(/[a-z]/gi)?.length ?? 0) > (article.match(/[\p{Script=Han}]/gu)?.length ?? 0) * 3;
    }
    return /(?:^|\n)\s*A[.．]/.test(content) && (content.match(/[a-z]/gi)?.length ?? 0) > 30;
}
