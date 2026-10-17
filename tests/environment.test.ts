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
      "MCP_CONFIG_FILE=./data/custom-mcp.json", "MCP_TIMEOUT_MS=3000", "MCP_ADMIN_TOKEN=ignored-admin-key",
      "AGENT_MODEL_RETRIES=1", "AGENT_TOOL_RETRIES=0", "LLM_FALLBACK_MODEL=backup", "LLM_FALLBACK_API_KEY=ignored-fallback-key",
      "AGENT_TRACE_ENABLED=false", "AGENT_RUN_DATA_DIR=./data/custom-runs", "AGENT_TRACE_MAX_EVENTS=128",
      "ANSWER_REVIEW_ENABLED=false", "ANSWER_REVIEW_MODEL=glm-4.7", "ANSWER_REVIEW_TIMEOUT_MS=45000", "ANSWER_REVIEW_MAX_REVISIONS=2",
      "ANSWER_REVIEW_API_KEY=ignored-review-key",
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
    assert.equal(config.mcp?.configFile, "./data/custom-mcp.json");
    assert.equal(config.mcp?.timeoutMs, 3000);
    assert.equal(config.mcp?.adminToken, undefined);
    assert.equal(config.harness.recovery.modelRetries, 1);
    assert.equal(config.harness.recovery.toolRetries, 0);
    assert.equal(config.llmFallback?.model, "backup");
    assert.equal(config.llmFallback?.apiKey, undefined);
    assert.equal(config.observability?.enabled, false);
    assert.equal(config.observability?.dataDir, "./data/custom-runs");
    assert.equal(config.observability?.maxEvents, 128);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(config.verification.enabled, false);
    assert.equal(config.verification.model, "glm-4.7");
    assert.equal(config.verification.timeoutMs, 45000);
    assert.equal(config.verification.maxRevisions, 2);
    assert.equal(config.verification.apiKey, undefined);
    const terminal = { PORT: "8090", LLM_API_KEY: "terminal-key", INTERNAL_API_TOKEN: "terminal-token" };
    const overridden = loadConfig(loadEnvironment(terminal, path));
    assert.equal(overridden.port, 8090);
    assert.equal(overridden.llmApiKey, "terminal-key");
    assert.equal("internalApiToken" in overridden, false);
    assert.deepEqual(terminal, { PORT: "8090", LLM_API_KEY: "terminal-key", INTERNAL_API_TOKEN: "terminal-token" });
  } finally { // Keep test artifacts: repository policy forbids batch deletion.
  }
});

test("review configuration validates model, limits and credential isolation", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.llmModel, "glm-4.5-air"); assert.equal(defaults.verification.model, "glm-4.7");
  assert.equal(defaults.verification.enabled, true);
  assert.equal(loadConfig({ NODE_ENV: "test" }).verification.enabled, false);
  assert.equal(loadConfig({ LLM_API_KEY: "main-key" }).verification.apiKey, "main-key");
  assert.equal(loadConfig({ LLM_API_KEY: "main-key", ANSWER_REVIEW_API_KEY: "review-key" }).verification.apiKey, "review-key");
  for (const invalid of [{ ANSWER_REVIEW_ENABLED: "yes" }, { ANSWER_REVIEW_MODEL: "other-model" }, { ANSWER_REVIEW_TIMEOUT_MS: "0" },
    { ANSWER_REVIEW_MAX_REVISIONS: "3" }, { ANSWER_REVIEW_BASE_URL: "https://user:pass@example.com" }]) assert.throws(() => loadConfig(invalid), /review/i);
  assert.throws(() => loadConfig({ ANSWER_REVIEW_BASE_URL: "https://other.example.com", LLM_API_KEY: "main-key" }), /ANSWER_REVIEW_API_KEY/);
});

test("missing env file uses defaults; explicitly supplied config stays isolated", () => {
  assert.equal(loadConfig(loadEnvironment({}, join(tmpdir(), "absent-chat-env-file"))).port, 8080);
  assert.equal(loadConfig({}).port, 8080);
});
