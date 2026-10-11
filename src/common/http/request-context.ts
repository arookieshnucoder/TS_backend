import { generateId } from "../../utils/snowflake.js";
import type { RequestHandler } from "express";
import type { Logger } from "../logging/logger.js";

export function requestContext(logger: Logger): RequestHandler {
  return (request, response, next) => {
    // Generate a server-owned ID; do not trust arbitrary incoming header values.
    const requestId = generateId();
    const startedAt = performance.now();
    response.locals.requestId = requestId;
    response.setHeader("X-Request-Id", requestId);
    // 写日志
    response.once("finish", () => {
      logger.info("http.request", {
        requestId,
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt)
      });
    });
    next();
  };
}
