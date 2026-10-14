/** Read the student's explicit conclusion, independently of line wrapping or Markdown. */
import { normalizeQuestionLabels } from "../math/normalize.js";
export function conclusion(text:string):string|null {
    const plain=text.replace(/\*\*/g,"");
    const inline=[...plain.matchAll(/(?:最终答案|答案)\s*[：:]\s*([A-D]+)(?:\b|[。．.\s]|$)/g)].filter(m=>{
        const before=plain.slice(Math.max(0,m.index!-24),m.index!);return !/例题|参考|检索|(?:旧|原|原始|原解|候选)\s*$/.test(before);
    });
    if(inline.some(m=>new Set(m[1]).size!==1||/^\s*(?:或|和|、|\/|与|及|and\b|or\b)\s*[A-D]/i.test(plain.slice(m.index!+m[0].length))))return null;
    return inline.length&&new Set(inline.map(m=>m[1]![0])).size===1?inline[0]![1]![0]!:null;
}
export function conclusions(text:string,count:number):(string|null)[]{
    const plain=normalizeQuestionLabels(text.replace(/\*\*/g,""));if(count===1)return [conclusion(plain)];
    return Array.from({length:count},(_,i)=>{
        const matches=[...plain.matchAll(new RegExp(`第\\s*${i+1}\\s*题\\s*(?:最终)?答案\\s*[：:]\\s*([A-D])(?:\\b|[。．.\\s]|$)`,"g"))];
        if(matches.length)return new Set(matches.map(m=>m[1])).size===1?matches[0]![1]!:null;
        const sections=[...plain.matchAll(/(?:^|\n)\s*(?:#+\s*)?第\s*(\d+)\s*题[^\n]*\n/g)],same=sections.filter(m=>Number(m[1])===i+1);
        if(same.length!==1)return null;const section=same[0]!,next=sections.find(m=>m.index!>section.index!);return conclusion(plain.slice(section.index!,next?.index));
    });
}
