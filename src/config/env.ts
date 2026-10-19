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
import { READING_VARIANTS, type ReadingVariant } from "../modules/reading/contracts.js";
import { ENGLISH_VARIANTS, type EnglishVariant } from "../modules/english/contracts.js";
import type { SchoolSubject } from "../modules/subjects/contracts.js";
import { loadAuthConfig, type AuthConfig } from "../modules/auth/config.js";


/**
 * 配置相关环境变量
 * 但是不建议自己的大模型ApiKey放在里面，这个自己做终端的环境变量来管理更安全。
 */
export interface AppConfig {
    skills: { enabled: boolean; directory: string; databaseUrl?: string; embeddingBaseUrl: string; embeddingApiKey?: string };
    auth: AuthConfig;
    verification: { enabled: boolean; model: string; baseUrl: string; apiKey?: string; timeoutMs: number; maxRevisions: number };
    schoolSubject: SchoolSubject | "auto";
    english: { variant: EnglishVariant; corpusPath: string; contextTokens: number; workflow: "direct" | "grounded"; thinking: "enabled" | "disabled" };
    reading: { variant: ReadingVariant; corpusPath: string; contextTokens: number };
    math: { variant: MathVariant | "general"; corpusPath: string; indexPath: string; submissionsPath: string; embeddingBaseUrl: string; thinking: "enabled" | "disabled" };
    observability: { enabled: boolean; dataDir: string; maxEvents: number };
    llmFallback?: { model: string; baseUrl?: string; apiKey?: string };
    mcp: { configFile: string; adminToken?: string; timeoutMs: number };
    harness: HarnessConfig;
    context: ContextConfig;
    // 会话 JSON 文件的保存目录
    sessionDataDir: string;
    llmApiKey?: string;
    llmModel: string;
    llmTimeoutMs: number;
    llmBaseUrl?: string;
    port: number;
    // 允许跨域访问的前端来源（协议、主机及端口）
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
    // 未配置时允许本机 3000 端口，可通过环境变量指定其他 HTTP(S) 来源。
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
    const skillsEnabled = env.SOLUTION_SKILLS_ENABLED ?? (nodeEnv === "test" ? "false" : "true");
    if (!["true", "false"].includes(skillsEnabled)) throw new Error("Invalid SOLUTION_SKILLS_ENABLED");
    const skillsDatabaseUrl = env.SOLUTION_SKILLS_DATABASE_URL ?? env.AUTH_DATABASE_URL;
    if (env.SOLUTION_SKILLS_DATABASE_URL) {
        let url: URL;
        try { url = new URL(env.SOLUTION_SKILLS_DATABASE_URL); } catch { throw new Error("Invalid SOLUTION_SKILLS_DATABASE_URL"); }
        if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error("Invalid SOLUTION_SKILLS_DATABASE_URL");
    }
    // 数学代理变体，默认为 general 或 adaptive
    const mathVariant = env.MATH_AGENT_VARIANT ?? (nodeEnv === "test" ? "general" : "adaptive");
    if (!["general", ...ALL_MATH_VARIANTS].includes(mathVariant)) throw new Error("Invalid MATH_AGENT_VARIANT");
    const schoolSubject = env.SCHOOL_SUBJECT ?? "math";
    const readingVariant = env.READING_AGENT_VARIANT ?? "adaptive";
    const readingContextTokens = Number(env.READING_CONTEXT_TOKENS ?? "1400");
    if (!["math", "chinese", "english", "auto"].includes(schoolSubject) || !READING_VARIANTS.includes(readingVariant as ReadingVariant) ||
        !Number.isSafeInteger(readingContextTokens) || readingContextTokens < 256 || readingContextTokens > 6000) throw new Error("Invalid reading configuration");
    const thinking = env.GLM_THINKING ?? "disabled";
    const englishVariant = env.ENGLISH_AGENT_VARIANT ?? "adaptive", englishContextTokens = Number(env.ENGLISH_CONTEXT_TOKENS ?? "1800");
    const englishWorkflow = env.ENGLISH_WORKFLOW ?? "grounded";
    const englishThinking = env.ENGLISH_THINKING ?? "disabled";
    if (!["enabled", "disabled"].includes(englishThinking) || !["direct", "grounded"].includes(englishWorkflow) || !ENGLISH_VARIANTS.includes(englishVariant as EnglishVariant) || !Number.isSafeInteger(englishContextTokens) || englishContextTokens < 256 || englishContextTokens > 6000)
        throw new Error("Invalid English configuration");
    if (!["enabled", "disabled"].includes(thinking)) throw new Error("Invalid GLM_THINKING");
    const mathEmbeddingUrl = env.MATH_EMBEDDING_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
    const mathUrl = new URL(mathEmbeddingUrl);
    if (mathUrl.protocol !== "https:" || mathUrl.username || mathUrl.password || mathUrl.search || mathUrl.hash) throw new Error("Invalid MATH_EMBEDDING_BASE_URL");
    // 主解题和独立核验使用各自配置的 GLM 模型。
    const llmBaseUrl = env.LLM_BASE_URL ?? (mathVariant === "general" ? "https://api.deepseek.com" : "https://open.bigmodel.cn/api/paas/v4");
    const llmTimeoutMs = Number(env.LLM_TIMEOUT_MS ?? "120000");
    if (!Number.isInteger(llmTimeoutMs) || llmTimeoutMs < 1 || llmTimeoutMs > 600000) throw new Error("LLM_TIMEOUT_MS must be 1..600000");
    if (llmBaseUrl) {
        const url = new URL(llmBaseUrl);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid LLM_BASE_URL");
    }
    const llmModel = env.LLM_MODEL ?? (mathVariant === "general" ? "deepseek-flash" : "glm-4.5-air");
    const skillEmbeddingBase = env.SOLUTION_SKILLS_EMBEDDING_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
    const skillEmbeddingUrl = new URL(skillEmbeddingBase);
    if (skillEmbeddingUrl.protocol !== "https:" || skillEmbeddingUrl.username || skillEmbeddingUrl.password || skillEmbeddingUrl.search || skillEmbeddingUrl.hash)
        throw new Error("Invalid SOLUTION_SKILLS_EMBEDDING_BASE_URL");
    const reviewEnabled = env.ANSWER_REVIEW_ENABLED ?? (nodeEnv !== "test" && /^glm-/i.test(llmModel) ? "true" : "false");
    const reviewModel = env.ANSWER_REVIEW_MODEL ?? "glm-4.7";
    const reviewBaseUrl = env.ANSWER_REVIEW_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
    const reviewTimeoutMs = Number(env.ANSWER_REVIEW_TIMEOUT_MS ?? "120000");
    const maxRevisions = Number(env.ANSWER_REVIEW_MAX_REVISIONS ?? "1");
    const reviewUrl = new URL(reviewBaseUrl);
    if (!["true", "false"].includes(reviewEnabled) || !/^glm-[a-z0-9.-]+$/i.test(reviewModel) ||
        !["http:", "https:"].includes(reviewUrl.protocol) || reviewUrl.username || reviewUrl.password || reviewUrl.search || reviewUrl.hash ||
        !Number.isInteger(reviewTimeoutMs) || reviewTimeoutMs < 1 || reviewTimeoutMs > 600000 ||
        !Number.isInteger(maxRevisions) || maxRevisions < 0 || maxRevisions > 2) throw new Error("Invalid answer review configuration");
    if (reviewEnabled === "true" && reviewBaseUrl.replace(/\/$/, "") !== llmBaseUrl.replace(/\/$/, "") && !env.ANSWER_REVIEW_API_KEY)
        throw new Error("A different review endpoint requires ANSWER_REVIEW_API_KEY");
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
        skills: { enabled: skillsEnabled === "true", databaseUrl: skillsDatabaseUrl,
            embeddingBaseUrl: skillEmbeddingBase, embeddingApiKey: env.SOLUTION_SKILLS_EMBEDDING_API_KEY ?? env.EMBEDDING_API_KEY ??
                (skillEmbeddingBase.replace(/\/$/, "") === llmBaseUrl.replace(/\/$/, "") ? env.LLM_API_KEY : undefined),
            directory: env.SOLUTION_SKILLS_DIR ?? fileURLToPath(new URL("../../data/solution-skills", import.meta.url)) },
        auth: loadAuthConfig(env),
        verification: { enabled: reviewEnabled === "true", model: reviewModel, baseUrl: reviewBaseUrl,
            apiKey: env.ANSWER_REVIEW_API_KEY || env.LLM_API_KEY, timeoutMs: reviewTimeoutMs, maxRevisions },
        schoolSubject: schoolSubject as AppConfig["schoolSubject"],
        english: { variant: englishVariant as EnglishVariant, contextTokens: englishContextTokens, workflow: englishWorkflow as "direct" | "grounded", thinking: englishThinking as "enabled" | "disabled",
            corpusPath: env.ENGLISH_CORPUS_PATH ?? fileURLToPath(new URL("../../evals/english/corpus.json", import.meta.url)) },
        reading: { variant: readingVariant as ReadingVariant, contextTokens: readingContextTokens,
            corpusPath: env.READING_CORPUS_PATH ?? fileURLToPath(new URL("../../evals/chinese/corpus.json", import.meta.url)) },
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
        llmModel, llmBaseUrl, llmTimeoutMs
    };
}
