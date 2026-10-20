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
import type { SolutionSkillLibrary } from "./skills/library.js";
import { SKILL_AGENTS } from "./skills/contracts.js";
import { parseSkillMatch, skillMatchInput } from "./skills/matching.js";
import type { BackgroundWork } from "../chat/service/background-work.js";

/** 运行时策略选项，集中控制工具上限、恢复、子任务和答案后处理。 */
export interface HarnessOptions {
    /** Subject-scoped solution methods; child agents receive no library tools or learning privileges. */
    skills?: SolutionSkillLibrary;
    subAgents?: SubAgentDefinition[];
    delegation?: Partial<DelegationLimits>;
    resultProcessors?: AgentResultProcessor[];
    recovery?: Partial<RecoveryPolicy>;
    /** 仅在配置时显式提供；可重试错误耗尽主模型重试后才依次切换。 */
    fallbackModels?: NamedAgentModel[];
    maxCallsPerStep?: number;
    toolTimeoutMs?: number;
    toolOutputTokens?: number;
    /** 本轮协议纠错总数，0 保留原来的严格失败行为；不重放工具。 */
    maxProtocolRepairs?: number;
    /** 初始 MCP 目录与每次发现的上限，原生业务工具不被裁掉。 */
    maxMcpTools?: number;
}
/** 工具工厂可使用的运行时能力，目前提供受预算约束的文本压缩。 */
export interface HarnessToolContext { compression: TextCompressor; }
export type HarnessToolFactory = (context: HarnessToolContext, signal?: AbortSignal) => Promise<RegisteredTool[]>;
/** 一轮执行的输入，包含当前问题、历史、工具、预取调用及追踪元信息。 */
export interface HarnessInput {
    deferMaintenance?(work: BackgroundWork): void;
    /** Original evidence without reference answers, also used to audit learned methods. */
    evidence?: unknown;
    onEvent?(name: string, fields?: Record<string, unknown>): void;
    history: AgentMessage[];
    question: string;
    tools: RegisteredTool[] | HarnessToolFactory;
    metadata: Record<string, unknown>;
    /** full 保留原始历史，evidence 只保留与当前问题相关的原文证据。 */
    historyPolicy?: "full" | "evidence";
    proactiveTools?: boolean;
    initialCalls?: ToolCall[];
}
/** 统一执行入口，通用宿主和学科包装器都接收相同输入并返回 AgentResult。 */
export interface HarnessRunner {
    run(input: HarnessInput, signal?: AbortSignal): Promise<AgentResult>;
}
/** 公共执行宿主，统一管理上下文、工具权限、恢复、取消和追踪；决策交给工作流。 */
export class AgentHarness implements HarnessRunner {
    private readonly tokens: TokenBudget;
    private readonly recovery: RecoveryPolicy;
    private readonly options: Required<Omit<HarnessOptions, "recovery" | "skills">> & Pick<HarnessOptions, "skills">;
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
            skills: options.skills,
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
        let workflowMode: string | undefined;
        const event = (name: string, fields: Record<string, unknown> = {}) => {
            if (name === "agent.solve.route" || name === "agent.solve.started" || name === "agent.solve.limit") workflowMode = String(fields.mode);
            if (name === "agent.processing.started") workflowMode = "postprocess";
            if (!name.startsWith("agent.subagent.")) fields = { ...fields, workflowMode: workflowMode ?? "prefetch" };
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
                const explicitMaintenance = /(?:经验|方法库|skill|experience).*(?:新增|更新|修订|拆分|保存|维护|create|update|split|save|revise)|(?:新增|更新|修订|拆分|保存|维护|create|update|split|save|revise).*(?:经验|方法库|skill|experience)/i.test(input.question);
                const interactiveLearning = !!input.deferMaintenance && !explicitMaintenance;
                const skills = scope.depth === 0 ? this.options.skills?.open(String(metadata.subject ?? "general"), event,
                    session.definitions.has(SKILL_AGENTS.matcher) ? async (query, childSignal) => {
                        const matched = await runtime!.delegate({ agent: SKILL_AGENTS.matcher, input: skillMatchInput(query) }, childSignal);
                        return parseSkillMatch(matched.content);
                    } : undefined, !interactiveLearning) : undefined;
                if (skills && supplied.some(tool => tool.definition.name === "solution_skills")) throw new TypeError("Reserved harness tool: solution_skills");
                const { tools, history, prefetchHistory } = prepareRun(input, skills ? [...supplied, skills.tool(interactiveLearning)] : supplied, this.config, this.tokens, event);
                const instructions = skills && interactiveLearning ? { ...this.instructions, system: this.instructions.system +
                    "\nsolution_skills提供解题方法参考：search快速召回、match核对边界、load读取完整方法。必须检查当前条件是否适用，不把召回相似度当作正确性证明。完整解答本题；经验整理和审核在答案复核后由宿主处理，题解不输出经验维护内容。" } : skills ? { ...this.instructions, system: this.instructions.system +
                    "\n宿主已提供solution_skills解题经验工具：search/match检索并核对适用边界，load加载方法与子经验，history查看版本，propose新增草稿，update修订已有经验，split拆分综合经验。更新与拆分须提供skillId、当前expectedRevision和reason。update优先使用patch，只替换需要修改的草稿字段；列表按字段替换，须保留原有正确条目，无需重写其他字段。遇到同方法子题优先复用。本阶段先完整解答学科题目；用户的经验维护要求由宿主在答案复核通过后自动整理执行，可以不在解题阶段调用写操作。最终面向学习者只输出学科解答，不展示工具调用JSON、经验ID或维护草稿，维护结果由宿主运行轨迹记录。即使暂存变更，也必须输出全部题解，不能以工具JSON或工具标签代替答案。所有变更须独立审核，不能提前宣称已经发布。以本题原文为准。" } : this.instructions;
                const builder = new ContextBuilder(history, input.question, this.config,
                    this.tokens, compression, event, instructions);
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
                            { info() {}, error() {} }, { ...this.options, recovery: this.recovery, fallbackModels: [], resultProcessors: [] });
                        return child.runScoped({ question: request.input, history: request.context ?? [], tools: definition.tools ?? [],
                            proactiveTools: false, metadata: { ...metadata, taskId: childScope.taskId, parentTaskId: scope.taskId ?? null, agent: definition.name },
                            onEvent: (name, fields) => name.startsWith("agent.subagent.") ? event(name, fields) :
                                event("agent.subagent.event", { ...fields, event: name, taskId: childScope.taskId, parentTaskId: scope.taskId ?? null, agent: definition.name, ...(request.purpose ? { purpose: request.purpose } : {}) }),
                        }, operation, session, childScope);
                    }));
                // Acquire historical facts before the first model turn, avoiding lengthy unguided reasoning.
                if (prefetchHistory && runtime.tools.some(tool => tool.name === "history_lookup")) {
                    await runtime.prefetch([{ id: "harness-history-1", name: "history_lookup", arguments: { query: input.question } }], "检索历史原文和最新条件。", signal);
                }
                if (skills) {
                    await runtime.prefetch([{ id: "harness-skills-search", name: "solution_skills", arguments: { action: "search", query: input.question.slice(0, 12000) } }], "先检索当前学科可复用的解题方法。", signal);
                    for (const [index, id] of skills.initialLoads().entries()) await runtime.prefetch([
                        { id: `harness-skills-load-${index}`, name: "solution_skills", arguments: { action: "load", skillId: id } },
                    ], "读取相关方法的完整适用条件与解题流程。", signal);
                }
                if (input.initialCalls?.length) await runtime.prefetch(input.initialCalls, "先获取题目证据和条件检查。", signal);
                if (input.proactiveTools !== false && !input.initialCalls?.length && input.question.length > 1000 &&
                    /方程|抛物线|三角形|概率|x[²^]/.test(input.question) && runtime.tools.some(tool => tool.name === "math_analyze")) {
                    await runtime.prefetch([{ id: "harness-analyze-1", name: "math_analyze", arguments: { query: input.question } }], "先提取长问题的条件和可执行检查。", signal);
                }
                event("agent.workflow.started");
                let returned = await this.workflow.run(runtime, signal);
                event("agent.workflow.completed", { modelTurns: returned.modelTurns, toolCalls: returned.toolCalls });
                if (this.options.resultProcessors.length) event("agent.processing.started");
                signal?.throwIfAborted();
                for (const processor of this.options.resultProcessors) {
                    signal?.throwIfAborted();
                    returned = await processor.process(returned, runtime, { question: input.question, history: input.history, evidence: input.evidence }, signal);
                }
                if (skills) {
                    const resultContext = { question: input.question, history: input.history, evidence: input.evidence };
                    // Explicit writes stay synchronous. Automatic learning uses a fresh runtime,
                    // deadline and delegation budget; the completed request's signal is never reused.
                    const explicit = skills.hasProposal() || explicitMaintenance;
                    if (input.deferMaintenance && !explicit && returned.review?.status === "passed") {
                        const verified = structuredClone(returned), evidence = structuredClone(resultContext);
                        input.deferMaintenance(async backgroundSignal => {
                            const maintenance = new AgentHarness(this.model, { run: async (freshRuntime, scope) => {
                                event("agent.skills.maintenance.started", { background: true });
                                await skills.finish(verified, freshRuntime, evidence, scope);
                                event("agent.skills.maintenance.completed", { background: true });
                                return { content: "maintenance completed", modelTurns: 0, toolCalls: 0 };
                            } }, this.instructions, this.config, this.logger,
                            { ...this.options, recovery: this.recovery, skills: undefined, resultProcessors: [] });
                            await maintenance.run({ question: input.question, history: [], tools: [], proactiveTools: false,
                                metadata: { ...metadata, phase: "maintenance" }, onEvent: input.onEvent }, backgroundSignal);
                        });
                        event("agent.skills.maintenance.deferred");
                    } else {
                        event("agent.skills.maintenance.started");
                        await skills.finish(returned, runtime, resultContext, signal);
                        event("agent.skills.maintenance.completed");
                    }
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
