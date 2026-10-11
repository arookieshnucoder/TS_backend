import type { ChatSession } from "../chat/entity/chat-session.entity.js";
import type { MemorySearch } from "./context/contracts.js";
import type { ContextConfig } from "./context/config.js";
import { ContextCompressor, SharedMemoryRetriever } from "./context/services.js";
import { stringField, validateFields, type RegisteredTool } from "./tool-registry.js";

export function createMemoryTools(session: ChatSession, candidates: ChatSession[], search: MemorySearch,
  compression: ContextCompressor, config: ContextConfig): RegisteredTool[] {
  // Retrieval is demand-driven. A greeting never triggers indexing or embedding.
  let ready: Promise<void> | undefined;
  const shared = new SharedMemoryRetriever(search, compression, config);
  return ["search_session_memory", "search_shared_memory"].map(name => ({
    readonly: true,
    definition: { name, description: name === "search_session_memory" ? "Search earlier messages in this session." : "Search the latest ten other sessions for relevant memories with source session IDs.",
      parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["query"], additionalProperties: false } },
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
