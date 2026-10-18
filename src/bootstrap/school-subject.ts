import { isReadingRequest } from "../modules/reading/library.js";
import { isEnglishRequest } from "../modules/english/library.js";
export type SchoolSubject = "math" | "chinese" | "english";
export function routeSchoolSubject(current: string, history: readonly { role: string; content: string }[]): SchoolSubject {
    if (/\[数学\]|【数学】/.test(current)) return "math";
    if (/\[语文(?:题[：:].*)?\]|【语文】/.test(current)) return "chinese";
    if (isEnglishRequest(current)) return "english";
    if (isReadingRequest(current)) return "chinese";
    if (/解方程|二次函数|抛物线|概率|三角形|求.*(?:根|面积|体积|最小值|最大值)|[a-z][²^]|\d\s*[+*/=]\s*\d/i.test(current)) return "math";
    const previous = [...history].reverse().find(m => m.role === "user" && (isEnglishRequest(m.content) || isReadingRequest(m.content) || /\[数学\]|方程|函数|抛物线|三角形/.test(m.content)));
    return previous ? isEnglishRequest(previous.content) ? "english" : isReadingRequest(previous.content) ? "chinese" : "math" : "math";
}
/** Keep original messages from the selected subject, including its follow-ups, without importing another workflow. */
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
