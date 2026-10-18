export interface AuthConfig {
    enabled: boolean;
    driver: "postgres";
    databaseUrl?: string;
    secureCookie: boolean;
    sessionTtlSeconds: number;
}
export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
    const enabled = env.AUTH_ENABLED ?? (env.NODE_ENV === "test" ? "false" : "true");
    const secure = env.AUTH_COOKIE_SECURE ?? (env.NODE_ENV === "production" ? "true" : "false");
    const ttl = Number(env.AUTH_SESSION_TTL_SECONDS ?? "604800");
    if (!["true", "false"].includes(enabled) || !["true", "false"].includes(secure) ||
        !Number.isSafeInteger(ttl) || ttl < 60 || ttl > 2592000) throw new Error("Invalid authentication configuration");
    if (env.NODE_ENV === "production" && enabled !== "true") throw new Error("Authentication cannot be disabled in production");
    if (env.AUTH_DB_DRIVER && env.AUTH_DB_DRIVER !== "postgres") throw new Error("Unsupported AUTH_DB_DRIVER; install an AuthStore adapter before changing drivers");
    if (env.AUTH_DATABASE_URL) {
        let url: URL;
        try { url = new URL(env.AUTH_DATABASE_URL); } catch { throw new Error("Invalid AUTH_DATABASE_URL"); }
        if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error("Invalid AUTH_DATABASE_URL");
    }
    return { enabled: enabled === "true", driver: "postgres", databaseUrl: env.AUTH_DATABASE_URL,
        secureCookie: secure === "true", sessionTtlSeconds: ttl };
}
