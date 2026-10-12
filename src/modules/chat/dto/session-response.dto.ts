import type { ChatSession, ChatMessage } from "../entity/chat-session.entity.js";
import type { SessionStatus, SessionError } from "../domain/session-status.js";
export interface SessionResponseDto {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messages: ChatMessage[];
    modelRequestId: string | null;
    sessionStatus: SessionStatus;
    sessionError: SessionError | null;
}
export function toSessionResponse(session: ChatSession): SessionResponseDto {
    return {
        id: session.id, title: session.title, createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(), messages: session.messages,
        modelRequestId: session.modelRequestId ?? null,
        sessionStatus: session.sessionStatus, sessionError: session.sessionError
    };
}
