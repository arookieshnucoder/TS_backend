import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { loadConfig } from "../src/config/env.js";
import { loadEnvironment } from "../src/config/environment.js";
import { AuthService, credentials, tokenHash } from "../src/modules/auth/auth.service.js";
import { hashPassword, verifyPassword } from "../src/modules/auth/password.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";
import { TestAuthStore } from "./auth-fixtures.js";

const config = loadConfig({ NODE_ENV: "test", AUTH_ENABLED: "true", AGENT_TRACE_ENABLED: "false" });
const password = "a secure test password";
const headers = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: config.frontendOrigin };
async function setup() {
    const store = new TestAuthStore();
    const auth = new AuthService(store, config.auth);
    const repo = new InMemoryChatSessionRepository();
    const seen: string[][] = [];
    const deps = createDependencies({ auth, logger: { info() {}, error() {} }, chatSessionRepository: repo,
        agentHarness: { async run() { seen.push((await deps.chatSessionRepository.findAll()).map(s => s.ownerId!)); return { content: "answer" }; },
            async titleFor(s) { return s.title; } } }, config);
    const server = createApp(config, deps).listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const request = (path: string, body?: unknown, cookie = "", extra: Record<string, string> = {}) => fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST", headers: { ...headers, Cookie: cookie, ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    async function register(username: string) {
        const response = await request("/auth/register", { username, password, role: "admin" });
        assert.equal(response.status, 201);
        const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
        return { cookie, response, ...(await response.json() as any).data };
    }
    return { store, auth, repo, seen, request, register, async close() {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await deps.mcp.close();
    } };
}

