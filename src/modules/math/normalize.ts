/** Preserve arithmetic signs, inequalities, exponents and numbers. Never strip them for exact matching. */
export function normalizeMath(text: string): string {
    const superscript: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-", "⁺": "+" };
    const subscript: Record<string, string> = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9" };
    // NFKC alone changes x² to x2, changing the equation. Preserve powers and subscripts first.
    const preserved = text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, s => `^{${[...s].map(c => superscript[c]).join("")}}`)
        .replace(/[₀₁₂₃₄₅₆₇₈₉]+/g, s => `_{${[...s].map(c => subscript[c]).join("")}}`);
    return preserved.normalize("NFKC").replace(/\r\n/g, "\n").replace(/[−﹣]/g, "-")
        .replace(/\\(?:dfrac|tfrac)/g, "\\frac").replace(/\\(?:leqslant|leq)/g, "≤")
        .replace(/\\(?:geqslant|geq)/g, "≥").replace(/\\lt\b/g, "<").replace(/\\gt\b/g, ">")
        .replace(/\\(?:left|right)\b/g, "").replace(/\$/g, "").replace(/\s+/g, " ").trim();
}
export function tokens(text: string): string[] {
    const value = normalizeMath(text).toLowerCase();
    const words = value.match(/[a-z]+|\d+(?:\.\d+)?|[+\-*/=<>≤≥^]|[\p{Script=Han}]+/gu) ?? [];
    return words.flatMap(word => /\p{Script=Han}/u.test(word) ? [...word, ...Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2))] : [word]);
}
const concepts: [string, RegExp, string][] = [
    ["quadratic", /二次|抛物线|x\^\{?2\}?/, "一元二次方程 二次函数 判别式 配方 韦达定理 顶点 对称轴"],
    ["fraction", /分式|\\frac|分母/, "分式 有意义 分母不为零 通分 约分 增根"],
    ["radical", /根式|平方根|\\sqrt/, "二次根式 非负 算术平方根 绝对值"],
    ["statistics", /众数|中位数|方差|统计|调查|抽样/, "统计 数据 平均数 中位数 众数 样本"],
    ["probability", /概率|摸|抽签|可能性|硬币/, "概率 等可能事件 放回 不放回 树状图 列表"],
    ["geometry", /三角形|triangle|圆|矩形|菱形|面积|相似|∠/, "几何 相似三角形 勾股定理 三角函数 圆 面积"],
    ["inequality", /不等式|解集|取值范围/, "不等式 端点 定义域 数轴 交集"],
    ["modeling", /工程|航|增长|工人|加工|每组|苹果/, "应用题 列方程 单位 等量关系 设未知数"],
    ["power", /幂|单项式|运算|相反数|科学记数|科学计数/, "实数 整式 运算 同类项 幂 科学记数法"],
];
export function expandQuery(query: string) {
    const matches = concepts.filter(([, pattern]) => pattern.test(query));
    return { concepts: matches.map(([name]) => name), text: `${normalizeMath(query)} ${matches.map(([, , expansion]) => expansion).join(" ")}` };
}
