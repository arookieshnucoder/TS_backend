import type { ChatSession } from "../entity/chat-session.entity.js";
/** 对外会话响应沿用实体字段；时间转为 ISO 字符串，内部 requestId 不对外输出。 */
export interface SessionResponseDto extends Omit<ChatSession, "requestId" | "createdAt" | "updatedAt" | "modelRequestId"> {
    createdAt: string;
    updatedAt: string;
    modelRequestId: string | null;
}
export function toSessionResponse(session: ChatSession): SessionResponseDto {
    return {
        id: session.id, title: session.title, createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(), messages: session.messages,
        modelRequestId: session.modelRequestId ?? null,
        sessionStatus: session.sessionStatus, sessionError: session.sessionError
    };
}
