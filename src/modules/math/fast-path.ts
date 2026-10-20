import { calculate } from "./arithmetic.js";

/** Only a complete, unambiguous two-number expression; prose/conditions use the full workflow. */
export function elementaryArithmetic(question: string): { expression: string; value: number } | undefined {
    const text = question.trim().replace(/^\[数学\]\s*/, "");
    const match = text.match(/^(?:请\s*)?(?:(?:计算|算一下|算一算|求值)\s*)?([+-]?\d{1,9}\s*[+\-×*÷/]\s*[+-]?\d{1,9})(?:\s*(?:等于多少|是多少|等于|=))?[?？\s，,。]*(?:(?:写出(?:结果|答案)(?:和一句验算)?|并验算)[。！!\s]*)?$/);
    if (!match) return undefined;
    const expression = match[1]!.replace(/×/g, "*").replace(/÷/g, "/");
    try {
        const value = calculate(expression);
        if (!Number.isSafeInteger(value)) return undefined;
        return { expression, value };
    } catch { return undefined; }
}
