import { errorContainer, type ErrorContainer } from "../common/errors/error-container.js";
import { JsonChatSessionRepository } from "../infrastructure/persistence/json/json-chat-session.repository.js";
import { LangChainChatModel } from "../infrastructure/llm/langchain-chat-model.js";
import type { ChatSessionRepository } from "../modules/chat/repository/chat-session.repository.js";
import type { ChatModel } from "../modules/chat/service/chat-model.js";
import { loadConfig, type AppConfig } from "../config/env.js";
import { logger, type Logger } from "../common/logging/logger.js";


export interface AppDependencies {
  errors: ErrorContainer;
  chatSessionRepository: ChatSessionRepository;
  chatModel: ChatModel;
  logger: Logger;
}


export function createDependencies(overrides: Partial<AppDependencies> = {}, config: AppConfig = loadConfig()): AppDependencies {
  const errors = overrides.errors ?? errorContainer;
  return {
    errors,
    chatSessionRepository: overrides.chatSessionRepository ?? new JsonChatSessionRepository(config.sessionDataDir),
    chatModel: overrides.chatModel ?? new LangChainChatModel(config, errors),
    logger: overrides.logger ?? logger
  };
}
