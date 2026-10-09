import { Router } from "express";
import { ChatSessionController } from "./controller/chat-session.controller.js";
import { ChatSessionService } from "./service/chat-session.service.js";
import type { ChatSessionRepository } from "./repository/chat-session.repository.js";

export function createChatModule(repository: ChatSessionRepository): Router {
  const controller = new ChatSessionController(new ChatSessionService(repository));
  const router = Router();
  router.post("/sessions", controller.create);
  router.get("/sessions", controller.list);
  router.get("/sessions/:id", controller.getById);
  return router;
}
