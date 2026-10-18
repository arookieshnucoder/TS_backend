import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ReadingCorpus, ReadingPassage, ReadingQuestion } from "./contracts.js";
import { readingOptionParts } from "./question-text.js";

export const readingHash = (text: string) => createHash("sha256").update(text).digest("hex");
const normalize = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, "");

/** Keep titles/authors as metadata, not numbered body paragraphs; source files retain the untouched original. */
export function readingLayout(text: string, removePublisher = false): { headings: string[]; paragraphs: string[] } {
    const paragraphs = text.split(/\n+/).map(text => text.trim()).filter(Boolean)
        .filter(text => !removePublisher || !/中考网为|新一轮中考复习备考周期|中考网.*整理|中考网微信公众号|新初三快扫码|每日推送学习技巧/.test(text));
    const headings: string[] = [];
    while (paragraphs.length > 1 && headings.length < 5 && paragraphs[0]!.length <= 45 &&
        !/^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳\d“「"]|[。！？；!?;]/.test(paragraphs[0]!)) headings.push(paragraphs.shift()!);
    return { headings, paragraphs };
}

/** Entire articles are split together. Exact text hashes and normalized titles catch duplicated editions. */
export function validateReadingCorpus(value: unknown): ReadingCorpus {
    const corpus = value as ReadingCorpus;
    if (corpus?.version !== 1 || corpus.subject !== "chinese" || corpus.targetGrade !== 9 || corpus.scope !== "public-junior-exam-preparation" ||
        ![corpus.passages, corpus.knowledge, corpus.development, corpus.test, corpus.excluded].every(Array.isArray)) throw new Error("Invalid reading corpus");
    const passages = new Map<string, ReadingPassage>();
    const articleHashes = new Set<string>();
    for (const passage of corpus.passages) {
        const hash = readingHash(normalize(passage.paragraphs.join("\n")));
        if (!passage.id || passages.has(passage.id) || !passage.title?.trim() || !Array.isArray(passage.paragraphs) || passage.paragraphs.length < 1 ||
            passage.paragraphs.some(text => typeof text !== "string" || !text.trim()) || articleHashes.has(hash) ||
            passage.source?.stage !== "junior-exam-preparation" || !/^[a-f0-9]{64}$/.test(passage.source.sha256) ||
            !passage.source.urls?.length || !passage.source.answerUrls?.length || [...passage.source.urls, ...passage.source.answerUrls].some(url => !url.startsWith("https://")))
            throw new Error("Invalid or duplicate reading article");
        passages.set(passage.id, passage); articleHashes.add(hash);
    }
    const ids = new Set<string>(), articleSplits = new Map<string, string>();
    for (const [split, questions] of [["knowledge", corpus.knowledge], ["development", corpus.development], ["test", corpus.test]] as const) {
        for (const question of questions) {
            if (!question.id || ids.has(question.id) || !passages.has(question.passageId) || !Number.isSafeInteger(question.number) ||
                !question.question?.trim() || !question.answer?.trim() || !Array.isArray(question.options) || question.options.some(option => typeof option !== "string" || !option.trim()) ||
                !["single-choice", "multiple-choice", "open"].includes(question.type) || !["detail", "inference", "structure", "expression", "theme"].includes(question.category) ||
                (question.type !== "open" && (question.options.length < 2 || question.options.length > 6 || !/^[A-F]{1,6}$/.test(question.answer) ||
                    [...question.answer].some(letter => "ABCDEF".indexOf(letter) >= question.options.length)))) throw new Error("Invalid reading question");
            if (articleSplits.has(question.passageId) && articleSplits.get(question.passageId) !== split) throw new Error("Reading article leaked across splits");
            articleSplits.set(question.passageId, split); ids.add(question.id);
        }
    }
    return corpus;
}
export async function loadReadingCorpus(path: string): Promise<ReadingCorpus> {
    return validateReadingCorpus(JSON.parse(await readFile(path, "utf8")));
}

/** 公开语文网页的整理输入，保存材料文本、出处和参考答案页面。 */
export interface PublicReadingPage {
    title: string; questionText: string; answerText: string; questionUrls: string[]; answerUrls: string[]; questionHash: string;
}
const numbered = (text: string) => [...text.matchAll(/(?:^|\n)\s*(\d{1,2})[.．、]\s*/g)];
function category(text: string): ReadingQuestion["category"] {
    if (/标题|主旨|主题|中心|情感|感情/.test(text)) return "theme";
    if (/修辞|描写|赏析|语言|加点|划线|画线|表达效果|词语/.test(text)) return "expression";
    if (/作用|结构|顺序|线索|开头|结尾|段落/.test(text)) return "structure";
    if (/理解|含义|为什么|原因|启示|看法|人物|形象/.test(text)) return "inference";
    return "detail";
}
/** Parses source numbering and reference text only. Missing references/images are excluded rather than invented. */
export function importReadingPage(page: PublicReadingPage): { passage: ReadingPassage; questions: ReadingQuestion[] } {
    let questionText = page.questionText, answerText = page.answerText;
    if (page.questionUrls[0] === page.answerUrls[0]) {
        const boundary = /(?:^|\n)\s*(?:参考答案|答案(?:及解析)?|【(?:参考)?答案】|参考解答|参考答案及评分标准)[：:\s]*/.exec(questionText);
        if (!boundary?.index) throw new Error("No explicit answer boundary on combined page");
        answerText = questionText.slice(boundary.index + boundary[0].length);
        questionText = questionText.slice(0, boundary.index);
    }
    // Walk back through source question numbers: vocabulary/fill-in questions may contain no question verb,
    // and a missing first reference must never cause that question to become part of the article.
    answerText = answerText.replace(/\n\s*总结[：:][\s\S]*$/, "").replace(/^\s*答案[：:]\s*(?=\d)/, "");
    const answerNumbers = numbered(answerText);
    const numbers = numbered(questionText);
    let firstIndex = numbers.findIndex(match => /[?？]|分[）)]|简要|下列|结合|请|概括|赏析|文中|文章|选文|标题|为什么|联系|填写|理解|解释|翻译|断句|注音|本文/.test(questionText.slice(match.index!, questionText.indexOf("\n", match.index! + match[0].length) < 0 ? undefined : questionText.indexOf("\n", match.index! + match[0].length))));
    while (firstIndex > 0 && Number(numbers[firstIndex - 1]![1]) + 1 === Number(numbers[firstIndex]![1])) firstIndex--;
    const first = numbers[firstIndex];
    if (!first?.index || first.index < 250) throw new Error("Missing complete article or numbered questions");
    const passageText = questionText.slice(0, first.index).replace(/^阅读(?:下面|下列).*?(?:\n|$)/, "").trim();
    if (passageText.length < 250 || /&[a-z]+;/.test(passageText)) throw new Error("Article too short or undecoded HTML");
    // Preserve source numbering: a question about paragraph ④ must still see that original marker.
    const { headings, paragraphs } = readingLayout(passageText, true);
    if (paragraphs.join("").length < 250) throw new Error("Article too short after publisher/heading cleanup");
    if (/原文略|引文略|下文略|中间略|正文略/.test(paragraphs.join(""))) throw new Error("Source explicitly omits article text");
    const questionSection = questionText.slice(first.index);
    const circles = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
    const bodyMarkers = new Set(paragraphs.flatMap(text => /^[①-⑳]/.exec(text)?.[0] ?? []));
    // A webpage can be publicly accessible yet contain an incomplete article. Reject it when a required
    // explicitly numbered paragraph is absent, instead of letting a reference answer fill that gap.
    if (bodyMarkers.size) for (const reference of questionSection.matchAll(/第\s*[（(]?([①-⑳]|\d{1,2})[）)]?\s*(?:自然)?[段节]/g)) {
        const marker = /^\d+$/.test(reference[1]!) ? circles[Number(reference[1]) - 1] : reference[1];
        if (marker && !bodyMarkers.has(marker)) throw new Error("Question refers to a missing source paragraph");
    }
    const id = `reading-${readingHash(normalize([...headings, ...paragraphs].join("\n"))).slice(0, 16)}`;
    const answers = new Map<number, string>();
    for (let index = 0; index < answerNumbers.length; index++) {
        const match = answerNumbers[index]!;
        answers.set(Number(match[1]), answerText.slice(match.index! + match[0].length, answerNumbers[index + 1]?.index).trim());
    }
    const questions: ReadingQuestion[] = [];
    const questionNumbers = numbers.filter(match => match.index! >= first.index!);
    for (let index = 0; index < questionNumbers.length; index++) {
        const match = questionNumbers[index]!, number = Number(match[1]);
        const block = questionText.slice(match.index! + match[0].length, questionNumbers[index + 1]?.index).trim();
        const reference = answers.get(number);
        if (!reference || block.length < 5 || /^[（(【\s]*(?:略|答案略|参考答案略|见解析)[）)】。\s]*$/.test(reference) ||
            /&[a-z]+;/i.test(reference) || /下图|如下图|图示|图中|下表|下面方框/.test(block)) continue;
        const { question: stem, options } = readingOptionParts(block);
        const choice = reference.replace(/^[（(]\d+分[）)]\s*/, "").match(/^\s*([A-F](?:[、，,\s]*[A-F])*)(?:[\s.．、（(]|$)/)?.[1]?.replace(/[^A-F]/g, "");
        if (options.length && (!choice || [...choice].some(letter => "ABCDEF".indexOf(letter) >= options.length)) ||
            !options.length && /^[A-F](?:[、，,\s]*[A-F])*$/.test(reference)) continue;
        questions.push({ id: `${id}-q${number}`, passageId: id, number, question: stem, options,
            type: options.length ? choice!.length > 1 ? "multiple-choice" : "single-choice" : "open",
            answer: options.length ? [...new Set(choice)].sort().join("") : reference, category: category(stem) });
    }
    if (!questions.length || new Set(questions.map(question => question.number)).size !== questions.length ||
        questionNumbers.filter(match => answers.has(Number(match[1]))).length < Math.ceil(questionNumbers.length / 2)) throw new Error("No unambiguous matched question/answer numbering");
    return { passage: { id, title: page.title, headings, paragraphs, source: { urls: page.questionUrls, answerUrls: page.answerUrls, sha256: page.questionHash,
        publisher: "中考网公开阅读训练", stage: "junior-exam-preparation" } }, questions };
}
