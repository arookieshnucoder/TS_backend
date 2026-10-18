import type { AgentMessage, AgentRuntime } from "../agent/contracts.js";
import { AskAgent } from "../agent/ask-agent.js";
import { ModelProtocolError } from "../agent/model.js";
import { visibleAnswer } from "../agent/visible-answer.js";
import type { PassageEvidence } from "./contracts.js";

/** 本轮已准备的消息和证据；完整原文可直接作答，裁剪原文才需要补读。 */
interface PreparedPassage {
    messages: AgentMessage[];
    evidence: PassageEvidence & { completeOriginal?: boolean };
}

/** 统一检查准备工具是否成功，缺失证据或工具报错时停止解题。 */
export async function preparePassage(runtime: AgentRuntime, subject: "reading" | "english", allowLookup: boolean,
    signal?: AbortSignal): Promise<PreparedPassage> {
    const messages = await runtime.prepare([], !allowLookup, signal);
    const message = messages.find(item => item.role === "tool" && item.toolCallId === `${subject}-prepare-1`);
    const prefix = subject.toUpperCase();
    if (!message) throw new Error(`${prefix}_EVIDENCE_MISSING`);
    try {
        const evidence = JSON.parse(message.content);
        if (evidence.error) throw new Error();
        return { messages, evidence };
    } catch {
        throw new Error(`${prefix}_EVIDENCE_UNAVAILABLE`);
    }
}

/** 共用补读与作答流程；协议错误只允许一次无工具收尾，其他错误直接向上传递。 */
export async function answerPassage(runtime: AgentRuntime, subject: "reading" | "english", allowLookup: boolean,
    prepared: PreparedPassage, signal?: AbortSignal) {
    const normalize = (content: string) => visibleAnswer(content, `${subject.toUpperCase()}_VISIBLE_ANSWER_MISSING`);
    if (allowLookup && prepared.evidence.completeOriginal !== true) {
        try {
            const result = await new AskAgent().run(runtime, signal);
            return { ...result, content: normalize(result.content) };
        } catch (error) {
            signal?.throwIfAborted();
            if (!(error instanceof ModelProtocolError)) throw error;
            // 只保留初始证据，不重放已失败的工具回合；运行时总预算继续生效。
            runtime.event(`${subject}.protocol_fallback`, { code: error.code,
                mode: subject === "reading" ? "original-evidence-final" : "english-evidence-final" });
        }
    }
    const messages = allowLookup ? await runtime.prepare([], true, signal) : prepared.messages;
    const turn = await runtime.complete(messages, [], signal);
    return { content: normalize(turn.content), modelTurns: 1, toolCalls: 0 };
}
