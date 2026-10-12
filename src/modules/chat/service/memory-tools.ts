import type { ChatSession } from "../entity/chat-session.entity.js";
import type { MemorySearch } from "./memory-search.js";
import type { ContextConfig } from "../../harness/context/config.js";
import type { ContextCompressor } from "../../harness/context/services.js";
import { SharedMemoryRetriever } from "./context-services.js";
import type { RegisteredTool } from "../../harness/tool-registry.js";
import { defineReadOnlyTool, stringParameter } from "../../harness/define-tool.js";


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
    // 参数声明统一生成 schema 和校验；execute 中的 query 自动推导为 string。
    return ["search_session_memory", "search_shared_memory"].map(name => defineReadOnlyTool({
        name,
        description: name === "search_session_memory" ? "Search earlier messages in this session." : "Search the latest ten other sessions for relevant memories with source session IDs.",
        parameters: { query: stringParameter(2000) },
        async execute({ query }, signal) {
            signal?.throwIfAborted();
            // Reset after failure so a later, refined call may recover from transient retrieval errors.
            ready ??= search.sync([session, ...candidates], signal).catch(error => { ready = undefined; throw error; });
            await ready;
            signal?.throwIfAborted();
            if (name === "search_shared_memory") return shared.execute({ sessions: candidates, query }, signal);
            const hits = await search.search(query, [session.id], 8, signal);
            return hits.map(hit => `[session=${hit.sessionId} chunk=${hit.id}]\n${hit.text}`).join("\n");
        },
    }));
}
