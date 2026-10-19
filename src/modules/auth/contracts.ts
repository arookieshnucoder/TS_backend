/** Authentication depends on this port only. SQL dialects and transactions belong to adapters. */
export interface AuthUser {
    userId: string;
    username: string;
    role: "admin" | "user";
    createdAt: Date;
    loginAt: Date | null;
}
export interface StoredUser extends AuthUser { passwordHash: string }
export interface AuthSession { tokenHash: string; userId: string; createdAt: Date; expiresAt: Date }
export interface AuthStore {
    initialize(): Promise<void>;
    findByUsername(username: string): Promise<StoredUser | null>;
    /** 根据用户表原子确定首个管理员，同时写入用户及首次会话。 */
    register(user: Omit<StoredUser, "role">, session: AuthSession): Promise<AuthUser>;
    /** Commits login time and the new session together. */
    login(session: AuthSession): Promise<AuthUser>;
    findSession(tokenHash: string, now: Date): Promise<AuthUser | null>;
    deleteSession(tokenHash: string): Promise<void>;
    close(): Promise<void>;
}
