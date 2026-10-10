import { Router } from "express";
import { ChatSessionController } from "./controller/chat-session.controller.js";
import { ChatSessionService } from "./service/chat-session.service.js";
import type { ChatSessionRepository } from "./repository/chat-session.repository.js";

/**
 * @param repository 聊天会话存储库实例
 * @returns 配置好的聊天模块路由
 */
export function createChatModule(repository: ChatSessionRepository): Router {
  const controller = new ChatSessionController(new ChatSessionService(repository));
  const router = Router();
  router.post("/sessions", controller.create);
  router.get("/sessions", controller.list);
  router.get("/sessions/:id", controller.getById);
  return router;
}
