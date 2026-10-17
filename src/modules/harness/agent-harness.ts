import type { AgentModel } from "../agent/model.js";
import type { AgentInstructions, AgentMessage, AgentResult, AgentResultProcessor, AgentWorkflow, ToolCall } from "../agent/contracts.js";
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
import { prepareRun } from "./run-preparation.js";
import { toolDiscovery } from "./tool-discovery.js";
import { SubAgentSession, type SubAgentDefinition, type SubAgentScope, type DelegationLimits } from "./subagents.js";

export interface HarnessOptions {
    subAgents?: SubAgentDefinition[];
    delegation?: Partial<DelegationLimits>;
    resultProcessors?: AgentResultProcessor[];
    recovery?: Partial<RecoveryPolicy>;
    fallbackModels?: NamedAgentModel[];
    maxCallsPerStep?: number;
    toolTimeoutMs?: number;
    toolOutputTokens?: number;
    /** 本轮协议纠错总数，0 保留原来的严格失败行为；不重放工具。 */
    maxProtocolRepairs?: number;
    /** 初始 MCP 目录与每次发现的上限，原生业务工具不被裁掉。 */
    maxMcpTools?: number;
}
export interface HarnessToolContext { compression: TextCompressor; }
export type HarnessToolFactory = (context: HarnessToolContext, signal?: AbortSignal) => Promise<RegisteredTool[]>;
export interface HarnessInput {
    onEvent?(name: string, fields?: Record<string, unknown>): void;
    history: AgentMessage[];
    question: string;
    tools: RegisteredTool[] | HarnessToolFactory;
    metadata: Record<string, unknown>;
    /** Experimental profiles can disable this for a fair architecture comparison. */
    historyPolicy?: "full" | "evidence";
    proactiveTools?: boolean;
    initialCalls?: ToolCall[];
}
// 这里构建的是通用的 harness 架构
export interface HarnessRunner {
    run(input: HarnessInput, signal?: AbortSignal): Promise<AgentResult>;
}
/**
 * Production runtime: context, execution policy, recovery, cancellation and telemetry.
 * Workflow owns the decision loop; runtime policy applies to every workflow.
 */
