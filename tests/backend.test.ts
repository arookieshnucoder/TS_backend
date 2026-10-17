import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createDependencies, type AppDependencies } from "../src/bootstrap/container.js";
import { loadConfig } from "../src/config/env.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";

const silentLogger = { info() {}, error() {} };

async function withApp(
  run: (baseUrl: string) => Promise<void>,
  overrides: Partial<AppDependencies> = {}
) {
  const app = createApp(loadConfig({ NODE_ENV: "test" }), createDependencies({ logger: silentLogger, chatSessionRepository: new InMemoryChatSessionRepository(), ...overrides }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("health returns its HTTP status code with request IDs and configured CORS", async () => {
  await withApp(async base => {
    const response = await fetch(`${base}/api/health`, { headers: { Origin: "http://localhost:3000" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { httpStatusCode: 200 });
    assert.match(response.headers.get("x-request-id")!, /^\d{17,19}$/);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal(response.headers.get("x-powered-by"), null);
  });
});

test("session create/list/get passes through controller, service and repository", async () => {
  await withApp(async base => {
    const created = await fetch(`${base}/api/chat/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "  TS learning  " })
    });
    assert.equal(created.status, 201);
    const { data } = await created.json() as { data: { id: string; title: string; createdAt: string } };
    assert.equal(data.title, "TS learning");
    assert.ok(Number.isFinite(Date.parse(data.createdAt)));
    assert.equal(created.headers.get("location"), `/api/chat/sessions/${data.id}`);
    const fetched = await fetch(`${base}/api/chat/sessions/${data.id}`);
    assert.deepEqual(await fetched.json(), { data });
    const list = await fetch(`${base}/api/chat/sessions`);
    assert.deepEqual(await list.json(), { data: [data] });
  });
});

test("invalid DTO, malformed JSON and oversized body use structured errors", async () => {
  await withApp(async base => {
    for (const body of [{}, [], { title: "" }, { title: 5 }, { title: " ".repeat(3) }, { title: "x".repeat(101) }]) {
      const response = await fetch(`${base}/api/chat/sessions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      assert.equal(response.status, 400);
      const result = await response.json() as { error: { code: string }; requestId: string };
      assert.equal(result.error.code, "VALIDATION_ERROR");
      assert.equal(result.requestId, response.headers.get("x-request-id"));
    }
    for (const [body, status, code] of [
      ["{broken", 400, "INVALID_JSON"],
      [JSON.stringify({ title: "x".repeat(1024 * 1024) }), 413, "PAYLOAD_TOO_LARGE"]
    ] as const) {
      const response = await fetch(`${base}/api/chat/sessions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body
      });
      assert.equal(response.status, status);
      assert.equal((await response.json() as { error: { code: string } }).error.code, code);
    }
  });
});

test("unknown routes and absent sessions return distinct 404 error codes", async () => {
  await withApp(async base => {
    for (const [path, code] of [["/missing", "ROUTE_NOT_FOUND"], ["/api/chat/sessions/missing", "SESSION_NOT_FOUND"]]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 404);
      assert.equal((await response.json() as { error: { code: string } }).error.code, code);
    }
  });
});

test("async repository failures produce a safe 500 response", async () => {
  await withApp(async base => {
    const response = await fetch(`${base}/api/chat/sessions`);
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.match(body, /INTERNAL_ERROR/);
    assert.doesNotMatch(body, /private-database-password/);
  }, {
    chatSessionRepository: {
      async save() {},
      async findById() { return null; },
      async findAll() { throw new Error("private-database-password"); }
    }
  });
});

test("memory repository does not leak mutable entities", async () => {
  const repository = new InMemoryChatSessionRepository();
  const entity = { id: "a", requestId: "request-a", title: "Original", createdAt: new Date(), updatedAt: new Date(), messages: [], sessionStatus: "finished" as const, sessionError: null };
  await repository.save(entity);
  entity.title = "Changed outside";
  const stored = await repository.findById("a");
  assert.equal(stored?.title, "Original");
  stored!.title = "Changed again";
  assert.equal((await repository.findAll())[0]?.title, "Original");
  assert.deepEqual(await new InMemoryChatSessionRepository().findAll(), []);
});

test("configuration has defaults and rejects invalid deployment values", () => {
  assert.equal(loadConfig({}).port, 8080);
  assert.equal(loadConfig({}).llmModel, "glm-4.5-air");
  assert.equal(loadConfig({}).llmBaseUrl, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(loadConfig({ MATH_AGENT_VARIANT: "general" }).llmModel, "deepseek-flash");
  assert.equal(loadConfig({}).math.variant, "adaptive");
  assert.equal(loadConfig({ OPENAI_API_KEY: "ignored" }).llmApiKey, undefined);
  assert.throws(() => loadConfig({ LLM_TIMEOUT_MS: "0" }), /LLM_TIMEOUT_MS/);
  assert.equal(loadConfig({ PORT: "8080" }).port, 8080);
  for (const port of ["0", "-1", "65536", "3.5", "abc", ""]) {
    assert.throws(() => loadConfig({ PORT: port }), /PORT/);
  }
  assert.throws(() => loadConfig({ FRONTEND_ORIGIN: "file:///tmp" }), /FRONTEND_ORIGIN/);
  assert.throws(() => loadConfig({ FRONTEND_ORIGIN: "http://localhost:3000/path" }), /FRONTEND_ORIGIN/);
  assert.throws(() => loadConfig({ NODE_ENV: "unknown" }), /NODE_ENV/);
});
