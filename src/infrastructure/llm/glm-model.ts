import type { AgentModel, LlmConfig } from "../../modules/agent/model.js";
import { ModelProtocolError } from "../../modules/agent/model.js";
import type { AgentMessage, ToolDefinition, AgentTurn, ToolCall } from "../../modules/agent/contracts.js";
import type { Embeddings } from "../../modules/math/contracts.js";
async function request(config: LlmConfig, path: string, body: unknown, signal?: AbortSignal): Promise<any> {
    if (!config.llmApiKey) throw new Error("LLM_API_KEY is required");
    const response = await fetch(`${config.llmBaseUrl?.replace(/\/$/, "")}/${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${config.llmApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.llmTimeoutMs)]) : AbortSignal.timeout(config.llmTimeoutMs),
    });
    // Provider bodies can contain sensitive material; never log or persist them on failure.
    if (!response.ok) throw Object.assign(new Error(`GLM request failed (HTTP ${response.status})`), { status: response.status });
    return response.json();
}
function parseToolCalls(value: unknown): ToolCall[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new ModelProtocolError("INVALID_TOOL_CALLS");
    return value.map(call => {
        try {
            if (!call || call.type !== "function" || typeof call.id !== "string" || typeof call.function?.name !== "string" ||
                typeof call.function.arguments !== "string") throw new Error();
            const args: unknown = JSON.parse(call.function.arguments);
            if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
            return { id: call.id, name: call.function.name, arguments: args as Record<string, unknown> };
        } catch { throw new ModelProtocolError("INVALID_TOOL_CALLS"); }
    });
}

/** 只转换供应商协议；不猜工具名、不修补 JSON、不把隐藏推理当成最终答案。 */
export class GlmModel implements AgentModel {
    get modelId() { return this.config.llmModel; }
    constructor(private readonly config: LlmConfig, readonly thinking: "enabled" | "disabled" = "disabled",
        private readonly options: { jsonOutput?: boolean } = {}) {}
    async turn(messages: AgentMessage[], tools: ToolDefinition[], signal?: AbortSignal, maxOutputTokens?: number): Promise<AgentTurn> {
        const current = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
        // Harness 的标题/摘要显式指定纯文本输出上限；禁用推理，避免推理耗尽这个小预算。
        const thinking = !tools.length && maxOutputTokens !== undefined ? "disabled" : this.thinking;
        // 思考模式的输出预算包含推理 token，不能沿用短答案的 2048 上限。
        const outputBudget = maxOutputTokens ?? (thinking === "enabled" ? 8192 :
            current.length > 1000 || /\(3\)|（3）|第2题|题2[：:]/.test(current) ? 4096 : 2048);
        const result = await request(this.config, "chat/completions", {
            model: this.config.llmModel, temperature: 0, max_tokens: outputBudget, thinking: { type: thinking },
            ...(this.options.jsonOutput ? { response_format: { type: "json_object" } } : {}),
            messages: messages.map(m => ({ role: m.role, content: m.content,
                ...(m.role === "assistant" && m.toolCalls?.length && m.reasoningContent ? { reasoning_content: m.reasoningContent } : {}),
                ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
                ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) })),
            ...(tools.length ? { tools: tools.map(t => ({ type: "function", function: t })), tool_choice: "auto" } : {}),
        }, signal);
        const message = result.choices?.[0]?.message;
        if (!message || result.choices[0].finish_reason === "length" ||
            (message.content != null && typeof message.content !== "string")) throw new ModelProtocolError("INVALID_RESPONSE");
        const toolCalls = parseToolCalls(message.tool_calls);
        const usage = result.usage;
        return { content: message.content ?? "", toolCalls,
            ...(typeof message.reasoning_content === "string" && toolCalls.length ? { reasoningContent: message.reasoning_content } : {}),
            ...(Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0 ?
                { usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } } : {}) };
    }
}
/** 调用 GLM 向量接口并验证维度和返回顺序，供数学检索和题目入库使用。 */
export class GlmEmbeddings implements Embeddings {
    readonly model = "embedding-3";
    constructor(private readonly config: LlmConfig, readonly dimensions = 256) {}
    async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
        const vectors: number[][] = [];
        for (let i = 0; i < texts.length; i += 16) {
            const batch = texts.slice(i, i + 16);
            const result = await request(this.config, "embeddings", { model: this.model, dimensions: this.dimensions, input: batch }, signal);
            if (!Array.isArray(result.data) || result.data.length !== batch.length) throw new Error("Invalid embedding response");
            const sorted = [...result.data].sort((a, b) => a.index - b.index);
            sorted.forEach((r, index) => { if (r.index !== index || !Array.isArray(r.embedding) || r.embedding.length !== this.dimensions || r.embedding.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n))) throw new Error("Invalid embedding dimensions or values"); });
            vectors.push(...sorted.map(r => r.embedding));
        }
        return vectors;
    }
}
