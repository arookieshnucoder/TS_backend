import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const fileSettings = [
  "PORT", "FRONTEND_ORIGIN", "NODE_ENV", "SESSION_DATA_DIR",
  "LLM_BASE_URL", "LLM_MODEL", "LLM_TIMEOUT_MS",
  "LLM_MAX_INPUT_TOKENS", "CONTEXT_CHUNK_TOKENS", "CONTEXT_OVERLAP_RATIO",
  "CONTEXT_COMPRESSION_TRIGGER", "CONTEXT_COMPRESSION_TARGET", "CONTEXT_TOKENIZER",
  "CONTEXT_TOKEN_SAFETY_FACTOR", "AGENT_MAX_TOOL_STEPS", "ELASTICSEARCH_URL",
  "ELASTICSEARCH_INDEX", "EMBEDDING_BASE_URL", "EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS",
] as const;

// Load only non-secret settings. Credentials are inherited from the launching terminal.
export function loadEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  path = fileURLToPath(new URL("../../.env", import.meta.url))
): NodeJS.ProcessEnv {
  let parsed: Record<string, string | undefined> = {};
  try {
    parsed = parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const settings: NodeJS.ProcessEnv = {};
  for (const key of fileSettings) {
    if (parsed[key] !== undefined) settings[key] = parsed[key];
  }
  return { ...settings, ...environment };
}
