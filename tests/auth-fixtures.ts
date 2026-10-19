import { AppError } from "../src/common/errors/app-error.js";
import type { AuthSession, AuthStore, StoredUser } from "../src/modules/auth/contracts.js";

/** Offline fixture only; production always uses a persistent adapter. */
export class TestAuthStore implements AuthStore {
    users = new Map<string, StoredUser>();
    sessions = new Map<string, AuthSession>();
    async initialize() {}
    async close() {}
    async findByUsername(username: string) { return [...this.users.values()].find(u => u.username === username) ?? null; }
    async register(input: Omit<StoredUser, "role">, session: AuthSession) {
        if ([...this.users.values()].some(user => user.username === input.username)) throw new AppError(409, "AUTH_EMAIL_EXISTS", "该邮箱已注册，请直接登录。");
        const user: StoredUser = { ...input, role: this.users.size ? "user" : "admin" };
        this.users.set(user.userId, user); this.sessions.set(session.tokenHash, session);
        return this.public(user);
    }
    async login(session: AuthSession) {
        const user = this.users.get(session.userId)!;
        user.loginAt = session.createdAt; this.sessions.set(session.tokenHash, session);
        return this.public(user);
    }
    async findSession(hash: string, now: Date) {
        const session = this.sessions.get(hash);
        const user = session && session.expiresAt > now && this.users.get(session.userId);
        return user ? this.public(user) : null;
    }
    async deleteSession(hash: string) { this.sessions.delete(hash); }
    private public({ passwordHash: _hash, ...user }: StoredUser) { return structuredClone(user); }
}
