import type { AgentResult, AgentRuntime, AgentWorkflow, ToolRound } from "./contracts.js";

/** Owns decisions/termination; the harness owns context, providers and execution. */
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
      if (!turn || typeof turn.content !== "string" || !Array.isArray(turn.toolCalls)) throw new Error("Invalid agent turn");
      if (!turn.toolCalls.length) {
        if (!turn.content.trim()) throw new Error("Empty agent answer");
        return { content: turn.content, modelTurns: step + 1, toolCalls };
      }
      if (final || turn.toolCalls.length > runtime.maxCallsPerStep) throw new Error("Agent tool step limit exceeded");
      // Validate the entire batch before executing anything. IDs are unique across this run.
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
      rounds.push(round);
      runtime.event("agent.phase", { phase: "observe", step, toolCalls: round.results.length });
    }
    throw new Error("Agent failed to terminate");
  }
}
