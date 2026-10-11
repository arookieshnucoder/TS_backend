import { generateId } from "../../../utils/snowflake.js";
import { errorContainer, type ErrorContainer } from "../../../common/errors/error-container.js";
import { HttpStatus } from "../../../common/http/http-status.js";
import { isValidModelResult } from "../domain/model-result.js";
import type { ChatSession, ChatMessage } from "../entity/chat-session.entity.js";
import type { ChatModel } from "./chat-model.js";
import type { ChatSessionRepository } from "../repository/chat-session.repository.js";
import type { ContextHarness } from "../../context/harness.js";

export interface ModelResult {
  requestId: string;
  httpStatusCode: typeof HttpStatus.OK | typeof HttpStatus.BAD_REQUEST;
  content?: string;
}
interface PendingRequest {
  requestId: string;
  session: ChatSession;
  message: ChatMessage;
  completion?: Promise<ChatSession>;
  signal?: AbortSignal;
}
export class ChatSessionService {
  private readonly requests = new Map<string, PendingRequest | null>();
  private initialization?: Promise<void>;
  constructor(private readonly repository: ChatSessionRepository, private readonly model: ChatModel,
    private readonly errors: ErrorContainer = errorContainer, private readonly timeoutMs = 120000,
    private readonly harness: ContextHarness | null = null) {}

  // A previous process cannot finish an in-flight request.
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
  async checkResult(id: string) {
    const session = await this.getById(id);
    const returnedCorrectly = session.sessionStatus === "finished" && session.messages.at(-1)?.role === "assistant";
    return { sessionId: id, requestId: session.modelRequestId ?? null, sessionStatus: session.sessionStatus,
      returnedCorrectly, httpStatusCode: returnedCorrectly ? HttpStatus.OK : HttpStatus.BAD_REQUEST,
      error: session.sessionError };
  }
  // The internal POST and the in-process LangChain call use this ONE result handler.
  async complete(id: string, result: ModelResult, failure = this.errors.modelFailure()): Promise<ChatSession> {
    const request = this.requests.get(id);
    if (!request || request.requestId !== result.requestId) return this.errors.fail("RESULT_REQUEST_MISMATCH");
    // Duplicate or late callbacks cannot append messages twice or overwrite the first result.
    return request.completion ??= (async () => {
      const session = structuredClone(request.session);
      const success = result.httpStatusCode === HttpStatus.OK && isValidModelResult(result.content);
      session.sessionStatus = success ? "finished" : "failure";
      session.sessionError = success ? null : this.errors.toSessionError(failure);
      session.updatedAt = new Date();
      if (success) {
        session.messages.push(request.message, { id: generateId(), role: "assistant", content: result.content! });
        if (this.harness) {
          const timeout = AbortSignal.timeout(Math.min(this.timeoutMs, 30000));
          session.title = await this.harness.titleFor(session, request.signal ? AbortSignal.any([request.signal, timeout]) : timeout);
        }
      }
      await this.repository.save(session);
      return session;
    })();
  }
  async send(id: string, content: string, signal?: AbortSignal, requestId = generateId()): Promise<ChatSession> {
    await this.initialize();
    // Reserve synchronously before reading disk.
    if (this.requests.has(id)) return this.errors.fail("SESSION_BUSY");
    this.requests.set(id, null);
    try {
      const session = await this.getById(id);
      session.sessionStatus = "pending";
      session.sessionError = null;
      session.modelRequestId = requestId;
      session.updatedAt = new Date();
      const request: PendingRequest = { requestId, session, message: { id: generateId(), role: "user", content } };
      this.requests.set(id, request);
      await this.repository.save(session);
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const modelSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      request.signal = modelSignal;
      let result: ModelResult;
      let failure = this.errors.modelFailure();
      try {
        modelSignal.throwIfAborted();
        const generated = this.harness ? await this.harness.run(session, request.message, modelSignal) : undefined;
        const reply = generated ? generated.content : await this.model.reply([...session.messages, request.message], modelSignal);
        modelSignal.throwIfAborted();
        result = { requestId, httpStatusCode: HttpStatus.OK, content: reply };
      } catch (error) {
        failure = this.errors.modelFailure(error);
        result = { requestId, httpStatusCode: HttpStatus.BAD_REQUEST };
      }
      return await this.complete(id, result, failure);
    } finally {
      this.requests.delete(id);
    }
  }
}
