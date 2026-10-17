import type { AgentRuntime, AgentWorkflow } from "./contracts.js";

/** A small isolated worker. Hosts choose its model, instructions, and permitted capabilities. */
export class SingleTurnAgent implements AgentWorkflow {
    async run(runtime: AgentRuntime, signal?: AbortSignal) {
        const messages = await runtime.prepare([], true, signal);
        const turn = await runtime.complete(messages, [], signal);
        return { content: turn.content, modelTurns: 1, toolCalls: 0 };
    }
}
