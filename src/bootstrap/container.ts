import { errorContainer, type ErrorContainer } from "../common/errors/error-container.js";
import { JsonChatSessionRepository } from "../infrastructure/persistence/json/json-chat-session.repository.js";
import { LangChainChatModel } from "../infrastructure/llm/langchain-chat-model.js";
import type { ChatSessionRepository } from "../modules/chat/repository/chat-session.repository.js";
import type { AgentModel } from "../modules/agent/model.js";
import { loadConfig, type AppConfig } from "../config/env.js";
import { logger, type Logger } from "../common/logging/logger.js";
import type { ChatAgent } from "../modules/chat/service/chat-agent.js";
import { createChatAgent } from "./chat-agent.js";
import { TokenBudget } from "../modules/harness/context/tokens.js";
import { LocalMemorySearch, ElasticsearchMemorySearch } from "../infrastructure/llm/memory-search.js";


export interface AppDependencies {
  errors: ErrorContainer;
  chatSessionRepository: ChatSessionRepository;
  logger: Logger;
  agentHarness: ChatAgent;
}


export type DependencyOverrides = Partial<AppDependencies> & { agentModel?: AgentModel };

export function createDependencies(overrides: DependencyOverrides = {}, config: AppConfig = loadConfig()): AppDependencies {
  const allowed = new Set(["errors", "chatSessionRepository", "logger", "agentHarness", "agentModel"]);
  for (const key of Object.keys(overrides)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported dependency override: ${key}. Use agentModel or agentHarness; legacy chatModel/contextHarness are unsupported.`);
    if (overrides[key as keyof DependencyOverrides] == null) throw new TypeError(`Dependency override ${key} must not be null or undefined`);
  }
  if (overrides.agentHarness !== undefined && overrides.agentModel !== undefined) throw new TypeError("Inject either agentHarness or agentModel, not both");
  if (overrides.agentModel !== undefined && typeof overrides.agentModel.turn !== "function") throw new TypeError("agentModel must implement turn");
  if (overrides.agentHarness !== undefined && (typeof overrides.agentHarness.run !== "function" || typeof overrides.agentHarness.titleFor !== "function"))
    throw new TypeError("agentHarness must implement run and titleFor");
  const errors = overrides.errors ?? errorContainer;
  const repository = overrides.chatSessionRepository ?? new JsonChatSessionRepository(config.sessionDataDir);
  const log = overrides.logger ?? logger;
  return {
    errors,
    chatSessionRepository: repository,
    logger: log,
    agentHarness: overrides.agentHarness ?? createChatAgent(repository, overrides.agentModel ?? new LangChainChatModel(config, errors),
      () => config.context.elasticsearchUrl ? new ElasticsearchMemorySearch(new TokenBudget(config.context), config.context) :
        new LocalMemorySearch(new TokenBudget(config.context)), config.context, log,
      { ...config.harness, excludedPaths: [config.sessionDataDir] })
  };
}
