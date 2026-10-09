import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../errors/app-error.js";
import type { Logger } from "../logging/logger.js";

export const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(new AppError(404, "ROUTE_NOT_FOUND", "API route not found"));
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    let appError = error instanceof AppError ? error : undefined;
    if (!appError && error && typeof error === "object" && "type" in error) {
      if (error.type === "entity.parse.failed") {
        appError = new AppError(400, "INVALID_JSON", "Request body must be valid JSON");
      } else if (error.type === "entity.too.large") {
        appError = new AppError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
      }
    }
    const requestId: string = response.locals.requestId;
    if (!appError) {
      // Do not log bodies, credentials or arbitrary exception messages.
      logger.error("http.unhandled_error", {
        requestId,
        errorName: error instanceof Error ? error.name : "UnknownError"
      });
    }
    response.status(appError?.statusCode ?? 500).json({
      error: {
        code: appError?.code ?? "INTERNAL_ERROR",
        message: appError?.message ?? "An unexpected error occurred"
      },
      requestId
    });
  };
}
