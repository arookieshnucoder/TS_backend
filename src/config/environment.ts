import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const fileSettings = [
    "SOLUTION_SKILLS_ENABLED", "SOLUTION_SKILLS_DIR", "SOLUTION_SKILLS_EMBEDDING_BASE_URL",
	"PORT", "FRONTEND_ORIGIN", "NODE_ENV", "SESSION_DATA_DIR",
    "AUTH_ENABLED", "AUTH_DB_DRIVER", "AUTH_COOKIE_SECURE", "AUTH_SESSION_TTL_SECONDS",
	"LLM_BASE_URL", "LLM_MODEL", "LLM_TIMEOUT_MS",
	"LLM_MAX_INPUT_TOKENS", "CONTEXT_CHUNK_TOKENS", "CONTEXT_OVERLAP_RATIO",
	"CONTEXT_COMPRESSION_TRIGGER", "CONTEXT_COMPRESSION_TARGET", "CONTEXT_TOKENIZER",
	"CONTEXT_TOKEN_SAFETY_FACTOR", "AGENT_MAX_TOOL_STEPS", "ELASTICSEARCH_URL",
	"ELASTICSEARCH_INDEX", "EMBEDDING_BASE_URL", "EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS",
	"AGENT_WORKSPACE_ENABLED", "AGENT_WORKSPACE_ROOT", "AGENT_MAX_CALLS_PER_STEP", "AGENT_TOOL_TIMEOUT_MS", "AGENT_TOOL_OUTPUT_TOKENS",
    "AGENT_PROTOCOL_REPAIRS", "AGENT_MAX_MCP_TOOLS",
	"MCP_CONFIG_FILE", "MCP_TIMEOUT_MS",
	"LLM_FALLBACK_MODEL", "LLM_FALLBACK_BASE_URL", "AGENT_MODEL_RETRIES", "AGENT_TOOL_RETRIES",
	"AGENT_RETRY_BASE_DELAY_MS", "AGENT_RETRY_MAX_DELAY_MS", "AGENT_MODEL_ATTEMPT_TIMEOUT_MS",
	"AGENT_TRACE_ENABLED", "AGENT_RUN_DATA_DIR", "AGENT_TRACE_MAX_EVENTS",
    "MATH_AGENT_VARIANT", "MATH_CORPUS_PATH", "MATH_INDEX_PATH", "MATH_SUBMISSIONS_PATH", "MATH_EMBEDDING_BASE_URL", "GLM_THINKING",
    "SCHOOL_SUBJECT", "READING_AGENT_VARIANT", "READING_CORPUS_PATH", "READING_CONTEXT_TOKENS",
    "ENGLISH_AGENT_VARIANT", "ENGLISH_CORPUS_PATH", "ENGLISH_CONTEXT_TOKENS", "ENGLISH_WORKFLOW", "ENGLISH_THINKING",
    "ANSWER_REVIEW_ENABLED", "ANSWER_REVIEW_MODEL", "ANSWER_REVIEW_BASE_URL", "ANSWER_REVIEW_TIMEOUT_MS", "ANSWER_REVIEW_MAX_REVISIONS", "ANSWER_REVIEW_THINKING",
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
