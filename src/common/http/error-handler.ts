import type { ErrorRequestHandler, RequestHandler } from "express";
import { errorContainer, type ErrorContainer } from "../errors/error-container.js";
import type { Logger } from "../logging/logger.js";

export function createNotFoundHandler(errors: ErrorContainer = errorContainer): RequestHandler {
    return (_request, _response, next) => next(errors.create("ROUTE_NOT_FOUND"));
}
export const notFoundHandler = createNotFoundHandler();

export function errorHandler(logger: Logger, errors: ErrorContainer = errorContainer): ErrorRequestHandler {
    return (error: unknown, _request, response, next) => {
        const failure = errors.normalize(error);
        const requestId: string = response.locals.requestId;
        if (failure.code === "INTERNAL_ERROR") {
            logger.error("http.unhandled_error", {
                requestId, errorName: error instanceof Error ? error.name : "UnknownError",
            });
        }
        const body = {
            error: { code: failure.code, message: failure.message },
            httpStatusCode: failure.statusCode, requestId
        };
        if (response.destroyed || response.writableEnded) return;
        if (response.headersSent) {
            next(error);
            return;
        }
        response.status(failure.statusCode).json(body);
    };
}
