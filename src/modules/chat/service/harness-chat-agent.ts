import type { ChatAgent } from "./chat-agent.js";
import type { ChatSession, ChatMessage } from "../entity/chat-session.entity.js";
import type { HarnessRunner } from "../../harness/agent-harness.js";
import type { RegisteredTool } from "../../harness/tool-registry.js";
import { abortable } from "../../harness/cancellation.js";

export type ChatToolFactory = (session: ChatSession, signal?: AbortSignal) => Promise<RegisteredTool[]>;
export type ChatTitleGenerator = (session: ChatSession, signal?: AbortSignal) => Promise<string>;

/** Converts chat snapshots to a generic run; no workflow or provider fallback lives here. */
export class HarnessChatAgent implements ChatAgent {
  constructor(private readonly harness: HarnessRunner, private readonly tools: ChatToolFactory,
    private readonly title: ChatTitleGenerator) {}
  async run(session: ChatSession, current: ChatMessage, signal?: AbortSignal) {
    const snapshot = structuredClone(session);
    const question = current.content;
    const requestId = session.modelRequestId ?? current.id;
    return abortable(async () => {
      const tools = await this.tools(snapshot, signal);
      signal?.throwIfAborted();
      return this.harness.run({ history: snapshot.messages.map(({ role, content }) => ({ role, content })),
        question, tools, metadata: { sessionId: snapshot.id, requestId } }, signal);
    }, signal);
  }
  titleFor(session: ChatSession, signal?: AbortSignal): Promise<string> {
    return abortable(() => this.title(structuredClone(session), signal), signal);
  }
}
