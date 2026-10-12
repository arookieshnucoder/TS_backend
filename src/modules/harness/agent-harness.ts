import type { AgentModel } from "../agent/model.js";
import type { AgentInstructions, AgentMessage, AgentResult, AgentWorkflow } from "../agent/contracts.js";
import type { Logger } from "../../common/logging/logger.js";
import type { ContextConfig } from "./context/config.js";
import { TokenBudget } from "./context/tokens.js";
import { ContextCompressor } from "./context/services.js";
import { ContextBuilder } from "./context-builder.js";
import { ToolRegistry, type RegisteredTool } from "./tool-registry.js";
import { abortable } from "./cancellation.js";

export interface HarnessOptions {
  maxCallsPerStep?: number;
  toolTimeoutMs?: number;
  toolOutputTokens?: number;
}
export interface HarnessInput {
  history: AgentMessage[];
  question: string;
  tools: RegisteredTool[];
  metadata: Record<string, unknown>;
}
export interface HarnessRunner {
  run(input: HarnessInput, signal?: AbortSignal): Promise<AgentResult>;
}

/** Request-local execution; application wiring supplies the workflow, instructions and tools. */
export class AgentHarness implements HarnessRunner {
  private readonly tokens: TokenBudget;
  private readonly compression: ContextCompressor;
  constructor(private readonly model: AgentModel, private readonly workflow: AgentWorkflow,
    private readonly instructions: AgentInstructions, private readonly config: ContextConfig,
    private readonly logger: Logger, private readonly options: HarnessOptions = {}) {
    if (typeof model?.turn !== "function") throw new TypeError("AgentModel must implement turn; legacy reply providers are unsupported");
    if (typeof workflow?.run !== "function") throw new TypeError("AgentWorkflow must implement run");
    this.tokens = new TokenBudget(config);
    this.compression = new ContextCompressor(model, this.tokens, config);
  }
  async run(input: HarnessInput, signal?: AbortSignal): Promise<AgentResult> {
    const started = Date.now();
    const metadata = { ...input.metadata };
    const event = (name: string, fields: Record<string, unknown> = {}) => this.logger.info(name, { ...metadata, ...fields });
    event("agent.started");
    try {
      return await abortable(async () => {
        const builder = new ContextBuilder(structuredClone(input.history), input.question, this.config,
          this.tokens, this.compression, event, this.instructions);
        const registry = new ToolRegistry(this.tokens, this.options.toolOutputTokens ?? 2048, this.options.toolTimeoutMs ?? 15000, event);
        for (const tool of input.tools) registry.register(tool);
        const scopedSignal = (operation?: AbortSignal) => signal && operation ? AbortSignal.any([signal, operation]) : signal ?? operation;
        const result = await this.workflow.run({
          tools: registry.definitions(), maxToolSteps: this.config.maxToolSteps, maxCallsPerStep: this.options.maxCallsPerStep ?? 4,
          prepare: (rounds, final, operation) => {
            const scope = scopedSignal(operation);
            return abortable(() => builder.build(rounds, final ? [] : registry.definitions(), final, scope), scope);
          },
          complete: (messages, tools, operation) => {
            const scope = scopedSignal(operation);
            return abortable(() => this.model.turn(messages, tools, scope), scope);
          },
          execute: (call, operation) => registry.execute(call, scopedSignal(operation)), event,
        }, signal);
        event("agent.completed", { modelTurns: result.modelTurns, toolCalls: result.toolCalls, durationMs: Date.now() - started });
        return result;
      }, signal);
    } catch (error) {
      event("agent.failed", { cancelled: signal?.aborted ?? false, durationMs: Date.now() - started });
      throw error;
    }
  }
}
