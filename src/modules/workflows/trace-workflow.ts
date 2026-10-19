import type { ChatAgent } from "../chat/service/chat-agent.js";
import type { AppConfig } from "../../config/env.js";
import { routeSchoolSubject } from "../../bootstrap/school-subject.js";
import { runtimeSnapshot } from "./templates.js";
import type { WorkflowStore } from "./workflow.store.js";

/** Observe the existing agent without another scheduler or altered solving behavior. */
export function withWorkflowTrace(agent: ChatAgent, store: WorkflowStore, config: AppConfig): ChatAgent {
    return { titleFor: (session, signal) => agent.titleFor(session, signal),
        async run(session, current, signal, context) {
            if (context?.workflow) {
                const subject = config.schoolSubject === "auto" ? routeSchoolSubject(current.content, session.messages) : config.schoolSubject;
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
