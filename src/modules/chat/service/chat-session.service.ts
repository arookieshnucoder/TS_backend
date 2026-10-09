import { randomUUID } from "node:crypto";
import { AppError } from "../../../common/errors/app-error.js";
import type { ChatSession } from "../entity/chat-session.entity.js";
import type { ChatSessionRepository } from "../repository/chat-session.repository.js";

export class ChatSessionService {
  constructor(private readonly repository: ChatSessionRepository) {}

  async create(title: string): Promise<ChatSession> {
    const session: ChatSession = { id: randomUUID(), title, createdAt: new Date() };
    await this.repository.save(session);
    return session;
  }

  async getById(id: string): Promise<ChatSession> {
    const session = await this.repository.findById(id);
    if (!session) throw new AppError(404, "SESSION_NOT_FOUND", "Chat session not found");
    return session;
  }

  async list(): Promise<ChatSession[]> {
    return this.repository.findAll();
  }
}
