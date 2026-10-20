import type { ChatAgent, ChatAgentRunContext } from "./chat-agent.js";
import type { ChatSession, ChatMessage } from "../entity/chat-session.entity.js";
import type { HarnessRunner, HarnessToolContext } from "../../harness/agent-harness.js";
import type { RegisteredTool } from "../../harness/tool-contracts.js";
import { abortable } from "../../harness/cancellation.js";

export type ChatToolFactory = (session: ChatSession, signal: AbortSignal | undefined,
    context: ChatAgentRunContext | undefined, runtime: HarnessToolContext) => Promise<RegisteredTool[]>;
export type ChatTitleGenerator = (session: ChatSession, signal?: AbortSignal) => Promise<string>;

/** 把会话快照转换为公共宿主输入，统一发现工具并传递请求和消息标识。 */
export class HarnessChatAgent implements ChatAgent {
    constructor(private readonly harness: HarnessRunner, private readonly tools: ChatToolFactory,
        private readonly title: ChatTitleGenerator) { }
    async run(session: ChatSession, current: ChatMessage, signal?: AbortSignal, context?: ChatAgentRunContext) {
        const snapshot = structuredClone(session);
        const question = current.content;
        return abortable(async () => {
            return this.harness.run({
                history: snapshot.messages.map(({ role, content }) => ({ role, content })),
                question, tools: async (runtime, scope) => {
                    const started = Date.now();
                    context?.event("tools.discovery.started");
                    const tools = await this.tools(snapshot, scope, context, runtime);
                    scope?.throwIfAborted();
                    context?.event("tools.discovery.completed", {
                        durationMs: Date.now() - started, count: tools.length,
                        tools: tools.map(t => ({ name: t.definition.name, source: t.source, readonly: t.readonly }))
                    });
                    return tools;
                }, metadata: { sessionId: snapshot.id, requestId: snapshot.modelRequestId,
                    messageId: current.id, ...(context ? { runId: context.runId } : {}) }, onEvent: context?.event, deferMaintenance: context?.deferMaintenance
            }, signal);
        }, signal);
    }
    titleFor(session: ChatSession, signal?: AbortSignal): Promise<string> {
        return abortable(() => this.title(structuredClone(session), signal), signal);
    }
}
