import type { AgentResult, AgentResultProcessor, AgentRuntime } from "../agent/contracts.js";
import type { EnglishTask } from "./contracts.js";
import { englishConclusions } from "./agent.js";
import { visibleAnswer } from "../agent/visible-answer.js";

export type EnglishWorkflow = "direct" | "grounded";
export const ENGLISH_RESPONSE_FINAL = "逐题作答：先联系原文前后句说明依据，再选择字母并核对该字母对应的选项与解释一致。NOT/EXCEPT题选择不符合原文的选项，主旨题覆盖全文，all/both选项逐项验证，数量题注意单位和次数。每题只在末尾单独输出一次‘第n题答案：A’，不要再重复整组答案。";

/** Canonicalize repeated IDENTICAL conclusions only; conflicting or missing choices are never guessed. */
export function canonicalEnglishResponse(content: string, task: EnglishTask): string | undefined {
    const visible = visibleAnswer(content).replace(/\*\*|__/g, "");
    const answers = task.questions.map(q => ({ number: q.number, choices: englishConclusions(visible, q.number),
        labels: [...visible.matchAll(new RegExp(`(?:^|[\\n。！？!?；;])\\s*(?:第\\s*${q.number}\\s*题\\s*答案|(?:Question|Q)\\s*${q.number}\\s*(?:Answer)?)[：:]`, "gi"))].length }));
    if (answers.some(a => !a.choices.length || a.labels !== a.choices.length || new Set(a.choices).size !== 1)) return undefined;
    let explanation = visible;
    for (const a of answers) explanation = explanation.replace(new RegExp(`((?:^|[\\n。！？!?；;])\\s*)(?:第\\s*${a.number}\\s*题\\s*答案|(?:Question|Q)\\s*${a.number}\\s*(?:Answer)?)[：:]\\s*[A-D](?=[\\s。.*]|$)`, "gi"), "$1");
    return explanation.trim() + "\n\n" + answers.map(a => `第${a.number}题答案：${a.choices[0]}`).join("\n");
}
/** Generic harness extension: output integrity, distinct from the unconfigured English semantic reviewer. */
export class EnglishResponseProcessor implements AgentResultProcessor {
    constructor(private readonly task: EnglishTask) {}
    async process(result: AgentResult, runtime: AgentRuntime, _context: unknown, signal?: AbortSignal): Promise<AgentResult> {
        let content = result.content;
        for (let attempt = 0; attempt <= 1; attempt++) {
            signal?.throwIfAborted();
            const canonical = canonicalEnglishResponse(content, this.task);
            if (canonical) {
                runtime.event("english.response.validated", { repaired: attempt > 0, questions: this.task.questions.length });
                return { ...result, content: canonical };
            }
            runtime.event("english.response.invalid", { attempt, code: "MISSING_OR_CONFLICTING_CHOICE" });
            if (attempt || result.modelTurns >= runtime.maxToolSteps + 1) break;
            const messages = await runtime.prepare([], true, signal);
            const turn = await runtime.complete([...messages, { role: "system", content: "上次输出有遗漏或冲突的答案。重新依据原文和当前四个选项回答所有题，每题只有一个明确的最终结论，格式：第n题答案：A。材料不足则说明缺失条件。" }], [], signal);
            content = turn.content;
        }
        runtime.event("english.response.unavailable", { reason: "invalid_after_bounded_repair" });
        return { ...result, content: "本次英语答案存在遗漏或冲突，暂不能提供可靠答案，请重试。" };
    }
}
