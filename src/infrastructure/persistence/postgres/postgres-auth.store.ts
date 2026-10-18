import { Pool, type PoolClient } from "pg";
import { AppError } from "../../../common/errors/app-error.js";
import type { AuthSession, AuthStore, AuthUser, StoredUser } from "../../../modules/auth/contracts.js";

// Kept inside the adapter: a MySQL adapter owns its own DDL/locking strategy.
const schema = `
CREATE TABLE IF NOT EXISTS auth_users (
    user_id VARCHAR(64) PRIMARY KEY CHECK (char_length(user_id) = 64),
    username VARCHAR(64) NOT NULL UNIQUE CHECK (username = lower(username)),
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(16) NOT NULL CHECK (role IN ('admin', 'user')),
    created_at TIMESTAMPTZ NOT NULL,
    login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES auth_users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
CREATE TABLE IF NOT EXISTS auth_bootstrap (
    id INTEGER PRIMARY KEY CHECK (id = 1), claimed BOOLEAN NOT NULL
);
INSERT INTO auth_bootstrap(id, claimed) VALUES (1, EXISTS(SELECT 1 FROM auth_users)) ON CONFLICT DO NOTHING;
`;
function user(row: Record<string, any>): AuthUser {
    return { userId: row.user_id, username: row.username, role: row.role,
        createdAt: new Date(row.created_at), loginAt: row.login_at ? new Date(row.login_at) : null };
}
export class PostgresAuthStore implements AuthStore {
    readonly pool: Pool;
    constructor(databaseUrl?: string) {
        this.pool = new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5000,
            idleTimeoutMillis: 10000, query_timeout: 10000, statement_timeout: 10000 });
        // Pool idle errors must not crash the process or expose connection strings.
        this.pool.on("error", () => {});
    }
    private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await operation(client);
            await client.query("COMMIT");
            return result;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally { client.release(); }
    }
    async initialize() {
        await this.transaction(async client => {
            await client.query("SELECT pg_advisory_xact_lock(741280163)");
            await client.query(schema);
        });
    }
    async findByUsername(username: string): Promise<StoredUser | null> {
        const { rows } = await this.pool.query("SELECT * FROM auth_users WHERE username = $1", [username]);
        return rows[0] ? { ...user(rows[0]), passwordHash: rows[0].password_hash } : null;
    }
    async register(input: Omit<StoredUser, "role">, session: AuthSession): Promise<AuthUser> {
        try {
            return await this.transaction(async client => {
                const { rows } = await client.query("SELECT claimed FROM auth_bootstrap WHERE id = 1 FOR UPDATE");
                const role = rows[0].claimed ? "user" : "admin";
                const result = await client.query(`INSERT INTO auth_users(user_id, username, password_hash, role, created_at, login_at)
                    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [input.userId, input.username, input.passwordHash, role, input.createdAt, input.loginAt]);
                await this.insertSession(client, session);
                await client.query("UPDATE auth_bootstrap SET claimed = TRUE WHERE id = 1");
                return user(result.rows[0]);
            });
        } catch (error) {
            if ((error as { code?: string }).code === "23505") throw new AppError(409, "AUTH_EMAIL_EXISTS", "该邮箱已注册，请直接登录。");
            throw error;
        }
    }
    private async insertSession(client: PoolClient, session: AuthSession) {
        await client.query("DELETE FROM auth_sessions WHERE expires_at <= $1", [session.createdAt]);
        await client.query("INSERT INTO auth_sessions(token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
            [session.tokenHash, session.userId, session.createdAt, session.expiresAt]);
    }
    async login(session: AuthSession): Promise<AuthUser> {
        return this.transaction(async client => {
            const { rows } = await client.query("UPDATE auth_users SET login_at = $1 WHERE user_id = $2 RETURNING *", [session.createdAt, session.userId]);
            if (!rows[0]) throw new AppError(401, "AUTH_INVALID_CREDENTIALS", "邮箱或密码错误。");
            await this.insertSession(client, session);
            return user(rows[0]);
        });
    }
    async findSession(hash: string, now: Date): Promise<AuthUser | null> {
        const { rows } = await this.pool.query(`SELECT u.* FROM auth_sessions s JOIN auth_users u ON s.user_id = u.user_id
            WHERE s.token_hash = $1 AND s.expires_at > $2`, [hash, now]);
        return rows[0] ? user(rows[0]) : null;
    }
    async deleteSession(hash: string) { await this.pool.query("DELETE FROM auth_sessions WHERE token_hash = $1", [hash]); }
    async close() { await this.pool.end(); }
}
