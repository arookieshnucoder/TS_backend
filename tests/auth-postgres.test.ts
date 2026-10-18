import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { PostgresAuthStore } from "../src/infrastructure/persistence/postgres/postgres-auth.store.js";
import { AuthService, tokenHash } from "../src/modules/auth/auth.service.js";
import { loadAuthConfig } from "../src/modules/auth/config.js";

test("real PostgreSQL: concurrent bootstrap, duplicate rollback, field constraints, restart, expiry and logout", {
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
        await Promise.all(stores.map(store => store.initialize()));
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
        // Removing accounts must never reopen automatic admin registration.
        await stores[0]!.pool.query("DELETE FROM auth_users");
        assert.equal((await restarted.register({ username: "later@example.com", password: "secure password" })).user.role, "user");
    } finally {
        await Promise.all(stores.map(store => store.close()));
        // Only the randomly generated schema owned by this test is removed.
        if (!/^auth_test_[a-f0-9]{16}$/.test(schema)) throw new Error("Invalid test schema");
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
    }
});
