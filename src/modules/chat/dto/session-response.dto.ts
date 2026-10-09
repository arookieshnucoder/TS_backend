import type { ChatSession } from "../entity/chat-session.entity.js";

export interface SessionResponseDto {
  id: string;
  title: string;
  createdAt: string;
}
export function toSessionResponse(session: ChatSession): SessionResponseDto {
  return { id: session.id, title: session.title, createdAt: session.createdAt.toISOString() };
}
