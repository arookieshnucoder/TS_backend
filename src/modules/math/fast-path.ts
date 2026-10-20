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

/** A complete ax+b=c with literal integer coefficients and an exact integer root. */
export function elementaryEquation(question: string): { expression: string; value: number } | undefined {
    const text = question.trim().replace(/^\[数学\]\s*/, "");
    const match = text.match(/^(?:请\s*)?解(?:一元一次)?方程\s*([+-]?\s*(?:\d{1,6}\s*\*?\s*)?)x\s*([+-]\s*\d{1,6})?\s*=\s*([+-]?\s*\d{1,6})\s*[，,。]?\s*(?:并验算|写出(?:计算|解题)?步骤(?:并验算)?)?[。！!\s]*$/i);
    if (!match) return undefined;
    const coefficient = match[1]!.replace(/[\s*]/g, "");
    const a = coefficient === "" || coefficient === "+" ? 1 : coefficient === "-" ? -1 : Number(coefficient);
    const b = Number((match[2] ?? "0").replace(/\s/g, "")), c = Number(match[3]!.replace(/\s/g, ""));
    if (!a || !Number.isSafeInteger((c - b) / a)) return undefined;
    const expression = `(${c}-(${b}))/(${a})`;
    return { expression, value: calculate(expression) };
}
