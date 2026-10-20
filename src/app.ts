import { ChatSessionService } from "./modules/chat/service/chat-session.service.js";
import cors from "cors";
import express from "express";
import { createDependencies, type AppDependencies } from "./bootstrap/container.js";
import { loadConfig, type AppConfig } from "./config/env.js";
import { requestContext } from "./common/http/request-context.js";
import { errorHandler, notFoundHandler } from "./common/http/error-handler.js";
import { createHealthModule } from "./modules/health/health.module.js";
import { createChatModule } from "./modules/chat/chat.module.js";
import { createMcpModule } from "./modules/mcp/mcp.module.js";
import { createObservabilityModule } from "./modules/observability/observability.module.js";
import { createMathModule } from "./modules/math/math.module.js";
import { readingRouter } from "./modules/reading/reading.module.js";
import { englishRouter } from "./modules/english/english.module.js";
import { authWriteAccess, createAuthModule, requireAdmin, requireAuth } from "./modules/auth/auth.module.js";
import { workflowModule } from "./modules/workflows/workflow.module.js";
import { BackgroundWorkQueue } from "./modules/chat/service/background-work.js";

export function createApp(
    config: AppConfig = loadConfig(),
    dependencies: AppDependencies = createDependencies({}, config)
) {
    const app = express();
    // header 不带 x-powered-by
    app.disable("x-powered-by");
    app.use(requestContext(dependencies.logger));
    const background = new BackgroundWorkQueue();
    app.locals.chatBackground = background;
    const chatService = new ChatSessionService(dependencies.chatSessionRepository, dependencies.agentHarness, dependencies.errors,
        config.llmTimeoutMs, dependencies.runs, background);
    app.use(cors({ origin: config.frontendOrigin, credentials: true, exposedHeaders: ["X-Request-Id"] }));
    app.use(express.json({ limit: "1mb" }));
    app.use("/api/health", createHealthModule());
    if (config.auth.enabled) {
        if (!dependencies.auth) throw new Error("Authentication dependencies are missing");
        app.use("/api/auth", createAuthModule(dependencies.auth, config.frontendOrigin));
        app.use("/api", requireAuth(dependencies.auth), authWriteAccess(config.frontendOrigin));
        app.use("/api/mcp", requireAdmin);
    }
    // No development token or disabled-auth mode may expose definitions or traces.
    app.use(["/api/workflows", "/api/observability"], requireAdmin);
    app.use("/api/workflows", workflowModule(dependencies.workflows, config));
    app.use("/api/math", createMathModule(config.math.variant, dependencies.mathOcr));
    if (dependencies.readingLibrary) app.use("/api/reading", readingRouter(dependencies.readingLibrary, config.reading.variant));
    if (dependencies.englishLibrary) app.use("/api/english", englishRouter(dependencies.englishLibrary, config.english.variant, config.verification.enabled));
    // 返回给前端的聊天接口
    app.use("/api/chat", createChatModule(chatService, dependencies.errors));
    app.use("/api/mcp", createMcpModule(dependencies.mcp, config.frontendOrigin, config.mcp.adminToken, config.nodeEnv === "production" && !config.auth.enabled));
    app.use("/api/observability", createObservabilityModule(dependencies.runs, config.frontendOrigin));
    app.use(notFoundHandler);
    app.use(errorHandler(dependencies.logger));
    return app;
}

export default createApp;
