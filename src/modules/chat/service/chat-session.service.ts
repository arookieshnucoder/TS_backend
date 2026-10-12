import { generateId } from "../../../utils/snowflake.js";
import { errorContainer, type ErrorContainer } from "../../../common/errors/error-container.js";
import type { ChatSession, ChatMessage } from "../entity/chat-session.entity.js";
import type { ChatSessionRepository } from "../repository/chat-session.repository.js";
import type { ChatAgent } from "./chat-agent.js";
import type { RunRecorder, RunStatus, RunTraceStore } from "../../observability/run-trace.js";
import { failureCode } from "../../harness/recovery.js";

export class ChatSessionService {
  private readonly activeSessions = new Set<string>();
  private initialization?: Promise<void>;
  constructor(private readonly repository: ChatSessionRepository, private readonly harness: ChatAgent,
    private readonly errors: ErrorContainer = errorContainer, private readonly timeoutMs = 120000, private readonly runs?: RunTraceStore) {}

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
    let trace: RunRecorder | undefined;
    try {
      const session = await this.getById(id);
      const message: ChatMessage = { id: generateId(), role: "user", content };
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const runSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      trace = await this.runs?.start({ sessionId: id, requestId, userMessageId: message.id, question: content });
      let status: Exclude<RunStatus, "pending"> = "success";
      session.sessionStatus = "pending";
      session.sessionError = null;
      session.modelRequestId = requestId;
      session.updatedAt = new Date();
      trace?.event("session.pending");
      await this.repository.save(session);
      try {
        runSignal.throwIfAborted();
        const result = await this.harness.run(session, message, runSignal, trace ? { runId: trace.id, event: trace.event } : undefined);
        runSignal.throwIfAborted();
        if (typeof result.content !== "string" || !result.content.trim()) throw new Error("Empty agent answer");
        trace?.event("answer.ready", { content: result.content, modelTurns: result.modelTurns, toolCalls: result.toolCalls });
        const completed = { ...session, messages: [...session.messages, message,
          { id: generateId(), role: "assistant" as const, content: result.content }] };
        const titleStarted = Date.now();
        trace?.event("title.started");
        const title = await this.harness.titleFor(completed, AbortSignal.any([runSignal, AbortSignal.timeout(Math.min(this.timeoutMs, 30000))]));
        runSignal.throwIfAborted();
        trace?.event("title.completed", { durationMs: Date.now() - titleStarted, changed: title !== session.title });
        session.messages = completed.messages;
        session.title = title;
        session.sessionStatus = "finished";
      } catch (error) {
        status = runSignal.aborted ? (runSignal.reason?.name === "TimeoutError" ? "timed_out" : "cancelled") : "failure";
        trace?.event("session.failed", { code: failureCode(error), status });
        session.sessionStatus = "failure";
        session.sessionError = this.errors.toSessionError(this.errors.modelFailure(error));
      }
      session.updatedAt = new Date();
      // Persistence errors remain server errors; never translate them to model failures.
      await this.repository.save(session);
      trace?.event("session.saved", { sessionStatus: session.sessionStatus });
      if (trace) await this.runs!.finish(trace, status, { assistantMessageId: status === "success" ? session.messages.at(-1)?.id : undefined });
      return session;
    } finally {
      if (trace && !trace.finished) await this.runs!.finish(trace, "failure", { code: "PERSISTENCE_ERROR" });
      this.activeSessions.delete(id);
    }
  }
}
