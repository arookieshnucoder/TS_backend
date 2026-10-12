import type { AgentModel } from "../src/modules/agent/model.js";
import type { ChatSessionRepository } from "../src/modules/chat/repository/chat-session.repository.js";
import { createChatAgent } from "../src/bootstrap/chat-agent.js";
import { loadContextConfig } from "../src/modules/harness/context/config.js";
import { TokenBudget } from "../src/modules/harness/context/tokens.js";
import { LocalMemorySearch } from "../src/infrastructure/llm/memory-search.js";
import type { AgentMessage } from "../src/modules/agent/contracts.js";

/** A deterministic provider fixture implementing the same mandatory turn protocol. */
export function textModel(generate: (messages: AgentMessage[], signal?: AbortSignal, maxOutputTokens?: number) => Promise<string>): AgentModel {
  return { async turn(messages, _tools, signal, maxOutputTokens) {
    return { content: await generate(messages, signal, maxOutputTokens), toolCalls: [] };
  } };
}

export function testHarness(repository: ChatSessionRepository, model: AgentModel): ReturnType<typeof createChatAgent> {
  const config = loadContextConfig({});
  return createChatAgent(repository, model, () => new LocalMemorySearch(new TokenBudget(config)), config,
    { info() {}, error() {} }, { title: async session => session.title });
}
