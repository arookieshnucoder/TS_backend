import { errorContainer, type ErrorContainer } from "../../../common/errors/error-container.js";

/** 创建会话的请求体，只接受经过校验的会话标题。 */
export interface CreateSessionDto { title: string }

// TypeScript types are erased at runtime: HTTP input still needs validation.
export function parseCreateSessionDto(input: unknown, errors: ErrorContainer = errorContainer): CreateSessionDto {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return errors.fail("VALIDATION_ERROR", "Request body must be an object");
    }
    const title = "title" in input ? input.title : undefined;
    if (typeof title !== "string" || !title.trim() || title.trim().length > 100) {
        return errors.fail("VALIDATION_ERROR", "title must contain 1 to 100 characters");
    }
    return { title: title.trim() };
}
