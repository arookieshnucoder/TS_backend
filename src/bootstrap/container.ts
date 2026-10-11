import { errorContainer, type ErrorContainer } from "../common/errors/error-container.js";
import { JsonChatSessionRepository } from "../infrastructure/persistence/json/json-chat-session.repository.js";
import { LangChainChatModel } from "../infrastructure/llm/langchain-chat-model.js";
import type { ChatSessionRepository } from "../modules/chat/repository/chat-session.repository.js";
import type { ChatModel } from "../modules/chat/service/chat-model.js";
import { loadConfig, type AppConfig } from "../config/env.js";
import { logger, type Logger } from "../common/logging/logger.js";
import { ContextHarness } from "../modules/context/harness.js";
import { TokenBudget } from "../modules/context/tokens.js";
import { LocalMemorySearch, ElasticsearchMemorySearch } from "../infrastructure/llm/memory-search.js";


export interface AppDependencies {
  errors: ErrorContainer;
  chatSessionRepository: ChatSessionRepository;
  chatModel: ChatModel;
  logger: Logger;
  contextHarness: ContextHarness | null;
}


export function createDependencies(overrides: Partial<AppDependencies> = {}, config: AppConfig = loadConfig()): AppDependencies {
  const errors = overrides.errors ?? errorContainer;
  const repository = overrides.chatSessionRepository ?? new JsonChatSessionRepository(config.sessionDataDir);
  const model = overrides.chatModel ?? new LangChainChatModel(config, errors);
  const log = overrides.logger ?? logger;
  return {
    errors,
    chatSessionRepository: repository,
    chatModel: model,
    logger: log,
    contextHarness: overrides.contextHarness !== undefined ? overrides.contextHarness : new ContextHarness(repository, model,
      () => config.context.elasticsearchUrl ? new ElasticsearchMemorySearch(new TokenBudget(config.context), config.context) :
        new LocalMemorySearch(new TokenBudget(config.context)), config.context, log)
  };
}
