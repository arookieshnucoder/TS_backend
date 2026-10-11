import { errorContainer, type ErrorContainer } from "../../../common/errors/error-container.js";
import { sendSessionResult } from "../dto/session-result-response.js";
import { Router, json } from "express";
import { timingSafeEqual } from "node:crypto";
import { HttpStatus } from "../../../common/http/http-status.js";
import type { ChatSessionService } from "../service/chat-session.service.js";

/**
 * 创建内部聊天路由
 * @param service The chat session service used to handle chat sessions.
 * @param token The internal token required for authorization.
 * @returns An Express router configured for internal chat endpoints.
 */
export function createInternalChatRouter(service: ChatSessionService, token?: string, errors: ErrorContainer = errorContainer): Router {
  const router = Router();
  router.use((request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    if (!token) { response.sendStatus(HttpStatus.NOT_FOUND); return; }
    if (request.headers.origin || request.headers["sec-fetch-site"]) { response.sendStatus(HttpStatus.FORBIDDEN); return; }
    const actual = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      response.sendStatus(HttpStatus.UNAUTHORIZED); return;
    }
    next();
  });
  router.use(json({ limit: "1mb" }));
  router.post("/sessions/:id/result", async (request, response) => {
    const { requestId, httpStatusCode, content } = request.body ?? {};
    if (typeof requestId !== "string" || !requestId
      || ![HttpStatus.OK, HttpStatus.BAD_REQUEST].includes(httpStatusCode)
      || (content !== undefined && typeof content !== "string")) {
      return errors.fail("VALIDATION_ERROR", "Expected requestId and httpStatusCode (200 or 400), with optional text content");
    }
    const session = await service.complete(request.params.id, { requestId, httpStatusCode, content });
    sendSessionResult(response, session);
  });
  router.get("/sessions/:id/result", async (request, response) => {
    const result = await service.checkResult(request.params.id);
    response.status(result.httpStatusCode).json({ data: result });
  });
  return router;
}