export class AgentHarness implements HarnessRunner {
    // agent harness 的核心组件：token 预算、恢复策略和选项配置
    private readonly tokens: TokenBudget; // 限制 token 使用, 贫穷友好
    private readonly recovery: RecoveryPolicy; // 恢复策略
    private readonly options: Required<Omit<HarnessOptions, "recovery">>;
    constructor(private readonly model: AgentModel, private readonly workflow: AgentWorkflow,
        private readonly instructions: AgentInstructions, private readonly config: ContextConfig,
        private readonly logger: Logger, options: HarnessOptions = {}) {
        if (typeof model?.turn !== "function") throw new TypeError("AgentModel must implement turn");
        if (typeof workflow?.run !== "function") throw new TypeError("AgentWorkflow must implement run");
        if (Object.hasOwn(options, "fallbackModels") && !Array.isArray(options.fallbackModels)) throw new TypeError("fallbackModels must be an array");
        const { fallbackModels = [], maxCallsPerStep = 4, toolTimeoutMs = 15000, toolOutputTokens = 2048, maxProtocolRepairs = 0, maxMcpTools = 64 } = options;
        if (fallbackModels.some(m => !m.name.trim() || m.name.length > 100 || typeof m.model?.turn !== "function")) throw new TypeError("Invalid fallback model");
        for (const [name, value, min, max] of [["maxCallsPerStep", maxCallsPerStep, 1, 8], ["toolTimeoutMs", toolTimeoutMs, 1, 120000],
            ["toolOutputTokens", toolOutputTokens, 128, 8192], ["maxProtocolRepairs", maxProtocolRepairs, 0, 3], ["maxMcpTools", maxMcpTools, 1, 64]] as const) {
            if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`Invalid harness ${name}`);
        }
        // Validate before starting work; each run receives fresh shared delegation budgets.
        new SubAgentSession(options.subAgents, options.delegation);
        if (options.resultProcessors?.some(processor => typeof processor?.process !== "function")) throw new TypeError("Invalid result processor");
        this.options = { fallbackModels: fallbackModels.map(({ name, model }) => ({ name, model })), maxCallsPerStep, toolTimeoutMs, toolOutputTokens, maxProtocolRepairs, maxMcpTools,
            subAgents: [...(options.subAgents ?? [])], delegation: { ...options.delegation }, resultProcessors: [...(options.resultProcessors ?? [])] };
        this.tokens = new TokenBudget(config);
        this.recovery = recoveryPolicy(options.recovery);
    }
    async run(input: HarnessInput, signal?: AbortSignal): Promise<AgentResult> {
        const session = new SubAgentSession(this.options.subAgents, this.options.delegation);
        return this.runScoped(input, signal, session, { depth: 0, allowed: [...session.definitions.keys()] });
    }
    private async runScoped(input: HarnessInput, inheritedSignal: AbortSignal | undefined, session: SubAgentSession, scope: SubAgentScope): Promise<AgentResult> {
        const lifetime = new AbortController();
        const signal = inheritedSignal ? AbortSignal.any([inheritedSignal, lifetime.signal]) : lifetime.signal;
        const started = Date.now();
        const metadata = { ...input.metadata };
        const event = (name: string, fields: Record<string, unknown> = {}) => {
            // Content previews are persisted through the run recorder, not emitted to stdout.
            const metrics = Object.fromEntries(Object.entries(fields).filter(([key]) => !["arguments", "result", "content", "calls", "question"].includes(key)));
            this.logger.info(name, redact({ ...metadata, ...metrics }) as Record<string, unknown>);
            try { input.onEvent?.(name, fields); } catch { this.logger.error("trace.observer_failed", { runId: metadata.runId }); }
        };
        event("agent.started");
        let runtime: HarnessRuntime | undefined;
        try {
            return await abortable(async () => {
                const model = new RecoveringModel(this.model, this.options.fallbackModels, this.recovery, event);
                const compression = new ContextCompressor(model, this.tokens, this.config);
                const supplied = typeof input.tools === "function" ? await input.tools({ compression }, signal) : input.tools;
                signal?.throwIfAborted();
                const { tools, history, prefetchHistory } = prepareRun(input, supplied, this.config, this.tokens, event);
                const builder = new ContextBuilder(history, input.question, this.config,
                    this.tokens, compression, event, this.instructions);
                const registry = new ToolRegistry(this.tokens, this.options.toolOutputTokens, this.options.toolTimeoutMs, event, this.recovery);
                // 发现工具自身也占上下文预算；有 MCP 时先把定义纳入筛选的固定开销。
                if (tools.some(tool => tool.source?.type === "mcp") && !tools.some(tool => tool.definition.name === "tool_search")) {
                    tools.push(toolDiscovery(tools, registry, this.instructions, this.config, this.tokens, this.options.maxMcpTools, input.question));
                }
                const selection = selectTools(tools, input.question, this.instructions, this.config, this.tokens, { limit: this.options.maxMcpTools });
                for (const tool of selection.tools) registry.register(tool);
                if (selection.omitted) event("agent.tools.selected", { included: selection.tools.length, omittedMcpTools: selection.omitted, mcpBudgetTokens: selection.budgetTokens, reason: "context_budget" });
                runtime = new HarnessRuntime(model, builder, registry, this.config.maxToolSteps, this.options.maxCallsPerStep,
                    this.config.maxInputTokens, event, signal, this.options.maxProtocolRepairs,
                    scope.allowed.map(name => ({ name, description: session.definitions.get(name)!.description })),
                    (task, childSignal) => session.run(task, scope, childSignal, event, async (definition, request, childScope, operation) => {
                        const child = new AgentHarness(definition.model, definition.workflow, definition.instructions, definition.context ?? this.config,
                            { info() {}, error() {} }, { ...this.options, fallbackModels: [], resultProcessors: [] });
                        return child.runScoped({ question: request.input, history: request.context ?? [], tools: definition.tools ?? [],
                            proactiveTools: false, metadata: { ...metadata, taskId: childScope.taskId, parentTaskId: scope.taskId ?? null, agent: definition.name },
                            onEvent: (name, fields) => name.startsWith("agent.subagent.") ? event(name, fields) :
                                event("agent.subagent.event", { ...fields, event: name, taskId: childScope.taskId, parentTaskId: scope.taskId ?? null, agent: definition.name }),
                        }, operation, session, childScope);
                    }));
                // Acquire historical facts before the first model turn, avoiding lengthy unguided reasoning.
                if (prefetchHistory && runtime.tools.some(tool => tool.name === "history_lookup")) {
                    await runtime.prefetch([{ id: "harness-history-1", name: "history_lookup", arguments: { query: input.question } }], "检索历史原文和最新条件。", signal);
                }
                if (input.initialCalls?.length) await runtime.prefetch(input.initialCalls, "先获取题目证据和条件检查。", signal);
                if (input.proactiveTools !== false && !input.initialCalls?.length && input.question.length > 1000 &&
                    /方程|抛物线|三角形|概率|x[²^]/.test(input.question) && runtime.tools.some(tool => tool.name === "math_analyze")) {
                    await runtime.prefetch([{ id: "harness-analyze-1", name: "math_analyze", arguments: { query: input.question } }], "先提取长问题的条件和可执行检查。", signal);
                }
                let returned = await this.workflow.run(runtime, signal);
                signal?.throwIfAborted();
                for (const processor of this.options.resultProcessors) {
                    signal?.throwIfAborted();
                    returned = await processor.process(returned, runtime, { question: input.question, history: input.history }, signal);
                }
                signal?.throwIfAborted();
                const result = { ...returned, modelTurns: runtime.modelInvocationCount, toolCalls: runtime.executedToolCount };
                event("agent.completed", { modelTurns: result.modelTurns, toolCalls: result.toolCalls, durationMs: Date.now() - started });
                return result;
            }, signal);
        } catch (error) {
            event("agent.failed", { cancelled: signal?.aborted ?? false, durationMs: Date.now() - started,
                ...(error instanceof HarnessPolicyError ? { code: error.code } : {}) });
            throw error;
        } finally {
            scope.usage = { modelTurns: runtime?.modelInvocationCount ?? 0, toolCalls: runtime?.executedToolCount ?? 0 };
            lifetime.abort();
        }
    }
}