test("SHA-256 password envelopes are salted, irreversible and checked without accepting malformed hashes", async () => {
    const [first, second] = await Promise.all([hashPassword(password), hashPassword(password)]);
    assert.match(first, /^pbkdf2-sha256\$600000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
    assert.notEqual(first, second); assert.ok(!first.includes(password));
    assert.equal(await verifyPassword(password, first), true);
    assert.equal(await verifyPassword("wrong", first), false);
    assert.equal(await verifyPassword(password, "sha256$bad"), false);
    assert.equal(await verifyPassword(password), false);
});

test("email length, normalization and password validation; credentials are terminal-only", () => {
    assert.equal(credentials({ username: "  USER@EXAMPLE.COM ", password }).username, "user@example.com");
    const email = `${"a".repeat(52)}@example.com`; assert.equal(email.length, 64);
    assert.equal(credentials({ username: email, password }).username, email);
    for (const input of [null, [], {}, { username: `a${email}`, password }, { username: "bad", password },
        { username: "user@example.com", password: "short" }, { username: "user@example.com", password: "p".repeat(129) }])
        assert.throws(() => credentials(input), { code: "AUTH_INVALID_INPUT" });
    assert.throws(() => loadConfig({ AUTH_DB_DRIVER: "mysql" }), /adapter/);
    assert.throws(() => loadConfig({ NODE_ENV: "production", AUTH_ENABLED: "false" }), /disabled/);
    assert.throws(() => loadConfig({ AUTH_SESSION_TTL_SECONDS: "0" }), /authentication/);
    assert.throws(() => loadConfig({ AUTH_DATABASE_URL: "mysql://localhost/db" }), /AUTH_DATABASE_URL/);
    assert.equal(loadConfig({ NODE_ENV: "production" }).auth.secureCookie, true);
    assert.equal(loadEnvironment({}, "absent-auth-env").AUTH_DATABASE_URL, undefined);
});

test("registration, login, cookie renewal, logout and expiration have persistent session semantics", async () => {
    const app = await setup();
    try {
        assert.equal((await app.request("/chat/sessions")).status, 401);
        assert.equal((await app.request("/auth/session")).headers.get("cache-control"), "no-store");
        const first = await app.register("ADMIN@example.com");
        assert.equal(first.user.role, "admin"); assert.equal(first.user.username, "admin@example.com");
        assert.match(first.user.userId, /^[a-f0-9]{64}$/);
        assert.ok(first.user.createdAt && first.user.loginAt); assert.equal(first.user.passwordHash, undefined);
        assert.match(first.response.headers.get("set-cookie"), /HttpOnly/);
        assert.match(first.response.headers.get("set-cookie"), /SameSite=Lax/);
        assert.equal((await app.request("/auth/register", { username: "admin@EXAMPLE.com", password })).status, 409);
        for (const username of ["admin@example.com", "missing@example.com"]) {
            const bad = await app.request("/auth/login", { username, password: "wrong password" });
            assert.equal(bad.status, 401); assert.equal((await bad.json() as any).error.code, "AUTH_INVALID_CREDENTIALS");
        }
        const oldLogin = new Date(0); app.store.users.get(first.user.userId)!.loginAt = oldLogin;
        const login = await app.request("/auth/login", { username: "admin@example.com", password }, first.cookie);
        assert.equal(login.status, 200);
        const current = login.headers.get("set-cookie")!.split(";")[0]!; assert.notEqual(current, first.cookie);
        assert.equal((await app.request("/chat/sessions", undefined, first.cookie)).status, 401);
        assert.ok(app.store.users.get(first.user.userId)!.loginAt! > oldLogin);
        const session = await app.request("/auth/session", undefined, current);
        assert.equal((await session.json() as any).data.user.userId, first.user.userId);
        // A new service instance shares the same database port, not a process-local token cache.
        assert.equal((await new AuthService(app.store, config.auth).current(current.split("=")[1]))?.userId, first.user.userId);
        const rawToken = current.split("=")[1]!;
        assert.ok(app.store.sessions.has(tokenHash(rawToken))); assert.ok(!app.store.sessions.has(rawToken));
        app.store.sessions.get(tokenHash(rawToken))!.expiresAt = new Date(0);
        assert.equal((await app.request("/chat/sessions", undefined, current)).status, 401);
        const loginAgain = await app.request("/auth/login", { username: "admin@example.com", password });
        const cookie = loginAgain.headers.get("set-cookie")!.split(";")[0]!;
        const logout = await app.request("/auth/logout", {}, cookie); assert.equal(logout.status, 200);
        assert.match(logout.headers.get("set-cookie")!, /Expires=Thu, 01 Jan 1970/);
        assert.equal((await app.request("/chat/sessions", undefined, cookie)).status, 401);
    } finally { await app.close(); }
});

test("user histories and agent memory are isolated; ordinary users cannot reach management", async () => {
    const app = await setup();
    try {
        const admin = await app.register("admin@example.com");
        const normal = await app.register("normal@example.com"); assert.equal(normal.user.role, "user");
        const created = await app.request("/chat/sessions", { title: "private" }, admin.cookie);
        const id = (await created.json() as any).data.id;
        assert.equal((await app.request(`/chat/sessions/${id}`, undefined, normal.cookie)).status, 404);
        assert.equal((await app.request(`/chat/sessions/${id}/messages`, { content: "hijack" }, normal.cookie)).status, 404);
        assert.deepEqual((await (await app.request("/chat/sessions", undefined, normal.cookie)).json() as any).data, []);
        assert.equal((await app.request(`/chat/sessions/${id}/messages`, { content: "private question" }, admin.cookie)).status, 200);
        assert.deepEqual(app.seen, [[admin.user.userId]]);
        for (const path of ["/mcp/servers", `/observability/sessions/${id}/runs`])
            assert.equal((await app.request(path, undefined, normal.cookie, { Authorization: "Bearer old-admin-token" })).status, 403);
        assert.equal((await app.request("/mcp/servers", undefined, admin.cookie)).status, 200);
        assert.equal((await app.repo.findAll())[0]?.ownerId, admin.user.userId);
    } finally { await app.close(); }
});

test("direct business URLs and forged headers cannot bypass session authentication", async () => {
    const app = await setup();
    try {
        const paths = ["/chat/sessions", "/math/questions", "/reading/questions", "/english/questions",
            "/mcp/servers", "/observability/sessions/missing/runs"];
        const forgeries = [
            { cookie: "", headers: {} },
            { cookie: `songjian_sso=${"0".repeat(64)}`, headers: {} },
            { cookie: "", headers: { Authorization: "Bearer forged-admin-token", "X-User-Id": "admin", "X-Role": "admin" } },
        ];
        for (const path of paths) {
            for (const forged of forgeries) {
                const response = await app.request(path, undefined, forged.cookie, forged.headers);
                assert.equal(response.status, 401, path);
                assert.equal((await response.json() as any).error.code, "AUTH_REQUIRED", path);
            }
        }
        const write = await app.request("/chat/sessions", { title: "bypass attempt" }, "", { Authorization: "Bearer forged-admin-token" });
        assert.equal(write.status, 401);
        assert.deepEqual(await app.repo.findAll(), [], "unauthenticated writes never reach the repository");
    } finally { await app.close(); }
});

test("cross-origin, missing custom header, non-JSON writes and repeated login attempts are rejected", async () => {
    const app = await setup();
    try {
        const body = { username: "user@example.com", password };
        for (const extra of [{ Origin: "https://evil.example" }, { "X-Requested-With": "" }, { "Sec-Fetch-Site": "cross-site" }])
            assert.equal((await app.request("/auth/register", body, "", extra)).status, 403);
        assert.equal((await app.request("/auth/login", body, "", { "Content-Type": "text/plain" })).status, 415);
        for (let i = 0; i < 20; i++) assert.equal((await app.request("/auth/login", {})).status, 400);
        const limited = await app.request("/auth/login", {}); assert.equal(limited.status, 429);
        assert.ok(Number(limited.headers.get("retry-after")) > 0);
    } finally { await app.close(); }
});
