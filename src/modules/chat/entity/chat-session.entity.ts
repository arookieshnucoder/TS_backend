import type { SessionStatus, SessionError } from "../domain/session-status.js";
/**
 * 和前端保持一致对应chatbot的 Rest API
 */
export interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
}

/**
 * 聊天会话实体
 */
export interface ChatSession {
    id: string;
    requestId: string;
    title: string;
    createdAt: Date;
    updatedAt: Date;
    messages: ChatMessage[];
    modelRequestId?: string | null;
    sessionStatus: SessionStatus;
    sessionError: SessionError | null;
}
