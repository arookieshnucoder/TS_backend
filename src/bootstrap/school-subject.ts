import { isReadingRequest } from "../modules/reading/library.js";
import { isEnglishRequest } from "../modules/english/library.js";
import type { SchoolSubject } from "../modules/subjects/contracts.js";
export type { SchoolSubject } from "../modules/subjects/contracts.js";
type SubjectMessage = { role: string; content: string; subject?: SchoolSubject };

/** Legacy messages may contain a mode label added by the old UI, rather than by the user. */
function legacySubject(content: string): SchoolSubject | undefined {
    const body = content.replace(/^(?:\s*(?:\[(?:数学|语文(?:阅读)?|英语)\]|【(?:数学|语文(?:阅读)?|英语)】))+/u, "").trim();
    // Inspect the actual task before falling back to obsolete interface labels.
    if (/解方程|二次函数|抛物线|概率|三角形|求.*(?:根|面积|体积|最小值|最大值)|[a-z][²^]|\d\s*[+*/=]\s*\d/i.test(body) ||
        /\b(?:solve|factor|calculate)\b[\s\S]{0,80}\b(?:equation|polynomial|probability|area|volume|perimeter)\b|\bfind\b[\s\S]{0,80}\b(?:roots?|area|volume|perimeter|probability)\b/i.test(body)) return "math";
    if (isEnglishRequest(body)) return "english";
    if (isReadingRequest(body) || /古诗(?:词)?|诗词|诗歌|唐诗|宋词|文言文|古文|修辞|比喻|拟人|赏析|汉字|病句|成语|字音|字形|思想感情|表达效果/.test(body)) return "chinese";
    if (/\[数学\]|【数学】/.test(content)) return "math";
    if (/\[语文(?:阅读|题)?(?:[：:].*)?\]|【语文(?:阅读)?】/.test(content)) return "chinese";
    if (isEnglishRequest(content)) return "english";
    return undefined;
}

/** Only replay old history heuristically; current requests use the independent classifier. */
export function routeSchoolSubject(current: string, history: readonly SubjectMessage[]): SchoolSubject {
    const currentSubject = legacySubject(current);
    if (currentSubject) return currentSubject;
    for (const message of [...history].reverse()) {
        if (message.subject) return message.subject;
        if (message.role === "user") {
            const previousSubject = legacySubject(message.content);
            if (previousSubject) return previousSubject;
        }
    }
    return "math";
}
/** 只保留目标学科的原始消息及追问，避免把另一学科的文章或助手答案带入本轮。 */
export function subjectHistory<T extends SubjectMessage>(history: readonly T[], subject: SchoolSubject): T[] {
    const retained: T[] = [];
    let active: SchoolSubject = "math";
    for (const message of history) {
        if (message.subject) active = message.subject;
        else if (message.role === "user") active = legacySubject(message.content) ?? active;
        if (active === subject) retained.push(message);
    }
    return retained;
}
