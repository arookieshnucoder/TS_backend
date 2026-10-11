import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvironment } from "../src/config/environment.js";
import { loadConfig } from "../src/config/env.js";

test("backend env file restores port/origin but never supplies credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-env-"));
  const path = join(dir, ".env");
  try {
    await writeFile(path, [
      "PORT=8080", "FRONTEND_ORIGIN=http://localhost:3000", 'NODE_ENV="development"',
      "LLM_MODEL=deepseek-flash", "LLM_BASE_URL=https://api.deepseek.com",
      "LLM_API_KEY=file-key-must-be-ignored", "OPENAI_API_KEY=also-ignored",
      "INTERNAL_API_TOKEN=file-token-must-be-ignored",
    ].join("\n"));
    const env = loadEnvironment({}, path);
    const config = loadConfig(env);
    assert.equal(config.port, 8080);
    assert.equal(config.frontendOrigin, "http://localhost:3000");
    assert.equal(config.nodeEnv, "development");
    assert.equal(config.llmApiKey, undefined);
    assert.equal(config.internalApiToken, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    const terminal = { PORT: "8090", LLM_API_KEY: "terminal-key", INTERNAL_API_TOKEN: "terminal-token" };
    const overridden = loadConfig(loadEnvironment(terminal, path));
    assert.equal(overridden.port, 8090);
    assert.equal(overridden.llmApiKey, "terminal-key");
    assert.equal(overridden.internalApiToken, "terminal-token");
    assert.deepEqual(terminal, { PORT: "8090", LLM_API_KEY: "terminal-key", INTERNAL_API_TOKEN: "terminal-token" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing env file uses defaults; explicitly supplied config stays isolated", () => {
  assert.equal(loadConfig(loadEnvironment({}, join(tmpdir(), "absent-chat-env-file"))).port, 3000);
  assert.equal(loadConfig({}).port, 3000);
});
