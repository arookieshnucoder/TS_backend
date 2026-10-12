import type { ChatAgent, ChatAgentRunContext } from "./chat-agent.js";
import type { ChatSession, ChatMessage } from "../entity/chat-session.entity.js";
import type { HarnessRunner } from "../../harness/agent-harness.js";
import type { RegisteredTool } from "../../harness/tool-contracts.js";
import { abortable } from "../../harness/cancellation.js";

export type ChatToolFactory = (session: ChatSession, signal?: AbortSignal, context?: ChatAgentRunContext) => Promise<RegisteredTool[]>;
export type ChatTitleGenerator = (session: ChatSession, signal?: AbortSignal) => Promise<string>;

/** Converts chat snapshots to a generic run; no workflow or provider fallback lives here. */
export class HarnessChatAgent implements ChatAgent {
  constructor(private readonly harness: HarnessRunner, private readonly tools: ChatToolFactory,
    private readonly title: ChatTitleGenerator) {}
  async run(session: ChatSession, current: ChatMessage, signal?: AbortSignal, context?: ChatAgentRunContext) {
    const snapshot = structuredClone(session);
    const question = current.content;
    const requestId = session.modelRequestId ?? current.id;
    return abortable(async () => {
      const started = Date.now();
      context?.event("tools.discovery.started");
      const tools = await this.tools(snapshot, signal, context);
      signal?.throwIfAborted();
      context?.event("tools.discovery.completed", { durationMs: Date.now() - started, count: tools.length,
        tools: tools.map(t => ({ name: t.definition.name, source: t.source, readonly: t.readonly })) });
      return this.harness.run({ history: snapshot.messages.map(({ role, content }) => ({ role, content })),
        question, tools, metadata: { sessionId: snapshot.id, requestId, ...(context ? { runId: context.runId } : {}) }, onEvent: context?.event }, signal);
    }, signal);
  }
  titleFor(session: ChatSession, signal?: AbortSignal): Promise<string> {
    return abortable(() => this.title(structuredClone(session), signal), signal);
  }
}
