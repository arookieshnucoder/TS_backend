import type { AgentResult, AgentRuntime, AgentWorkflow, ToolRound } from "./contracts.js";

/**
 * agent 的默认实现，负责决策和终止逻辑。
 * 具体的工作流为 上下文 -> 工具调用 -> 观察结果 -> 决策 -> 终止。
 * harness 负责上下文管理、工具提供和执行。
 */
export class AskAgent implements AgentWorkflow {
    async run(runtime: AgentRuntime, signal?: AbortSignal): Promise<AgentResult> {
        const rounds: ToolRound[] = [];
        const ids = new Set<string>();
        let toolCalls = 0;
        for (let step = 0; step <= runtime.maxToolSteps; step++) {
            signal?.throwIfAborted();
            const final = step === runtime.maxToolSteps;
            runtime.event("agent.phase", { phase: final ? "answer" : "research", step });
            const messages = await runtime.prepare(rounds, final, signal);
            const turn = await runtime.complete(messages, final ? [] : runtime.tools, signal);
            signal?.throwIfAborted();
            // 回答是否为空或格式不正确
            if (!turn || typeof turn.content !== "string" || !Array.isArray(turn.toolCalls)) throw new Error("Invalid agent turn");
            // 如果没有工具调用以及回答不为空，说明代理直接给出了最终答案。
            if (!turn.toolCalls.length) {
                if (!turn.content.trim()) throw new Error("Empty agent answer");
                return { content: turn.content, modelTurns: step + 1, toolCalls };
            }
            if (final || turn.toolCalls.length > runtime.maxCallsPerStep) throw new Error("Agent tool step limit exceeded");
            // 验证每个工具调用的合法性，包括 ID 唯一性和工具是否可用。
            for (const call of turn.toolCalls) {
                if (!call || typeof call.id !== "string" || !call.id.trim() || call.id.length > 200) throw new Error("Missing or invalid tool call ID");
                if (ids.has(call.id)) throw new Error("Duplicate tool call IDs");
                ids.add(call.id);
                if (!runtime.tools.some(tool => tool.name === call.name)) throw new Error("Unknown or disabled tool");
            }
            const round: ToolRound = { assistant: { role: "assistant", content: turn.content, toolCalls: turn.toolCalls }, results: [] };
            for (const call of turn.toolCalls) {
                signal?.throwIfAborted();
                round.results.push(await runtime.execute(call, signal));
                toolCalls++;
            }
            // 记录每个回合的执行结果，包括工具调用的输出和状态，准备进入下一轮。
            rounds.push(round);
            runtime.event("agent.phase", { phase: "observe", step, toolCalls: round.results.length });
        }
        throw new Error("Agent failed to terminate");
    }
    // TODO: 可以增加更多的策略，当前的逻辑是回答不空且无工具调用时即终止。
}
