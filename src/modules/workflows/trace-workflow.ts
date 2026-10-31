import type { ChatAgent } from "../chat/service/chat-agent.js";
import type { AppConfig } from "../../config/env.js";
import { runtimeSnapshot } from "./templates.js";
import type { WorkflowStore } from "./workflow.store.js";

/** Observe the existing agent without another scheduler or altered solving behavior. */
export function withWorkflowTrace(agent: ChatAgent, store: WorkflowStore, config: AppConfig): ChatAgent {
    return { titleFor: (session, signal) => agent.titleFor(session, signal),
        ...(agent.resolveSubject ? { resolveSubject: agent.resolveSubject.bind(agent) } : {}),
        async run(session, current, signal, context) {
            if (context?.workflow) {
                const subject = current.subject ?? context?.subject ?? session.subject;
                if (!subject) return agent.run(session, current, signal, context);
                try {
                    const version = await store.version(`subject-${subject}`);
                    signal?.throwIfAborted();
                    const { id, title, description, graph, revision } = version;
                    await context.workflow({ id, title, description, graph, revision, subject, runtime: runtimeSnapshot(config, subject) });
                } catch {
                    signal?.throwIfAborted();
                    context.event("workflow.snapshot.unavailable", { reason: "definition_unavailable" });
                }
            }
            return agent.run(session, current, signal, context);
        } };
}
