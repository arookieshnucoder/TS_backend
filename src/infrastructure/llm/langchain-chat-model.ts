import { errorContainer, type ErrorContainer } from "../../common/errors/error-container.js";
import { ChatOpenAI } from "@langchain/openai";
import type { AppConfig } from "../../config/env.js";
import type { ChatModel } from "../../modules/chat/service/chat-model.js";
import type { ChatMessage } from "../../modules/chat/entity/chat-session.entity.js";

// Only provider configuration, invocation and text extraction live here.
// The service handles the result once; no retries, alternate providers or mock answers.
export class LangChainChatModel implements ChatModel {
  constructor(private readonly config: AppConfig, private readonly errors: ErrorContainer = errorContainer) {}
  async reply(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    if (!this.config.llmApiKey) return this.errors.fail("MODEL_REQUEST_FAILED", "后端未设置 LLM_API_KEY。");
    const model = new ChatOpenAI({
      apiKey: this.config.llmApiKey, model: this.config.llmModel,
      configuration: { baseURL: this.config.llmBaseUrl }, timeout: this.config.llmTimeoutMs, maxRetries: 0,
    });
    const response = await model.invoke(messages.map(({ role, content }) => ({ role, content })), { signal });
    return typeof response.content === "string" ? response.content : response.content
      .filter(block => block.type === "text").map(block => block.text).join("");
  }
}
