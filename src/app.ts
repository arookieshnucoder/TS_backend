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
  dependencies: AppDependencies = createDependencies()
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext(dependencies.logger));
  app.use(cors({ origin: config.frontendOrigin, exposedHeaders: ["X-Request-Id"] }));
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/health", createHealthModule());
  app.use("/api/chat", createChatModule(dependencies.chatSessionRepository));
  app.use(notFoundHandler);
  app.use(errorHandler(dependencies.logger));
  return app;
}

export default createApp;
