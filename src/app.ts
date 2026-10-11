import { ChatSessionService } from "./modules/chat/service/chat-session.service.js";
import { createInternalChatRouter } from "./modules/chat/controller/internal-chat.controller.js";
import cors from "cors";
import express from "express";
import { createDependencies, type AppDependencies } from "./bootstrap/container.js";
import { loadConfig, type AppConfig } from "./config/env.js";
import { requestContext } from "./common/http/request-context.js";
import { errorHandler, notFoundHandler } from "./common/http/error-handler.js";
import { createHealthModule } from "./modules/health/health.module.js";
import { createChatModule } from "./modules/chat/chat.module.js";

export function createApp(
  config: AppConfig = loadConfig(),
  dependencies: AppDependencies = createDependencies({}, config)
) {
  const app = express();
  // header 不带 x-powered-by
  app.disable("x-powered-by");
  app.use(requestContext(dependencies.logger));
  const chatService = new ChatSessionService(dependencies.chatSessionRepository, dependencies.chatModel, dependencies.errors,
    config.llmTimeoutMs, dependencies.contextHarness);
  // 内部聊天接口，
  app.use("/internal/chat", createInternalChatRouter(chatService, config.internalApiToken));
  app.use(cors({ origin: config.frontendOrigin, exposedHeaders: ["X-Request-Id"] }));
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/health", createHealthModule());
  // 返回给前端的聊天接口
  app.use("/api/chat", createChatModule(dependencies.chatSessionRepository, dependencies.chatModel, chatService));
  app.use(notFoundHandler);
  app.use(errorHandler(dependencies.logger));
  // TODO: 可以在这里添加更多的中间件，例如请求日志、身份验证等。
  return app;
}

export default createApp;
