import { errorContainer, type ErrorContainer } from "../../common/errors/error-container.js";
import { Router } from "express";
import { ChatSessionController } from "./controller/chat-session.controller.js";
import { ChatSessionService } from "./service/chat-session.service.js";

/**
 * @param service 会话服务（通过 Harness 运行 Ask Agent）
 * @returns 配置好的聊天模块路由
 */
export function createChatModule(service: ChatSessionService, errors: ErrorContainer = errorContainer): Router {
    const controller = new ChatSessionController(service, errors);
    const router = Router();
    router.post("/sessions", controller.create);
    router.get("/sessions", controller.list);
    router.get("/sessions/:id", controller.getById);
    router.post("/sessions/:id/messages", controller.send);
    return router;
}
