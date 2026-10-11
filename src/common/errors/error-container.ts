import { AppError } from "./app-error.js";
import { HttpStatus } from "../http/http-status.js";

const definitions = {
  VALIDATION_ERROR: [HttpStatus.BAD_REQUEST, "Request body is invalid"],
  SESSION_NOT_FOUND: [HttpStatus.NOT_FOUND, "Chat session not found"],
  SESSION_BUSY: [HttpStatus.CONFLICT, "该会话正在生成回复，请稍后重试。"],
  MODEL_REQUEST_FAILED: [HttpStatus.BAD_REQUEST, "模型未正确返回，请检查接口配置或网络后重试。"],
  ROUTE_NOT_FOUND: [HttpStatus.NOT_FOUND, "API route not found"],
  INVALID_JSON: [HttpStatus.BAD_REQUEST, "Request body must be valid JSON"],
  PAYLOAD_TOO_LARGE: [HttpStatus.PAYLOAD_TOO_LARGE, "Request body is too large"],
  INTERNAL_ERROR: [HttpStatus.INTERNAL_SERVER_ERROR, "An unexpected error occurred"],
} as const;
export type ErrorCode = keyof typeof definitions;
export class ErrorContainer {
  create(code: ErrorCode, message?: string): AppError {
    const [status, defaultMessage] = definitions[code];
    return new AppError(status, code, message ?? defaultMessage);
  }
  fail(code: ErrorCode, message?: string): never { throw this.create(code, message); }
  normalize(error: unknown): AppError {
    if (error instanceof AppError) return error;
    if (error && typeof error === "object" && "type" in error) {
      if (error.type === "entity.parse.failed") return this.create("INVALID_JSON");
      if (error.type === "entity.too.large") return this.create("PAYLOAD_TOO_LARGE");
    }
    return this.create("INTERNAL_ERROR");
  }
  modelFailure(error?: unknown): AppError {
    if (error instanceof AppError && error.code === "MODEL_REQUEST_FAILED") return error;
    // Only expose an actual upstream HTTP code, never raw SDK errors, request headers or credentials.
    const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
      return this.create("MODEL_REQUEST_FAILED", `模型服务返回 HTTP ${status}，请检查 API Key、模型名和接口地址。`);
    }
    return this.create("MODEL_REQUEST_FAILED");
  }
  toSessionError(error: AppError) {
    return { code: error.code, message: error.message, httpStatusCode: error.statusCode };
  }
}

export const errorContainer = new ErrorContainer();
