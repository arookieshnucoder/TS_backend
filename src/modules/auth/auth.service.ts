import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthConfig } from "./config.js";
import type { AuthSession, AuthStore, AuthUser } from "./contracts.js";
import { hashPassword, verifyPassword } from "./password.js";

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export function credentials(body: unknown): { username: string; password: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "AUTH_INVALID_INPUT", "请填写邮箱和密码。");
    const { username, password } = body as Record<string, unknown>;
    const email = typeof username === "string" ? username.trim().toLowerCase() : "";
    if (email.length > 64 || email.startsWith(".") || email.includes("..") || email.includes(".@") ||
        !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email))
        throw new AppError(400, "AUTH_INVALID_INPUT", "请输入有效邮箱，最多 64 个字符。");
    if (typeof password !== "string" || password.length < 8 || password.length > 128)
        throw new AppError(400, "AUTH_INVALID_INPUT", "密码长度需为 8–128 个字符。");
    return { username: email, password };
}

export class AuthService {
    private initialization?: Promise<void>;
    constructor(readonly store: AuthStore, readonly config: AuthConfig) { }
    initialize() {
        return this.initialization ??= this.store.initialize().catch(error => { this.initialization = undefined; throw error; });
    }
    private session(userId: string) {
        const token = randomBytes(32).toString("hex");
        const createdAt = new Date();
        const session: AuthSession = { tokenHash: tokenHash(token), userId, createdAt,
            expiresAt: new Date(createdAt.getTime() + this.config.sessionTtlSeconds * 1000) };
        return { token, session };
    }
    async register(body: unknown, oldToken?: string) {
        const input = credentials(body);
        await this.initialize();
        const userId = randomBytes(32).toString("hex");
        const { token, session } = this.session(userId);
        const user = await this.store.register({ userId, username: input.username, passwordHash: await hashPassword(input.password),
            createdAt: session.createdAt, loginAt: session.createdAt }, session);
        if (oldToken) await this.store.deleteSession(tokenHash(oldToken));
        return { user, token };
    }
    async login(body: unknown, oldToken?: string) {
        const input = credentials(body);
        await this.initialize();
        const stored = await this.store.findByUsername(input.username);
        const matches = await verifyPassword(input.password, stored?.passwordHash);
        if (!stored || !matches) throw new AppError(401, "AUTH_INVALID_CREDENTIALS", "邮箱或密码错误。");
        const { token, session } = this.session(stored.userId);
        const user = await this.store.login(session);
        if (oldToken) await this.store.deleteSession(tokenHash(oldToken));
        return { user, token };
    }
    async current(token?: string): Promise<AuthUser | null> {
        if (!token) return null;
        await this.initialize();
        return this.store.findSession(tokenHash(token), new Date());
    }
    async logout(token?: string) {
        if (token) { await this.initialize(); await this.store.deleteSession(tokenHash(token)); }
    }
}
