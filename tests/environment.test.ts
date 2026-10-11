import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
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
      "LLM_MAX_INPUT_TOKENS=65536", "CONTEXT_CHUNK_TOKENS=1024",
      "AGENT_WORKSPACE_ENABLED=false", "AGENT_TOOL_TIMEOUT_MS=5000", "AGENT_MAX_CALLS_PER_STEP=2", "AGENT_TOOL_OUTPUT_TOKENS=512",
      "ELASTICSEARCH_API_KEY=ignored-index-key", "EMBEDDING_API_KEY=ignored-embedding-key",
    ].join("\n"));
    const env = loadEnvironment({}, path);
    const config = loadConfig(env);
    assert.equal(config.port, 8080);
    assert.equal(config.frontendOrigin, "http://localhost:3000");
    assert.equal(config.nodeEnv, "development");
    assert.equal(config.llmApiKey, undefined);
    assert.equal("internalApiToken" in config, false);
    assert.equal(config.context.maxInputTokens, 65536);
    assert.equal(config.context.chunkTokens, 1024);
    assert.equal(config.harness.workspaceRoot, undefined);
    assert.equal(config.harness.toolTimeoutMs, 5000);
    assert.equal(config.harness.maxCallsPerStep, 2);
    assert.equal(config.harness.toolOutputTokens, 512);
    assert.equal(config.context.elasticsearchApiKey, undefined);
    assert.equal(config.context.embeddingApiKey, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    const terminal = { PORT: "8090", LLM_API_KEY: "terminal-key", INTERNAL_API_TOKEN: "terminal-token" };
    const overridden = loadConfig(loadEnvironment(terminal, path));
    assert.equal(overridden.port, 8090);
    assert.equal(overridden.llmApiKey, "terminal-key");
    assert.equal("internalApiToken" in overridden, false);
    assert.deepEqual(terminal, { PORT: "8090", LLM_API_KEY: "terminal-key", INTERNAL_API_TOKEN: "terminal-token" });
  } finally { // Keep test artifacts: repository policy forbids batch deletion.
  }
});

test("missing env file uses defaults; explicitly supplied config stays isolated", () => {
  assert.equal(loadConfig(loadEnvironment({}, join(tmpdir(), "absent-chat-env-file"))).port, 8080);
  assert.equal(loadConfig({}).port, 8080);
});
