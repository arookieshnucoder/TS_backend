import { isReadingRequest } from "../modules/reading/library.js";
import { isEnglishRequest } from "../modules/english/library.js";
import type { SchoolSubject } from "../modules/subjects/contracts.js";
export type { SchoolSubject } from "../modules/subjects/contracts.js";
/** 优先识别当前显式学科，再识别题型；普通追问沿用最近的学科，初始默认数学。 */
export function routeSchoolSubject(current: string, history: readonly { role: string; content: string }[]): SchoolSubject {
    if (/\[数学\]|【数学】/.test(current)) return "math";
    if (/\[语文(?:题[：:].*)?\]|【语文】/.test(current)) return "chinese";
    if (isEnglishRequest(current)) return "english";
    if (isReadingRequest(current)) return "chinese";
    if (/解方程|二次函数|抛物线|概率|三角形|求.*(?:根|面积|体积|最小值|最大值)|[a-z][²^]|\d\s*[+*/=]\s*\d/i.test(current)) return "math";
    const previous = [...history].reverse().find(m => m.role === "user" && (isEnglishRequest(m.content) || isReadingRequest(m.content) || /\[数学\]|方程|函数|抛物线|三角形/.test(m.content)));
    return previous ? isEnglishRequest(previous.content) ? "english" : isReadingRequest(previous.content) ? "chinese" : "math" : "math";
}
/** 只保留目标学科的原始消息及追问，避免把另一学科的文章或助手答案带入本轮。 */
export function subjectHistory<T extends { role: string; content: string }>(history: readonly T[], subject: SchoolSubject): T[] {
    const retained: T[] = [], preceding: T[] = [];
    let active: SchoolSubject = "math";
    for (const message of history) {
        if (message.role === "user") active = routeSchoolSubject(message.content, preceding);
        if (active === subject) retained.push(message);
        preceding.push(message);
    }
    return retained;
}
