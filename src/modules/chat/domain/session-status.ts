export const SessionStatus = { PENDING: "pending", FINISHED: "finished", FAILURE: "failure" } as const;
export type SessionStatus = typeof SessionStatus[keyof typeof SessionStatus];
/** 会话公开错误信息，用于持久化失败状态并传给前端展示。 */
export interface SessionError {
    code: string;
    message: string;
    httpStatusCode: number;
}
export function isSessionStatus(value: unknown): value is SessionStatus {
    return Object.values(SessionStatus).includes(value as SessionStatus);
}
