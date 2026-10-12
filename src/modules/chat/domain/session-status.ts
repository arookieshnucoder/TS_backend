export const SessionStatus = { PENDING: "pending", FINISHED: "finished", FAILURE: "failure" } as const;
export type SessionStatus = typeof SessionStatus[keyof typeof SessionStatus];
export interface SessionError {
    code: string;
    message: string;
    httpStatusCode: number;
}
export function isSessionStatus(value: unknown): value is SessionStatus {
    return Object.values(SessionStatus).includes(value as SessionStatus);
}
