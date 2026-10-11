import { generateId } from "../../../utils/snowflake.js";
import { errorContainer, type ErrorContainer } from "../../../common/errors/error-container.js";
import type { ChatSession, ChatMessage } from "../entity/chat-session.entity.js";
import type { ChatSessionRepository } from "../repository/chat-session.repository.js";
import type { AgentRunner } from "../../harness/agent-harness.js";

export class ChatSessionService {
  private readonly activeSessions = new Set<string>();
  private initialization?: Promise<void>;
  constructor(private readonly repository: ChatSessionRepository, private readonly harness: AgentRunner,
    private readonly errors: ErrorContainer = errorContainer, private readonly timeoutMs = 120000) {}

  private initialize(): Promise<void> {
    return this.initialization ??= (async () => {
      for (const session of await this.repository.findAll()) {
        if (session.sessionStatus === "pending") {
          session.sessionStatus = "failure";
          session.sessionError = this.errors.toSessionError(this.errors.modelFailure());
          await this.repository.save(session);
        }
      }
    })();
  }
  async create(title: string, requestId: string): Promise<ChatSession> {
    await this.initialize();
    const now = new Date();
    const session: ChatSession = { id: generateId(), requestId, title, createdAt: now, updatedAt: now,
      messages: [], modelRequestId: null, sessionStatus: "finished", sessionError: null };
    await this.repository.save(session);
    return session;
  }
  async getById(id: string): Promise<ChatSession> {
    await this.initialize();
    const session = await this.repository.findById(id);
    return session ?? this.errors.fail("SESSION_NOT_FOUND");
  }
  async list(): Promise<ChatSession[]> {
    await this.initialize();
    return this.repository.findAll();
  }
  async send(id: string, content: string, signal?: AbortSignal, requestId = generateId()): Promise<ChatSession> {
    await this.initialize();
    // Reserve before reading disk; only this execution may finish the session.
    if (this.activeSessions.has(id)) return this.errors.fail("SESSION_BUSY");
    this.activeSessions.add(id);
    try {
      const session = await this.getById(id);
      session.sessionStatus = "pending";
      session.sessionError = null;
      session.modelRequestId = requestId;
      session.updatedAt = new Date();
      await this.repository.save(session);
      const message: ChatMessage = { id: generateId(), role: "user", content };
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const runSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let answer: string | undefined;
      try {
        runSignal.throwIfAborted();
        const result = await this.harness.run(session, message, runSignal);
        runSignal.throwIfAborted();
        if (typeof result.content !== "string" || !result.content.trim()) throw new Error("Empty agent answer");
        answer = result.content;
      } catch (error) {
        session.sessionStatus = "failure";
        session.sessionError = this.errors.toSessionError(this.errors.modelFailure(error));
      }
      if (answer !== undefined) {
        session.messages.push(message, { id: generateId(), role: "assistant", content: answer });
        session.title = await this.harness.titleFor(session, AbortSignal.any([runSignal, AbortSignal.timeout(Math.min(this.timeoutMs, 30000))]));
        session.sessionStatus = "finished";
      }
      session.updatedAt = new Date();
      // Persistence errors remain server errors; never translate them to model failures.
      await this.repository.save(session);
      return session;
    } finally { this.activeSessions.delete(id); }
  }
}
