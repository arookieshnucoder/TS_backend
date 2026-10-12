import type { AgentModel } from "../agent/model.js";
import type { AgentInstructions, AgentMessage, AgentResult, AgentWorkflow } from "../agent/contracts.js";
import type { Logger } from "../../common/logging/logger.js";
import type { ContextConfig } from "./context/config.js";
import { TokenBudget } from "./context/tokens.js";
import { ContextCompressor } from "./context/services.js";
import { ContextBuilder } from "./context-builder.js";
import { ToolRegistry } from "./tool-registry.js";
import type { RegisteredTool } from "./tool-contracts.js";
import { abortable } from "./cancellation.js";
import { RecoveringModel, recoveryPolicy, type RecoveryPolicy, type NamedAgentModel } from "./recovery.js";
import { redact } from "../../common/logging/redaction.js";
import { selectTools } from "./tool-selection.js";
import { HarnessRuntime, HarnessPolicyError } from "./runtime.js";
import type { TextCompressor } from "./context/contracts.js";

export interface HarnessOptions {
    recovery?: Partial<RecoveryPolicy>;
    fallbackModels?: NamedAgentModel[];
    maxCallsPerStep?: number;
    toolTimeoutMs?: number;
    toolOutputTokens?: number;
}
export interface HarnessToolContext { compression: TextCompressor; }
export type HarnessToolFactory = (context: HarnessToolContext, signal?: AbortSignal) => Promise<RegisteredTool[]>;
export interface HarnessInput {
    onEvent?(name: string, fields?: Record<string, unknown>): void;
    history: AgentMessage[];
    question: string;
    tools: RegisteredTool[] | HarnessToolFactory;
    metadata: Record<string, unknown>;
}
export interface HarnessRunner {
    run(input: HarnessInput, signal?: AbortSignal): Promise<AgentResult>;
}
/**
 * Production runtime: context, execution policy, recovery, cancellation and telemetry.
 * Workflow owns the decision loop; runtime policy applies to every workflow.
 */
export class AgentHarness implements HarnessRunner {
    private readonly tokens: TokenBudget;
    private readonly recovery: RecoveryPolicy;
    private readonly options: Required<Omit<HarnessOptions, "recovery">>;
    constructor(private readonly model: AgentModel, private readonly workflow: AgentWorkflow,
        private readonly instructions: AgentInstructions, private readonly config: ContextConfig,
        private readonly logger: Logger, options: HarnessOptions = {}) {
        if (typeof model?.turn !== "function") throw new TypeError("AgentModel must implement turn");
        if (typeof workflow?.run !== "function") throw new TypeError("AgentWorkflow must implement run");
        if (Object.hasOwn(options, "fallbackModels") && !Array.isArray(options.fallbackModels)) throw new TypeError("fallbackModels must be an array");
        const { fallbackModels = [], maxCallsPerStep = 4, toolTimeoutMs = 15000, toolOutputTokens = 2048 } = options;
        if (fallbackModels.some(m => !m.name.trim() || m.name.length > 100 || typeof m.model?.turn !== "function")) throw new TypeError("Invalid fallback model");
        this.options = { fallbackModels: fallbackModels.map(({ name, model }) => ({ name, model })), maxCallsPerStep, toolTimeoutMs, toolOutputTokens };
        this.tokens = new TokenBudget(config);
        this.recovery = recoveryPolicy(options.recovery);
    }
    async run(input: HarnessInput, signal?: AbortSignal): Promise<AgentResult> {
        const started = Date.now();
        const metadata = { ...input.metadata };
        const event = (name: string, fields: Record<string, unknown> = {}) => {
            // Content previews are persisted through the run recorder, not emitted to stdout.
            const metrics = Object.fromEntries(Object.entries(fields).filter(([key]) => !["arguments", "result", "content", "calls", "question"].includes(key)));
            this.logger.info(name, redact({ ...metadata, ...metrics }) as Record<string, unknown>);
            try { input.onEvent?.(name, fields); } catch { this.logger.error("trace.observer_failed", { runId: metadata.runId }); }
        };
        event("agent.started");
        try {
            return await abortable(async () => {
                const model = new RecoveringModel(this.model, this.options.fallbackModels, this.recovery, event);
                const compression = new ContextCompressor(model, this.tokens, this.config);
                const tools = typeof input.tools === "function" ? await input.tools({ compression }, signal) : input.tools;
                signal?.throwIfAborted();
                const builder = new ContextBuilder(structuredClone(input.history), input.question, this.config,
                    this.tokens, compression, event, this.instructions);
                const registry = new ToolRegistry(this.tokens, this.options.toolOutputTokens, this.options.toolTimeoutMs, event, this.recovery);
                const selection = selectTools(tools, input.question, this.instructions, this.config, this.tokens);
                for (const tool of selection.tools) registry.register(tool);
                if (selection.omitted) event("agent.tools.selected", { included: selection.tools.length, omittedMcpTools: selection.omitted, mcpBudgetTokens: selection.budgetTokens, reason: "context_budget" });
                const runtime = new HarnessRuntime(model, builder, registry, this.config.maxToolSteps, this.options.maxCallsPerStep,
                    this.config.maxInputTokens, event, signal);
                const result = await this.workflow.run(runtime, signal);
                event("agent.completed", { modelTurns: result.modelTurns, toolCalls: result.toolCalls, durationMs: Date.now() - started });
                return result;
            }, signal);
        } catch (error) {
            event("agent.failed", { cancelled: signal?.aborted ?? false, durationMs: Date.now() - started,
                ...(error instanceof HarnessPolicyError ? { code: error.code } : {}) });
            throw error;
        }
    }
}
