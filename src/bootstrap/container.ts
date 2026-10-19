import { errorContainer, type ErrorContainer } from "../common/errors/error-container.js";
import { JsonChatSessionRepository } from "../infrastructure/persistence/json/json-chat-session.repository.js";
import { LangChainChatModel } from "../infrastructure/llm/langchain-chat-model.js";
import type { ChatSessionRepository } from "../modules/chat/repository/chat-session.repository.js";
import type { AgentModel, LlmConfig } from "../modules/agent/model.js";
import { loadConfig, type AppConfig } from "../config/env.js";
import { logger, type Logger } from "../common/logging/logger.js";
import type { ChatAgent } from "../modules/chat/service/chat-agent.js";
import { createChatAgent } from "./chat-agent.js";
import { TokenBudget } from "../modules/harness/context/tokens.js";
import { LocalMemorySearch, ElasticsearchMemorySearch } from "../infrastructure/llm/memory-search.js";
import { McpManager } from "../modules/mcp/mcp-manager.js";
import type { NamedAgentModel } from "../modules/harness/recovery.js";
import { RunTraceStore } from "../modules/observability/run-trace.js";
import { createMathChatAgent } from "./math-chat-agent.js";
import { GlmModel, GlmEmbeddings } from "../infrastructure/llm/glm-model.js";
import type { MathOcrProvider } from "../modules/math/contracts.js";
import { ReadingLibrary } from "../modules/reading/library.js";
import { createReadingChatAgent } from "./reading-chat-agent.js";
import { routeSchoolSubject } from "./school-subject.js";
import { withAnswerReview, mathReviewEvidence } from "./answer-review.js";
import { EnglishLibrary } from "../modules/english/library.js";
import { createEnglishChatAgent } from "./english-chat-agent.js";
import { AuthService } from "../modules/auth/auth.service.js";
import type { AuthStore } from "../modules/auth/contracts.js";
import { PostgresAuthStore } from "../infrastructure/persistence/postgres/postgres-auth.store.js";
import { IdentityChatSessionRepository } from "../infrastructure/persistence/identity-chat-session.repository.js";
import { PostgresSkillStore } from "../infrastructure/persistence/postgres/postgres-skill.store.js";
import { SolutionSkillLibrary } from "../modules/harness/skills/library.js";
import { withSolutionSkills } from "./solution-skills.js";


/** 应用启动后共享的依赖集合；学科题库按需加载，会话服务只依赖 ChatAgent 接口。 */
export interface AppDependencies {
    solutionSkills?: SolutionSkillLibrary;
    auth?: AuthService;
    englishLibrary?: EnglishLibrary;
    readingLibrary?: ReadingLibrary;
    mathOcr?: MathOcrProvider;
    runs?: RunTraceStore;
    mcp: McpManager;
    errors: ErrorContainer;
    chatSessionRepository: ChatSessionRepository;
    logger: Logger;
    agentHarness: ChatAgent;
}


export type DependencyOverrides = Partial<AppDependencies> & { authStore?: AuthStore; agentModel?: AgentModel; reviewerModel?: AgentModel; fallbackModels?: NamedAgentModel[] };

/** 主模型与备用模型采用同一供应商选择规则，GLM 不会在降级时丢失推理协议字段。 */
function createModel(provider: LlmConfig, thinking: "enabled" | "disabled", errors: ErrorContainer): AgentModel {
    return /^glm-/i.test(provider.llmModel) ? new GlmModel(provider, thinking) : new LangChainChatModel(provider, errors);
}

