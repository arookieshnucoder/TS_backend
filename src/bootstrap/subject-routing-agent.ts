import type { ChatAgent } from "../modules/chat/service/chat-agent.js";
import type { SchoolSubject } from "../modules/subjects/contracts.js";
import { SubjectClassifier } from "../modules/subjects/subject-classifier.js";
import { subjectHistory } from "./school-subject.js";

/** The classifier is a gate: no subject-specific solving or learning runs before it. */
export function createSubjectRoutingAgent(classifier: SubjectClassifier, agents: Record<SchoolSubject, ChatAgent>, defaultSubject: SchoolSubject = "math"): ChatAgent {
    return {
        resolveSubject: (session, current, signal, preferredSubject) => classifier.classify(session, current, signal, preferredSubject ?? defaultSubject),
        async run(session, current, signal, context) {
            const subject = context?.subjectResolved ? context.subject : await classifier.classify(session, current, signal, context?.preferredSubject ?? defaultSubject);
            signal?.throwIfAborted();
            if (!subject) return { content: "请说明要讨论的学科或提供具体题目；涉及多个学科时，请分开发送，以便分别解答和整理经验。", modelTurns: 0, toolCalls: 0 };
            current.subject = subject;
            session.subject = subject;
            const isolated = { ...session, messages: subjectHistory(session.messages, subject) };
            return agents[subject].run(isolated, current, signal, context ? { ...context, subject, subjectResolved: true } : undefined);
        },
        titleFor(session, signal) {
            const subject = session.subject ?? [...session.messages].reverse().find(message => message.subject)?.subject ?? defaultSubject;
            return agents[subject].titleFor({ ...session, messages: subjectHistory(session.messages, subject) }, signal);
        },
    };
}
