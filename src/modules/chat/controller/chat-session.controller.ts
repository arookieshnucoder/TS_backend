import { HttpStatus } from "../../../common/http/http-status.js";
import { errorContainer, type ErrorContainer } from "../../../common/errors/error-container.js";
import type { RequestHandler } from "express";
import type { ChatSessionService } from "../service/chat-session.service.js";
import { parseCreateSessionDto } from "../dto/create-session.dto.js";
import { toSessionResponse } from "../dto/session-response.dto.js";
import { sendSessionResult } from "../dto/session-result-response.js";

/** 聊天 HTTP 控制器，验证输入并把会话服务结果转换为响应。 */
export class ChatSessionController {
    constructor(private readonly service: ChatSessionService, private readonly errors: ErrorContainer = errorContainer) { }
    readonly create: RequestHandler = async (request, response) => {
        const dto = parseCreateSessionDto(request.body, this.errors);
        const session = await this.service.create(dto.title, response.locals.requestId);
        response.status(HttpStatus.CREATED).location(`/api/chat/sessions/${session.id}`).json({ data: toSessionResponse(session) });
    };
    readonly send: RequestHandler<{ id: string }> = async (request, response) => {
        const content = request.body?.content;
        if (typeof content !== "string" || !content.trim() || content.trim().length > 12000) {
            return this.errors.fail("VALIDATION_ERROR", "content must contain 1 to 12000 characters");
        }
        const abort = new AbortController();
        const onClose = () => { if (!response.writableEnded) abort.abort(); };
        response.on("close", onClose);
        try {
            const session = await this.service.send(request.params.id, content.trim(), abort.signal, response.locals.requestId);
            if (!response.destroyed) sendSessionResult(response, session);
        } finally { response.off("close", onClose); }
    };
    readonly list: RequestHandler = async (_request, response) => {
        response.json({ data: (await this.service.list()).map(toSessionResponse) });
    };
    readonly getById: RequestHandler<{ id: string }> = async (request, response) => {
        response.json({ data: toSessionResponse(await this.service.getById(request.params.id)) });
    };
}