export function createDependencies(overrides: DependencyOverrides = {}, config: AppConfig = loadConfig()): AppDependencies {
    const allowed = new Set(["solutionSkills", "auth", "authStore", "errors", "chatSessionRepository", "logger", "agentHarness", "agentModel", "reviewerModel", "mcp", "fallbackModels", "runs", "mathOcr", "readingLibrary", "englishLibrary"]);
    for (const key of Object.keys(overrides)) {
        if (!allowed.has(key)) throw new TypeError(`Unsupported dependency override: ${key}`);
        if (overrides[key as keyof DependencyOverrides] == null) throw new TypeError(`Dependency override ${key} must not be null or undefined`);
    }
    if (overrides.agentHarness !== undefined && overrides.agentModel !== undefined) throw new TypeError("Inject either agentHarness or agentModel, not both");
    if (overrides.agentHarness !== undefined && overrides.fallbackModels !== undefined) throw new TypeError("Fallbacks belong to the injected harness");
    if (overrides.agentHarness !== undefined && overrides.reviewerModel !== undefined) throw new TypeError("Reviewers belong to the injected harness");
    if (overrides.reviewerModel !== undefined && typeof overrides.reviewerModel.turn !== "function") throw new TypeError("Invalid reviewer model");
    if (overrides.agentHarness !== undefined && (typeof overrides.agentHarness.run !== "function" || typeof overrides.agentHarness.titleFor !== "function"))
        throw new TypeError("agentHarness must implement run and titleFor");
    const errors = overrides.errors ?? errorContainer;
    const repository = new IdentityChatSessionRepository(overrides.chatSessionRepository ?? new JsonChatSessionRepository(config.sessionDataDir));
    const auth = overrides.auth ?? (config.auth.enabled ? new AuthService(overrides.authStore ?? new PostgresAuthStore(config.auth.databaseUrl), config.auth) : undefined);
    const log = overrides.logger ?? logger;
    const provider: LlmConfig = { llmApiKey: config.llmApiKey, llmModel: config.llmModel, llmBaseUrl: config.llmBaseUrl, llmTimeoutMs: config.llmTimeoutMs };
    const mcp = overrides.mcp ?? new McpManager(config.mcp.configFile, log, undefined, config.mcp.timeoutMs);
    const runs = overrides.runs ?? (config.observability.enabled ? new RunTraceStore(config.observability.dataDir, log,
        [config.llmApiKey, config.verification.apiKey, config.llmFallback?.apiKey, config.mcp.adminToken], config.observability.maxEvents) : undefined);
    const readingLibrary = overrides.readingLibrary ?? new ReadingLibrary(config.reading.corpusPath);
    const englishLibrary = overrides.englishLibrary ?? new EnglishLibrary(config.english.corpusPath);
    const solutionSkills = overrides.solutionSkills ?? (config.skills.enabled ? new SolutionSkillLibrary(new PostgresSkillStore(config.skills.databaseUrl), config.skills.directory,
        config.skills.embeddingApiKey ? new GlmEmbeddings({ ...provider, llmBaseUrl: config.skills.embeddingBaseUrl, llmApiKey: config.skills.embeddingApiKey }) : undefined) : undefined);
    let agentHarness = overrides.agentHarness;
    if (!agentHarness) {
        const model = overrides.agentModel ?? createModel(provider, config.math.thinking, errors);
        const reviewer = config.verification.enabled ? overrides.reviewerModel ?? new GlmModel({
            llmApiKey: config.verification.apiKey, llmModel: config.verification.model,
            llmBaseUrl: config.verification.baseUrl, llmTimeoutMs: config.verification.timeoutMs,
        }, config.math.thinking) : undefined;
        const fallbackProvider = config.llmFallback ? { ...provider, llmModel: config.llmFallback.model, llmBaseUrl: config.llmFallback.baseUrl, llmApiKey: config.llmFallback.apiKey } : undefined;
        const fallbacks = (thinking: "enabled" | "disabled") => overrides.fallbackModels ??
            (overrides.agentModel === undefined && fallbackProvider ? [{ name: fallbackProvider.llmModel, model: createModel(fallbackProvider, thinking, errors) }] : []);
        const harnessOptions = withSolutionSkills({ ...config.harness, fallbackModels: fallbacks(config.math.thinking) }, solutionSkills, model, reviewer);
        const createBaseAgent = () => config.math.variant !== "general" ? createMathChatAgent(model, config, log, harnessOptions, reviewer) : createChatAgent(repository, model,
            () => config.context.elasticsearchUrl ? new ElasticsearchMemorySearch(new TokenBudget(config.context), config.context) :
                new LocalMemorySearch(new TokenBudget(config.context)), config.context, log,
            { ...withAnswerReview(harnessOptions, model, reviewer, config, "math", mathReviewEvidence),
                excludedPaths: [config.sessionDataDir, config.observability.dataDir, config.mcp.configFile, config.skills.directory],
                additionalTools: (_session, signal, context) => mcp.tools(signal, context?.event) });
        if (config.schoolSubject === "math") agentHarness = createBaseAgent();
        else {
            const reading = createReadingChatAgent(model, config, log, readingLibrary, harnessOptions, reviewer);
            const englishModel = overrides.agentModel ?? createModel(provider, config.english.thinking, errors);
            const english = createEnglishChatAgent(englishModel, config, log, englishLibrary,
                withSolutionSkills({ ...config.harness, fallbackModels: fallbacks(config.english.thinking) }, solutionSkills, englishModel, reviewer), reviewer);
            let base: ChatAgent | undefined;
            const select = (content: string, history: readonly { role: string; content: string }[]) => {
                const subject = config.schoolSubject === "auto" ? routeSchoolSubject(content, history) : config.schoolSubject;
                return subject === "english" ? english : subject === "chinese" ? reading : base ??= createBaseAgent();
            };
            agentHarness = {
                run: (session, current, signal, context) => select(current.content, session.messages).run(session, current, signal, context),
                titleFor: (session, signal) => select([...session.messages].reverse().find(message => message.role === "user")?.content ?? "", session.messages).titleFor(session, signal),
            };
        }
    }
    return {
        solutionSkills,
        auth,
        englishLibrary,
        readingLibrary,
        mathOcr: overrides.mathOcr,
        runs,
        mcp,
        errors,
        chatSessionRepository: repository,
        logger: log,
        agentHarness,
    };
}
