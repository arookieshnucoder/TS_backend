import { errorContainer, type ErrorContainer } from "../common/errors/error-container.js";
import { JsonChatSessionRepository } from "../infrastructure/persistence/json/json-chat-session.repository.js";
import { LangChainChatModel } from "../infrastructure/llm/langchain-chat-model.js";
import type { ChatSessionRepository } from "../modules/chat/repository/chat-session.repository.js";
import type { AgentModel, LlmConfig } from "../modules/agent/model.js";
import { loadConfig, type AppConfig } from "../config/env.js";
import { logger, type Logger } from "../common/logging/logger.js";
import type { ChatAgent } from "../modules/chat/service/chat-agent.js";
import { createChatAgent } from "./chat-agent.js";
import { TokenBudget } from "../modules/harness/context/tokens.js";
import { LocalMemorySearch, ElasticsearchMemorySearch } from "../infrastructure/llm/memory-search.js";
import { McpManager } from "../modules/mcp/mcp-manager.js";
import type { NamedAgentModel } from "../modules/harness/recovery.js";
import { RunTraceStore } from "../modules/observability/run-trace.js";
import { createMathChatAgent } from "./math-chat-agent.js";
import { GlmModel } from "../infrastructure/llm/glm-model.js";
import type { MathOcrProvider } from "../modules/math/contracts.js";


export interface AppDependencies {
    mathOcr?: MathOcrProvider;
    runs?: RunTraceStore;
    mcp: McpManager;
    errors: ErrorContainer;
    chatSessionRepository: ChatSessionRepository;
    logger: Logger;
    agentHarness: ChatAgent;
}


export type DependencyOverrides = Partial<AppDependencies> & { agentModel?: AgentModel; fallbackModels?: NamedAgentModel[] };

export function createDependencies(overrides: DependencyOverrides = {}, config: AppConfig = loadConfig()): AppDependencies {
    const allowed = new Set(["errors", "chatSessionRepository", "logger", "agentHarness", "agentModel", "mcp", "fallbackModels", "runs", "mathOcr"]);
    for (const key of Object.keys(overrides)) {
        if (!allowed.has(key)) throw new TypeError(`Unsupported dependency override: ${key}`);
        if (overrides[key as keyof DependencyOverrides] == null) throw new TypeError(`Dependency override ${key} must not be null or undefined`);
    }
    if (overrides.agentHarness !== undefined && overrides.agentModel !== undefined) throw new TypeError("Inject either agentHarness or agentModel, not both");
    if (overrides.agentHarness !== undefined && overrides.fallbackModels !== undefined) throw new TypeError("Fallbacks belong to the injected harness");
    if (overrides.agentHarness !== undefined && (typeof overrides.agentHarness.run !== "function" || typeof overrides.agentHarness.titleFor !== "function"))
        throw new TypeError("agentHarness must implement run and titleFor");
    const errors = overrides.errors ?? errorContainer;
    const repository = overrides.chatSessionRepository ?? new JsonChatSessionRepository(config.sessionDataDir);
    const log = overrides.logger ?? logger;
    const provider: LlmConfig = { llmApiKey: config.llmApiKey, llmModel: config.llmModel, llmBaseUrl: config.llmBaseUrl, llmTimeoutMs: config.llmTimeoutMs };
    const mcp = overrides.mcp ?? new McpManager(config.mcp.configFile, log, undefined, config.mcp.timeoutMs);
    const runs = overrides.runs ?? (config.observability.enabled ? new RunTraceStore(config.observability.dataDir, log,
        [config.llmApiKey, config.llmFallback?.apiKey, config.mcp.adminToken], config.observability.maxEvents) : undefined);
    let agentHarness = overrides.agentHarness;
    if (!agentHarness) {
        const model = overrides.agentModel ?? (/^glm-/i.test(config.llmModel) ? new GlmModel(provider, config.math.thinking) : new LangChainChatModel(provider, errors));
        let fallbackModels = overrides.fallbackModels ?? [];
        if (overrides.fallbackModels === undefined && overrides.agentModel === undefined && config.llmFallback) {
            fallbackModels = [{ name: config.llmFallback.model, model: new LangChainChatModel({ ...provider,
                llmModel: config.llmFallback.model, llmBaseUrl: config.llmFallback.baseUrl, llmApiKey: config.llmFallback.apiKey }, errors) }];
        }
        agentHarness = config.math.variant !== "general" ? createMathChatAgent(model, config, log) : createChatAgent(repository, model,
            () => config.context.elasticsearchUrl ? new ElasticsearchMemorySearch(new TokenBudget(config.context), config.context) :
                new LocalMemorySearch(new TokenBudget(config.context)), config.context, log,
            { ...config.harness, fallbackModels,
                excludedPaths: [config.sessionDataDir, config.observability.dataDir, config.mcp.configFile],
                additionalTools: (_session, signal, context) => mcp.tools(signal, context?.event) });
    }
    return {
        mathOcr: overrides.mathOcr,
        runs,
        mcp,
        errors,
        chatSessionRepository: repository,
        logger: log,
        agentHarness,
    };
}
