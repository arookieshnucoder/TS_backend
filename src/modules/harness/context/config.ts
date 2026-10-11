export interface ContextConfig {
  maxInputTokens: number;
  chunkTokens: number;
  overlapRatio: number;
  compressionTrigger: number;
  compressionTarget: number;
  tokenizer: "cl100k_base" | "o200k_base";
  tokenSafetyFactor: number;
  maxToolSteps: number;
  elasticsearchUrl?: string;
  elasticsearchApiKey?: string;
  index: string;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingModel?: string;
  embeddingDimensions: number;
}

export function loadContextConfig(env: NodeJS.ProcessEnv): ContextConfig {
  function number(key: string, fallback: number, min: number, max: number, integer = false) {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
      throw new Error(`${key} must be ${min}..${max}${integer ? " (integer)" : ""}`);
    return value;
  }
  function url(key: string) {
    if (!env[key]) return undefined;
    const value = new URL(env[key]!);
    if (!["http:", "https:"].includes(value.protocol) || value.username || value.password || value.search || value.hash)
      throw new Error(`Invalid ${key}`);
    return value.toString().replace(/\/$/, "");
  }
  const tokenizer = env.CONTEXT_TOKENIZER ?? "cl100k_base";
  if (tokenizer !== "cl100k_base" && tokenizer !== "o200k_base") throw new Error("Invalid CONTEXT_TOKENIZER");
  const index = env.ELASTICSEARCH_INDEX ?? "chat-memory-v1";
  if (!/^[a-z][a-z0-9_-]{0,100}$/.test(index)) throw new Error("Invalid ELASTICSEARCH_INDEX");
  const embeddingBaseUrl = url("EMBEDDING_BASE_URL");
  if (!!embeddingBaseUrl !== !!env.EMBEDDING_MODEL) throw new Error("EMBEDDING_BASE_URL and EMBEDDING_MODEL must be configured together");
  return {
    maxInputTokens: number("LLM_MAX_INPUT_TOKENS", 32768, 2048, 2000000, true),
    chunkTokens: number("CONTEXT_CHUNK_TOKENS", 512, 128, 2048, true),
    // A middle chunk overlaps on both sides; their sum must not exceed 30%.
    overlapRatio: number("CONTEXT_OVERLAP_RATIO", .15, 0, .15),
    compressionTrigger: number("CONTEXT_COMPRESSION_TRIGGER", .65, .6, .7),
    compressionTarget: number("CONTEXT_COMPRESSION_TARGET", .08, .05, .1),
    tokenSafetyFactor: number("CONTEXT_TOKEN_SAFETY_FACTOR", 1.2, 1, 3),
    tokenizer, maxToolSteps: number("AGENT_MAX_TOOL_STEPS", 4, 1, 10, true),
    elasticsearchUrl: url("ELASTICSEARCH_URL"), elasticsearchApiKey: env.ELASTICSEARCH_API_KEY, index,
    embeddingBaseUrl, embeddingApiKey: env.EMBEDDING_API_KEY, embeddingModel: env.EMBEDDING_MODEL,
    embeddingDimensions: number("EMBEDDING_DIMENSIONS", 1536, 1, 4096, true),
  };
}
