import type { AppConfig } from "../config/env.js";
import type { AgentModel } from "../modules/agent/model.js";
import type { ChatAgent } from "../modules/chat/service/chat-agent.js";
import type { Logger } from "../common/logging/logger.js";
import { loadCorpus } from "../modules/math/corpus.js";
import { MathRag } from "../modules/math/rag.js";
import { MathSubmissions } from "../modules/math/submissions.js";
import { createMathProfile } from "../modules/math/profile.js";
import { GlmEmbeddings } from "../infrastructure/llm/glm-model.js";
import type { HarnessOptions } from "../modules/harness/agent-harness.js";
import { isOptimizedMathVariant } from "../modules/math/contracts.js";
export function mathEmbeddingConfig(config: AppConfig) {
    const key = config.context.embeddingApiKey;
    if (!key && config.llmApiKey && config.math.embeddingBaseUrl.replace(/\/$/, "") !== config.llmBaseUrl?.replace(/\/$/, ""))
        throw new Error("A different mathematics embedding endpoint requires EMBEDDING_API_KEY");
    return { ...config, llmBaseUrl: config.math.embeddingBaseUrl, llmApiKey: key ?? config.llmApiKey };
}
export function createMathChatAgent(model: AgentModel, config: AppConfig, logger: Logger, options: HarnessOptions = config.harness): ChatAgent {
    const embeddings = new GlmEmbeddings(mathEmbeddingConfig(config));
    const submissions = new MathSubmissions(config.math.submissionsPath, embeddings);
    let pending: Promise<MathRag> | undefined;
    // 语料/索引按需加载并在进程内复用；加载失败清空 Promise，下一次请求可以重试。
    const getRag = () => pending ??= loadCorpus(config.math.corpusPath).then(c => MathRag.open(c.knowledge, config.math.indexPath, embeddings))
        .catch(error => { pending = undefined; throw error; });
    return {
        async run(session, current, signal, context) {
            const rag = await getRag();
            signal?.throwIfAborted();
            const optimized = isOptimizedMathVariant(config.math.variant);
            // 优化检索自己生成向量，提交阶段避免重复 embedding；入库状态契约保持不变。
            const submission = await submissions.ingest(current.content, signal, !optimized);
            context?.event("math.ingested", { submissionId: submission.record.id, normalizedLength: submission.record.normalized.length });
            const profile = createMathProfile(config.math.variant === "general" ? "combined" : config.math.variant, rag, model, config.context, logger, options);
            const result = await profile.harness.run({ history: session.messages.map(({ role, content }) => ({ role, content })), question: current.content.trim(),
                tools: [rag.tool(profile.mode, context?.event)], metadata: { sessionId: session.id, messageId: current.id, runId: context?.runId }, onEvent: context?.event }, signal);
            signal?.throwIfAborted();
            await submission.finish(result.content);
            return result;
        },
        async titleFor(session) {
            const text = session.messages.find(message => message.role === "user")?.content;
            return text ? `数学 · ${text.replace(/\s+/g, " ").slice(0, 28)}` : session.title;
        },
    };
}
