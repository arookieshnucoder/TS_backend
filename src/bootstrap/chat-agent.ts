import type { ChatSessionRepository } from "../modules/chat/repository/chat-session.repository.js";
import type { AgentModel } from "../modules/agent/model.js";
import type { AgentInstructions, AgentWorkflow } from "../modules/agent/contracts.js";
import type { Logger } from "../common/logging/logger.js";
import type { ContextConfig } from "../modules/harness/context/config.js";
import type { MemorySearch } from "../modules/chat/service/memory-search.js";
import { AgentHarness, type HarnessOptions } from "../modules/harness/agent-harness.js";
import { AskAgent } from "../modules/agent/ask-agent.js";
import { ASK_INSTRUCTIONS, FINAL_INSTRUCTIONS } from "../modules/agent/prompt.js";
import { TokenBudget } from "../modules/harness/context/tokens.js";
import { SessionTitleGenerator } from "../modules/chat/service/context-services.js";
import { HarnessChatAgent, type ChatToolFactory, type ChatTitleGenerator } from "../modules/chat/service/harness-chat-agent.js";
import { createMemoryTools } from "../modules/chat/service/memory-tools.js";
import { createWorkspaceTools } from "../modules/harness/workspace-tools.js";
import { mathAnalyzeTool, mathCalculateTool } from "../modules/math/task-tools.js";
import { taskPlanTool } from "../modules/harness/task-tools.js";

/** 通用聊天入口的组装选项，可替换工作流、工具工厂和标题生成器。 */
export interface ChatAgentOptions extends HarnessOptions {
    additionalTools?: ChatToolFactory;
    workspaceRoot?: string;
    excludedPaths?: string[];
    profile?: { workflow: AgentWorkflow; instructions: AgentInstructions };
    tools?: ChatToolFactory;
    title?: ChatTitleGenerator;
}

/**
 * 创建一个聊天 agent 实例，封装了会话存储、模型、内存检索、上下文构建和工具注册。
 * @param repository 聊天会话存储。
 * @param model 代理使用的语言模型。
 * @param searchFactory 内存检索工厂函数。
 * @param config 上下文配置。
 * @param logger 日志记录器。
 * @param options 聊天代理的可选配置。
 * @returns 配置完成的聊天代理实例。
 */
export function createChatAgent(repository: ChatSessionRepository, model: AgentModel,
    searchFactory: () => MemorySearch, config: ContextConfig, logger: Logger, options: ChatAgentOptions = {}) {
    const allowed = new Set(["workspaceRoot", "excludedPaths", "maxCallsPerStep", "toolTimeoutMs", "toolOutputTokens", "profile", "tools", "title", "additionalTools", "recovery", "fallbackModels", "maxProtocolRepairs", "maxMcpTools", "subAgents", "delegation", "resultProcessors", "skills"]);
    for (const key of Object.keys(options)) {
        if (!allowed.has(key)) throw new TypeError(`Unsupported chat agent option: ${key}`);
    }
    for (const key of ["tools", "title", "additionalTools"] as const) {
        if (Object.hasOwn(options, key) && typeof options[key] !== "function") throw new TypeError(`${key} must be a function`);
    }
    if (Object.hasOwn(options, "profile") && (typeof options.profile?.workflow?.run !== "function" ||
        typeof options.profile?.instructions?.system !== "string" || typeof options.profile?.instructions?.final !== "string"))
        throw new TypeError("profile must supply a workflow and system/final instructions");
    const profile = options.profile ?? {
        workflow: new AskAgent(), instructions: {
            system: ASK_INSTRUCTIONS + (options.workspaceRoot ? "\nWorkspace paths are relative to the configured workspace root." : "\nWorkspace tools are unavailable."),
            final: FINAL_INSTRUCTIONS,
        }
    };
    const harness = new AgentHarness(model, profile.workflow, profile.instructions, config, logger, options);
    const tokens = new TokenBudget(config);
    const title = new SessionTitleGenerator(model, tokens, config);
    const toolFactory: ChatToolFactory = options.tools ?? (async (session, signal, _context, runtime) => {
        const candidates = (await repository.findAll()).filter(s => s.id !== session.id && s.messages.length)
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, 10);
        signal?.throwIfAborted();
        return [...createMemoryTools(session, candidates, searchFactory(), runtime.compression, config),
        ...(options.workspaceRoot ? createWorkspaceTools(options.workspaceRoot, options.excludedPaths) : [])];
    });
    return new HarnessChatAgent(harness, async (session, signal, context, runtime) => {
        const [custom, extra] = await Promise.all([toolFactory(session, signal, context, runtime), options.additionalTools?.(session, signal, context, runtime) ?? []]);
        const supplied = [...custom, ...extra];
        const names = new Set(supplied.map(tool => tool.definition.name));
        // 显式工具集合保持调用方契约；默认补充工具只在未被业务工具覆盖时注册一次。
        const defaults = options.tools ? [] : [mathAnalyzeTool(), mathCalculateTool(), taskPlanTool()];
        return [...supplied, ...defaults.filter(tool => !names.has(tool.definition.name))];
    // 标题异常统一由会话服务处理，确保追踪能记录失败，已保存的答案仍然有效。
    }, options.title ?? ((session, signal) => title.execute(session, signal)));
}
