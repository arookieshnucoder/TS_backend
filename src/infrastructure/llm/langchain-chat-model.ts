import { errorContainer, type ErrorContainer } from "../../common/errors/error-container.js";
import { ChatOpenAI } from "@langchain/openai";
import type { AppConfig } from "../../config/env.js";
import type { ChatModel } from "../../modules/chat/service/chat-model.js";
import type { ChatMessage } from "../../modules/chat/entity/chat-session.entity.js";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { AgentMessage, ToolDefinition } from "../../modules/context/contracts.js";

// Only provider configuration, invocation and text extraction live here.
// The service handles the result once; no retries, alternate providers or mock answers.
export class LangChainChatModel implements ChatModel {
  constructor(private readonly config: AppConfig, private readonly errors: ErrorContainer = errorContainer) {}
  private model(maxOutputTokens = 4096) {
    if (!this.config.llmApiKey) return this.errors.fail("MODEL_REQUEST_FAILED", "后端未设置 LLM_API_KEY。");
    return new ChatOpenAI({
      apiKey: this.config.llmApiKey, model: this.config.llmModel,
      configuration: { baseURL: this.config.llmBaseUrl }, timeout: this.config.llmTimeoutMs, maxRetries: 0, maxTokens: maxOutputTokens,
    });
  }
  async reply(messages: ChatMessage[], signal?: AbortSignal, maxOutputTokens?: number): Promise<string> {
    const response = await this.model(maxOutputTokens).invoke(messages.map(({ role, content }) => ({ role, content })), { signal });
    return typeof response.content === "string" ? response.content : response.content
      .filter(block => block.type === "text").map(block => block.text).join("");
  }
  async turn(messages: AgentMessage[], tools: ToolDefinition[], signal?: AbortSignal) {
    const input = messages.map(message => {
      if (message.role === "system") return new SystemMessage(message.content);
      if (message.role === "tool") return new ToolMessage({ content: message.content, tool_call_id: message.toolCallId! });
      if (message.role === "assistant") return new AIMessage({ content: message.content,
        tool_calls: message.toolCalls?.map(call => ({ id: call.id, name: call.name, args: call.arguments, type: "tool_call" as const })) });
      return new HumanMessage(message.content);
    });
    const model = this.model();
    const runnable = tools.length ? model.bindTools(tools.map(tool => ({ type: "function" as const, function: tool }))) : model;
    const response = await runnable.invoke(input, { signal });
    if (response.invalid_tool_calls?.length) throw new Error("Invalid model tool call");
    return { content: typeof response.content === "string" ? response.content : response.content
      .filter(block => block.type === "text").map(block => block.text).join(""),
      toolCalls: (response.tool_calls ?? []).map(call => ({ id: call.id ?? "", name: call.name, arguments: call.args })) };
  }
}
