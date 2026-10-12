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
import { ContextCompressor } from "../modules/harness/context/services.js";
import { SessionTitleGenerator } from "../modules/chat/service/context-services.js";
import { HarnessChatAgent, type ChatToolFactory, type ChatTitleGenerator } from "../modules/chat/service/harness-chat-agent.js";
import { createMemoryTools } from "../modules/chat/service/memory-tools.js";
import { createWorkspaceTools } from "../modules/harness/workspace-tools.js";
import { abortable } from "../modules/harness/cancellation.js";

export interface ChatAgentOptions extends HarnessOptions {
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
    const allowed = new Set(["workspaceRoot", "excludedPaths", "maxCallsPerStep", "toolTimeoutMs", "toolOutputTokens", "profile", "tools", "title"]);
    for (const key of Object.keys(options)) {
        if (!allowed.has(key)) throw new TypeError(`Unsupported chat agent option: ${key}`);
    }
    for (const key of ["tools", "title"] as const) {
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
    const compression = new ContextCompressor(model, tokens, config);
    const title = new SessionTitleGenerator(model, tokens, config);
    return new HarnessChatAgent(harness, options.tools ?? (async (session, signal) => {
        const candidates = structuredClone((await repository.findAll()).filter(s => s.id !== session.id && s.messages.length)
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, 10));
        signal?.throwIfAborted();
        return [...createMemoryTools(session, candidates, searchFactory(), compression, config),
        ...(options.workspaceRoot ? createWorkspaceTools(options.workspaceRoot, options.excludedPaths) : [])];
    }), options.title ?? (async (session, signal) => {
        try { return await abortable(() => title.execute(session, signal), signal); }
        catch {
            signal?.throwIfAborted();
            logger.error("context.title_failed", { sessionId: session.id });
            // A title failure must not invent a new title or select another provider.
            return session.title;
        }
    }));
}
