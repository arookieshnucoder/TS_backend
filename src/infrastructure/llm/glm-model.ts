import type { AgentModel, LlmConfig } from "../../modules/agent/model.js";
import type { AgentMessage, ToolDefinition, AgentTurn } from "../../modules/agent/contracts.js";
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
/** Same explicit provider settings for every ablation. Hidden reasoning is never used as an answer. */
export class GlmModel implements AgentModel {
    constructor(private readonly config: LlmConfig, readonly thinking: "enabled" | "disabled" = "disabled") {}
    async turn(messages: AgentMessage[], tools: ToolDefinition[], signal?: AbortSignal, maxOutputTokens?: number): Promise<AgentTurn> {
        const current=[...messages].reverse().find(m=>m.role==="user")?.content??"";
        const outputBudget=maxOutputTokens??(current.length>1000 || /\(3\)|（3）|第2题|题2[：:]/.test(current)?4096:2048);
        const result = await request(this.config, "chat/completions", {
            model: this.config.llmModel, temperature: 0, max_tokens: outputBudget, thinking: { type: this.thinking },
            messages: messages.map(m => ({ role: m.role, content: m.content,
                ...(m.role === "assistant" && m.toolCalls?.length && m.reasoningContent ? { reasoning_content: m.reasoningContent } : {}),
                ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
                ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) })),
            ...(tools.length ? { tools: tools.map(t => ({ type: "function", function: t })) } : {}),
        }, signal);
        const message = result.choices?.[0]?.message;
        if (!message || result.choices[0].finish_reason === "length") throw new Error("GLM response missing or truncated");
        const usage = result.usage;
        return { content: message.content ?? "", toolCalls: (message.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function.name, arguments: JSON.parse(c.function.arguments) })),
            ...(typeof message.reasoning_content==="string"&&message.tool_calls?.length?{reasoningContent:message.reasoning_content}:{}),
            ...(Number.isSafeInteger(usage?.prompt_tokens) && Number.isSafeInteger(usage?.completion_tokens) ? { usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } } : {}) };
    }
}
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
