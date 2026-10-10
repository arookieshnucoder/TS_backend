import { InMemoryChatSessionRepository } from "../infrastructure/persistence/memory/in-memory-chat-session.repository.js";
import type { ChatSessionRepository } from "../modules/chat/repository/chat-session.repository.js";
import { logger, type Logger } from "../common/logging/logger.js";

export interface AppDependencies {
  chatSessionRepository: ChatSessionRepository;
  logger: Logger;
}

// 目前是memory mock实现，后续可以持久化接入相关数据库
// Composition root: select concrete implementations here, not in business services.
export function createDependencies(overrides: Partial<AppDependencies> = {}): AppDependencies {
  return {
    chatSessionRepository: overrides.chatSessionRepository ?? new InMemoryChatSessionRepository(),
    logger: overrides.logger ?? logger
  };
}
