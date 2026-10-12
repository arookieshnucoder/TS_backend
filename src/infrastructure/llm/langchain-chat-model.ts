import { errorContainer, type ErrorContainer } from "../../common/errors/error-container.js";
import { ChatOpenAI } from "@langchain/openai";
import type { AgentModel, LlmConfig } from "../../modules/agent/model.js";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { AgentMessage, ToolDefinition } from "../../modules/agent/contracts.js";

/**
 * 基于 LangChain 的聊天模型实现
 * 封装了与 LangChain 聊天模型的交互逻辑，包括消息转换、工具调用和响应处理。
 */
export class LangChainChatModel implements AgentModel {
    constructor(private readonly config: LlmConfig, private readonly errors: ErrorContainer = errorContainer) { }
    private model(maxOutputTokens = 4096) {
        if (!this.config.llmApiKey) return this.errors.fail("MODEL_REQUEST_FAILED", "后端未设置 LLM_API_KEY。");
        return new ChatOpenAI({
            apiKey: this.config.llmApiKey, model: this.config.llmModel,
            configuration: { baseURL: this.config.llmBaseUrl }, timeout: this.config.llmTimeoutMs, maxRetries: 0, maxTokens: maxOutputTokens,
        });
    }
    async turn(messages: AgentMessage[], tools: ToolDefinition[], signal?: AbortSignal, maxOutputTokens?: number) {
        const input = messages.map(message => {
            if (message.role === "system") return new SystemMessage(message.content);
            if (message.role === "tool") return new ToolMessage({ content: message.content, tool_call_id: message.toolCallId! });
            if (message.role === "assistant") return new AIMessage({
                content: message.content,
                tool_calls: message.toolCalls?.map(call => ({ id: call.id, name: call.name, args: call.arguments, type: "tool_call" as const }))
            });
            return new HumanMessage(message.content);
        });
        const model = this.model(maxOutputTokens);
        const runnable = tools.length ? model.bindTools(tools.map(tool => ({ type: "function" as const, function: tool }))) : model;
        const response = await runnable.invoke(input, { signal });
        if (response.invalid_tool_calls?.length) throw new Error("Invalid model tool call");
        return {
            ...(response.usage_metadata && Number.isSafeInteger(response.usage_metadata.input_tokens) && response.usage_metadata.input_tokens >= 0 &&
                Number.isSafeInteger(response.usage_metadata.output_tokens) && response.usage_metadata.output_tokens >= 0 ? {
                    usage: { inputTokens: response.usage_metadata.input_tokens, outputTokens: response.usage_metadata.output_tokens },
                } : {}),
            content: typeof response.content === "string" ? response.content : response.content
                .filter(block => block.type === "text").map(block => block.text).join(""),
            toolCalls: (response.tool_calls ?? []).map(call => ({ id: call.id ?? "", name: call.name, arguments: call.args }))
        };
    }
}
