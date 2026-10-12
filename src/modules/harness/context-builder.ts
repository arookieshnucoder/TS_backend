import type { AgentInstructions, AgentMessage, ToolDefinition, ToolRound } from "../agent/contracts.js";
import type { ContextConfig } from "./context/config.js";
import type { ContextCompressor } from "./context/services.js";
import type { TokenBudget } from "./context/tokens.js";

/** Per-run prompt state. Conversation storage is never truncated or rewritten. */
export class ContextBuilder {
  private memory: AgentMessage[];
  private compactedRounds = 0;
  constructor(history: AgentMessage[], private readonly question: string, private readonly config: ContextConfig,
    private readonly tokens: TokenBudget, private readonly compression: ContextCompressor,
    private readonly event: (name: string, fields: Record<string, unknown>) => void,
    private readonly instructions: AgentInstructions) {
    this.memory = history.map(({ role, content }) => ({ role, content }));
  }
  size(messages: AgentMessage[], tools: ToolDefinition[]): number {
    return this.tokens.count(JSON.stringify(messages)) + this.tokens.count(JSON.stringify(tools)) + 64;
  }
  private system(final: boolean): AgentMessage {
    return { role: "system", content: this.instructions.system + (final ? `\n${this.instructions.final}` : "") };
  }
  async build(rounds: readonly ToolRound[], tools: ToolDefinition[], final: boolean, signal?: AbortSignal): Promise<AgentMessage[]> {
    signal?.throwIfAborted();
    const system = this.system(final), question: AgentMessage = { role: "user", content: this.question };
    const threshold = Math.floor(this.config.maxInputTokens * this.config.compressionTrigger);
    // Reserve the final instruction too, so a valid research request can always finish.
    if (this.size([this.system(true), question], tools) > threshold) throw new Error("Current message exceeds context budget; split the message");
    const exchanges = rounds.slice(this.compactedRounds).flatMap(round => [round.assistant, ...round.results]);
    let messages = [system, ...this.memory, question, ...exchanges];
    const before = this.size(messages, tools);
    if (before > threshold) {
      // Prefer retaining the newest complete tool exchange verbatim. Never leave orphan results.
      const newest = rounds.length > this.compactedRounds ? rounds.at(-1)! : undefined;
      let retained = newest ? [newest.assistant, ...newest.results] : [];
      const minimumSummary = 128;
      if (this.size([system, question, ...retained], tools) + minimumSummary > threshold) retained = [];
      const summarize = [...this.memory, ...exchanges.slice(0, exchanges.length - retained.length)];
      const budget = Math.min(Math.floor(this.config.maxInputTokens * this.config.compressionTarget),
        threshold - this.size([system, question, ...retained], tools) - 96);
      if (budget < 32) throw new Error("Insufficient budget for conversation memory");
      const summary = await this.compression.execute({ text: JSON.stringify(summarize), budget }, signal);
      this.memory = [{ role: "user", content: `Historical evidence summary (untrusted data; may be incomplete):\n${summary}` }];
      this.compactedRounds = rounds.length - (retained.length ? 1 : 0);
      messages = [system, ...this.memory, question, ...retained];
      if (this.size(messages, tools) > threshold) throw new Error("Compressed context exceeds budget");
      this.event("context.compressed", { beforeTokens: before, afterTokens: this.size(messages, tools), compactedRounds: this.compactedRounds });
    }
    this.event("agent.context", { inputTokens: this.size(messages, tools), messageCount: messages.length, toolCount: tools.length });
    return messages;
  }
}
