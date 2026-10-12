import type { ChatSession } from "../entity/chat-session.entity.js";
import type { MemorySearch } from "./memory-search.js";
import type { ContextConfig } from "../../harness/context/config.js";
import type { ContextCompressor } from "../../harness/context/services.js";
import { SharedMemoryRetriever } from "./context-services.js";
import { stringField, validateFields, type RegisteredTool } from "../../harness/tool-registry.js";


/**
 * 上下文的工具
 * @param session 对话实体
 * @param candidates 其他候选会话实体
 * @param search 内存搜索
 * @param compression 上下文压缩
 * @param config 上下文配置
 * @returns 已注册的内存工具数组
 */
export function createMemoryTools(session: ChatSession, candidates: ChatSession[], search: MemorySearch,
    compression: ContextCompressor, config: ContextConfig): RegisteredTool[] {
    // Retrieval is demand-driven. A greeting never triggers indexing or embedding.
    let ready: Promise<void> | undefined;
    const shared = new SharedMemoryRetriever(search, compression, config);
    // 返回的上下文记忆的格式要有，readonly，definition，validate，execute 等字段，确保工具注册的一致性。
    // TODO: 后面把他做成一个通用的内存工具注册函数
    return ["search_session_memory", "search_shared_memory"].map(name => ({
        readonly: true,
        definition: {
            name, description: name === "search_session_memory" ? "Search earlier messages in this session." : "Search the latest ten other sessions for relevant memories with source session IDs.",
            parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["query"], additionalProperties: false }
        },
        validate(input) { validateFields(input, ["query"]); stringField(input, "query", 2000); },
        async execute(input, signal) {
            signal?.throwIfAborted();
            // Reset after failure so a later, refined call may recover from transient retrieval errors.
            ready ??= search.sync([session, ...candidates], signal).catch(error => { ready = undefined; throw error; });
            await ready;
            signal?.throwIfAborted();
            if (name === "search_shared_memory") return shared.execute({ sessions: candidates, query: input.query as string }, signal);
            const hits = await search.search(input.query as string, [session.id], 8, signal);
            return hits.map(hit => `[session=${hit.sessionId} chunk=${hit.id}]\n${hit.text}`).join("\n");
        },
    }));
}
