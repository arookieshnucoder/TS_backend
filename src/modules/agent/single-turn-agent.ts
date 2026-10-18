import type { AgentRuntime, AgentWorkflow } from "./contracts.js";

/** 执行一次无工具模型调用，适合独立核验或单题求解等隔离任务。 */
export class SingleTurnAgent implements AgentWorkflow {
    async run(runtime: AgentRuntime, signal?: AbortSignal) {
        const messages = await runtime.prepare([], true, signal);
        const turn = await runtime.complete(messages, [], signal);
        return { content: turn.content, modelTurns: 1, toolCalls: 0 };
    }
}
