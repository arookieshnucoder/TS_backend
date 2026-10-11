import { errorContainer, type ErrorContainer } from "../common/errors/error-container.js";
import { JsonChatSessionRepository } from "../infrastructure/persistence/json/json-chat-session.repository.js";
import { LangChainChatModel } from "../infrastructure/llm/langchain-chat-model.js";
import type { ChatSessionRepository } from "../modules/chat/repository/chat-session.repository.js";
import type { AgentModel } from "../modules/agent/model.js";
import { loadConfig, type AppConfig } from "../config/env.js";
import { logger, type Logger } from "../common/logging/logger.js";
import { AgentHarness, type AgentRunner } from "../modules/harness/agent-harness.js";
import { TokenBudget } from "../modules/harness/context/tokens.js";
import { LocalMemorySearch, ElasticsearchMemorySearch } from "../infrastructure/llm/memory-search.js";


export interface AppDependencies {
  errors: ErrorContainer;
  chatSessionRepository: ChatSessionRepository;
  logger: Logger;
  agentHarness: AgentRunner;
}


export type DependencyOverrides = Partial<AppDependencies> & { agentModel?: AgentModel };

export function createDependencies(overrides: DependencyOverrides = {}, config: AppConfig = loadConfig()): AppDependencies {
  const errors = overrides.errors ?? errorContainer;
  const repository = overrides.chatSessionRepository ?? new JsonChatSessionRepository(config.sessionDataDir);
  const model = overrides.agentModel ?? new LangChainChatModel(config, errors);
  const log = overrides.logger ?? logger;
  return {
    errors,
    chatSessionRepository: repository,
    logger: log,
    agentHarness: overrides.agentHarness ?? new AgentHarness(repository, model,
      () => config.context.elasticsearchUrl ? new ElasticsearchMemorySearch(new TokenBudget(config.context), config.context) :
        new LocalMemorySearch(new TokenBudget(config.context)), config.context, log,
      { ...config.harness, excludedPaths: [config.sessionDataDir] })
  };
}
