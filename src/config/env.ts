/**
 * 项目的基本环境配置，包括端口、前端监听地址、开发环境等。
 */

import { fileURLToPath } from "node:url";
import { join, dirname, basename } from "node:path";
import { loadEnvironment } from "./environment.js";
import { loadContextConfig, type ContextConfig } from "../modules/harness/context/config.js";
import { loadHarnessConfig, type HarnessConfig } from "../modules/harness/config.js";
import type { MathVariant } from "../modules/math/contracts.js";
import { ALL_MATH_VARIANTS } from "../modules/math/contracts.js";


/**
 * 配置相关环境变量
 * 但是不建议自己的大模型ApiKey放在里面，这个自己做终端的环境变量来管理更安全。
 */
export interface AppConfig {
    math: { variant: MathVariant | "general"; corpusPath: string; indexPath: string; submissionsPath: string; embeddingBaseUrl: string; thinking: "enabled" | "disabled" };
    observability: { enabled: boolean; dataDir: string; maxEvents: number };
    llmFallback?: { model: string; baseUrl?: string; apiKey?: string };
    mcp: { configFile: string; adminToken?: string; timeoutMs: number };
    harness: HarnessConfig;
    context: ContextConfig;
    // 后端端口
    sessionDataDir: string;
    llmApiKey?: string;
    llmModel: string;
    llmTimeoutMs: number;
    llmBaseUrl?: string;
    port: number;
    // 前端监听端口
    frontendOrigin: string;
    // 开发环境
    nodeEnv: "development" | "test" | "production";
    // 接口超时时间
    shutdownTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = loadEnvironment()): AppConfig {
    // 后端默认占用8080端口
    const rawPort = env.PORT ?? "8080";
    const port = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("PORT must be an integer between 1 and 65535");
    }
    // 本地默认只能用3000端口作为前端origin
    const frontendOrigin = env.FRONTEND_ORIGIN ?? "http://localhost:3000";
    let origin: URL;
    try {
        origin = new URL(frontendOrigin);
    } catch {
        throw new Error("FRONTEND_ORIGIN must be an HTTP(S) origin");
    }
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== frontendOrigin) {
        throw new Error("FRONTEND_ORIGIN must be an HTTP(S) origin without a path");
    }
    // 开发环境，默认为 development
    const nodeEnv = env.NODE_ENV ?? "development";
    if (nodeEnv !== "development" && nodeEnv !== "test" && nodeEnv !== "production") {
        throw new Error("NODE_ENV must be development, test or production");
    }
    // 数学代理变体，默认为 general 或 adaptive
    const mathVariant = env.MATH_AGENT_VARIANT ?? (nodeEnv === "test" ? "general" : "adaptive");
    if (!["general", ...ALL_MATH_VARIANTS].includes(mathVariant)) throw new Error("Invalid MATH_AGENT_VARIANT");
    const thinking = env.GLM_THINKING ?? "disabled";
    if (!["enabled", "disabled"].includes(thinking)) throw new Error("Invalid GLM_THINKING");
    const mathEmbeddingUrl = env.MATH_EMBEDDING_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
    const mathUrl = new URL(mathEmbeddingUrl);
    if (mathUrl.protocol !== "https:" || mathUrl.username || mathUrl.password || mathUrl.search || mathUrl.hash) throw new Error("Invalid MATH_EMBEDDING_BASE_URL");
    // LLM相关配置, 默认DS-flash
    const llmBaseUrl = env.LLM_BASE_URL ?? (mathVariant === "general" ? "https://api.deepseek.com" : "https://open.bigmodel.cn/api/paas/v4");
    const llmTimeoutMs = Number(env.LLM_TIMEOUT_MS ?? "120000");
    if (!Number.isInteger(llmTimeoutMs) || llmTimeoutMs < 1 || llmTimeoutMs > 600000) throw new Error("LLM_TIMEOUT_MS must be 1..600000");
    if (llmBaseUrl) {
        const url = new URL(llmBaseUrl);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid LLM_BASE_URL");
    }
    const sessionDataDir = env.SESSION_DATA_DIR ?? fileURLToPath(new URL("../../data/sessions/", import.meta.url));
    const traceEnabled = env.AGENT_TRACE_ENABLED ?? "true";
    const maxEvents = Number(env.AGENT_TRACE_MAX_EVENTS ?? "512");
    if (!["true", "false"].includes(traceEnabled) || !Number.isInteger(maxEvents) || maxEvents < 2 || maxEvents > 1024) throw new Error("Invalid agent trace settings");
    const mcpTimeout = Number(env.MCP_TIMEOUT_MS ?? "10000");
    if (!Number.isInteger(mcpTimeout) || mcpTimeout < 1 || mcpTimeout > 120000) throw new Error("MCP_TIMEOUT_MS must be 1..120000");
    let llmFallback: AppConfig["llmFallback"];
    if (env.LLM_FALLBACK_MODEL !== undefined && env.LLM_FALLBACK_MODEL !== "") {
        if (!env.LLM_FALLBACK_MODEL.trim()) throw new Error("LLM_FALLBACK_MODEL must be non-empty");
        const baseUrl = env.LLM_FALLBACK_BASE_URL || llmBaseUrl;
        const url = new URL(baseUrl);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid LLM_FALLBACK_BASE_URL");
        if (baseUrl !== llmBaseUrl && !env.LLM_FALLBACK_API_KEY) throw new Error("A different fallback endpoint requires LLM_FALLBACK_API_KEY");
        llmFallback = { model: env.LLM_FALLBACK_MODEL, baseUrl, apiKey: env.LLM_FALLBACK_API_KEY || env.LLM_API_KEY };
    } else if (env.LLM_FALLBACK_BASE_URL || env.LLM_FALLBACK_API_KEY) throw new Error("Fallback settings require LLM_FALLBACK_MODEL");
    return {
        math: { variant: mathVariant as MathVariant | "general", thinking: thinking as "enabled" | "disabled", embeddingBaseUrl: mathEmbeddingUrl,
            corpusPath: env.MATH_CORPUS_PATH ?? fileURLToPath(new URL("../../evals/math/corpus.json", import.meta.url)),
            indexPath: env.MATH_INDEX_PATH ?? fileURLToPath(new URL("../../data/math/index.json", import.meta.url)),
            submissionsPath: env.MATH_SUBMISSIONS_PATH ?? fileURLToPath(new URL("../../data/math/submissions", import.meta.url)) },
        observability: { enabled: traceEnabled === "true", dataDir: env.AGENT_RUN_DATA_DIR ?? join(dirname(sessionDataDir), `${basename(sessionDataDir)}-runs`), maxEvents },
        llmFallback,
        mcp: { configFile: env.MCP_CONFIG_FILE ?? join(dirname(sessionDataDir), "mcp-servers.json"), adminToken: env.MCP_ADMIN_TOKEN || undefined, timeoutMs: mcpTimeout },
        port, frontendOrigin, nodeEnv, shutdownTimeoutMs: 5000, context: loadContextConfig(env), harness: loadHarnessConfig(env),
        sessionDataDir,
        llmApiKey: env.LLM_API_KEY,
        llmModel: env.LLM_MODEL ?? (mathVariant === "general" ? "deepseek-flash" : "glm-4.6v"), llmBaseUrl, llmTimeoutMs
    };
}
