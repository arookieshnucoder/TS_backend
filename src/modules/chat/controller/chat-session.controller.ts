import type { RequestHandler } from "express";
import type { ChatSessionService } from "../service/chat-session.service.js";
import { parseCreateSessionDto } from "../dto/create-session.dto.js";
import { toSessionResponse } from "../dto/session-response.dto.js";

export class ChatSessionController {
  constructor(private readonly service: ChatSessionService) {}

  readonly create: RequestHandler = async (request, response) => {
    const dto = parseCreateSessionDto(request.body);
    const session = await this.service.create(dto.title);
    response.status(201).location(`/api/chat/sessions/${session.id}`).json({ data: toSessionResponse(session) });
  };

  readonly list: RequestHandler = async (_request, response) => {
    const sessions = await this.service.list();
    response.json({ data: sessions.map(toSessionResponse) });
  };

  readonly getById: RequestHandler<{ id: string }> = async (request, response) => {
    const session = await this.service.getById(request.params.id);
    response.json({ data: toSessionResponse(session) });
  };
}
