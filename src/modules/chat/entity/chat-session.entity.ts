import type { SessionStatus, SessionError } from "../domain/session-status.js";
/**
 * 持久化的用户或助手消息；前端动画状态不写入会话。
 */
export interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
}

/**
 * 会话实体保留 Date 类型及内部请求标识，对外响应由 DTO 显式转换。
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
