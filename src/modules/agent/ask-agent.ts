import type { AgentResult, AgentRuntime, AgentWorkflow, ToolRound } from "./contracts.js";
import { toolRound } from "./contracts.js";

/**
 * agent 的默认实现，负责决策和终止逻辑。
 * 具体的工作流为 上下文 -> 工具调用 -> 观察结果 -> 决策 -> 终止。
 * harness 负责上下文管理、工具提供和执行。
 */
export class AskAgent implements AgentWorkflow {
    async run(runtime: AgentRuntime, signal?: AbortSignal): Promise<AgentResult> {
        const rounds: ToolRound[] = [];
        let toolCalls = 0;
        for (let step = 0; step <= runtime.maxToolSteps; step++) {
            signal?.throwIfAborted();
            const final = step === runtime.maxToolSteps;
            runtime.event("agent.phase", { phase: final ? "answer" : "research", step });
            const messages = await runtime.prepare(rounds, final, signal);
            const turn = await runtime.complete(messages, final ? [] : runtime.tools, signal);
            signal?.throwIfAborted();
            // Runtime guarantees protocol validity and execution limits.
            if (!turn.toolCalls.length) {
                return { content: turn.content, modelTurns: step + 1, toolCalls };
            }
            const round = toolRound(turn, await runtime.executeBatch(turn.toolCalls, signal));
            toolCalls += round.results.length;
            // 记录每个回合的执行结果，包括工具调用的输出和状态，准备进入下一轮。
            rounds.push(round);
            runtime.event("agent.phase", { phase: "observe", step, toolCalls: round.results.length });
        }
        throw new Error("Agent failed to terminate");
    }
}
