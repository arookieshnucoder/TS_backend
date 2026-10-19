import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { PostgresAuthStore } from "../src/infrastructure/persistence/postgres/postgres-auth.store.js";
import { AuthService, tokenHash } from "../src/modules/auth/auth.service.js";
import { loadAuthConfig } from "../src/modules/auth/config.js";

test("real PostgreSQL: legacy cleanup, concurrent first registration, rollback, restart, expiry and logout", {
    skip: !process.env.AUTH_TEST_DATABASE_URL,
}, async () => {
    const connectionString = process.env.AUTH_TEST_DATABASE_URL!;
    const admin = new Pool({ connectionString });
    const schema = `auth_test_${randomBytes(8).toString("hex")}`;
    const url = new URL(connectionString); url.searchParams.set("options", `-c search_path=${schema}`);
    const config = loadAuthConfig({ NODE_ENV: "test", AUTH_ENABLED: "true" });
    let stores: PostgresAuthStore[] = [];
    try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        stores = [new PostgresAuthStore(url.toString()), new PostgresAuthStore(url.toString())];
        // 模拟旧版本遗留表；初始化应直接移除，不再读取它的状态。
        await stores[0]!.pool.query("CREATE TABLE auth_bootstrap (id INTEGER PRIMARY KEY, claimed BOOLEAN NOT NULL); INSERT INTO auth_bootstrap VALUES (1, TRUE)");
        await Promise.all(stores.map(store => store.initialize()));
        assert.equal((await stores[0]!.pool.query("SELECT to_regclass('auth_bootstrap') AS legacy")).rows[0].legacy, null);
        const now = new Date();
        await assert.rejects(stores[0]!.register({ userId: randomBytes(32).toString("hex"), username: "rollback@example.com", passwordHash: "unused",
            createdAt: now, loginAt: now }, { userId: randomBytes(32).toString("hex"), tokenHash: randomBytes(32).toString("hex"),
            createdAt: now, expiresAt: new Date(now.getTime() + 60000) }), { code: "23503" });
        assert.equal((await stores[0]!.pool.query("SELECT COUNT(*) FROM auth_users")).rows[0].count, "0");
        const services = stores.map(store => new AuthService(store, config));
        const results = await Promise.all(Array.from({ length: 6 }, (_, i) => services[i % 2]!.register({ username: `user${i}@example.com`, password: "secure password" })));
        assert.equal(results.filter(r => r.user.role === "admin").length, 1);
        assert.equal(results.filter(r => r.user.role === "user").length, 5);
        const duplicates = await Promise.allSettled(services.map(service => service.register({ username: "duplicate@example.com", password: "secure password" })));
        assert.equal(duplicates.filter(r => r.status === "fulfilled").length, 1);
        const failed = duplicates.find(r => r.status === "rejected") as PromiseRejectedResult;
        assert.equal(failed.reason.code, "AUTH_EMAIL_EXISTS");
        const { rows } = await stores[0]!.pool.query("SELECT * FROM auth_users ORDER BY created_at");
        assert.equal(rows.length, 7);
        assert.equal(rows.filter(row => row.role === "admin").length, 1);
        assert.match(rows[0].password_hash, /^pbkdf2-sha256\$600000\$/); assert.equal(rows[0].user_id.length, 64);
        await assert.rejects(stores[0]!.pool.query("UPDATE auth_users SET username = $1 WHERE user_id = $2", ["a".repeat(65), rows[0].user_id]), { code: "22001" });
        const sessions = await stores[0]!.pool.query("SELECT * FROM auth_sessions");
        assert.equal(sessions.rows.length, 7, "failed registrations roll back their session");
        assert.ok(sessions.rows.every(row => results.every(result => result.token !== row.token_hash)));
        const saved = results[0]!;
        await Promise.all(stores.map(store => store.close())); stores = [new PostgresAuthStore(url.toString())];
        const restarted = new AuthService(stores[0]!, config);
        assert.equal((await restarted.current(saved.token))?.userId, saved.user.userId);
        const loggedIn = await restarted.login({ username: saved.user.username, password: "secure password" }, saved.token);
        assert.equal(await restarted.current(saved.token), null);
        assert.ok(loggedIn.user.loginAt!.getTime() >= saved.user.loginAt!.getTime());
        await stores[0]!.pool.query("UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [tokenHash(loggedIn.token)]);
        assert.equal(await restarted.current(loggedIn.token), null);
        const again = await restarted.login({ username: saved.user.username, password: "secure password" });
        await restarted.logout(again.token); assert.equal(await restarted.current(again.token), null);
        // 仅删除管理员而保留其他用户时，新注册仍是普通用户。
        await stores[0]!.pool.query("DELETE FROM auth_users WHERE role = 'admin'");
        assert.equal((await restarted.register({ username: "remaining@example.com", password: "secure password" })).user.role, "user");
        // 用户表清空后，下一次成功注册重新成为首个管理员。
        await stores[0]!.pool.query("DELETE FROM auth_users");
        assert.equal((await restarted.register({ username: "later@example.com", password: "secure password" })).user.role, "admin");
        assert.equal((await restarted.register({ username: "next@example.com", password: "secure password" })).user.role, "user");
    } finally {
        await Promise.all(stores.map(store => store.close()));
        // Only the randomly generated schema owned by this test is removed.
        if (!/^auth_test_[a-f0-9]{16}$/.test(schema)) throw new Error("Invalid test schema");
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
    }
});
