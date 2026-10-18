import { generateId } from "../../../utils/snowflake.js";
import { errorContainer, type ErrorContainer } from "../../../common/errors/error-container.js";
import type { ChatSession, ChatMessage } from "../entity/chat-session.entity.js";
import type { ChatSessionRepository } from "../repository/chat-session.repository.js";
import type { ChatAgent } from "./chat-agent.js";
import type { RunRecorder, RunStatus, RunTraceStore } from "../../observability/run-trace.js";
import { failureCode } from "../../harness/recovery.js";
import { abortable } from "../../harness/cancellation.js";

/** 会话业务服务，串行处理同一会话的发送，保存结果并处理超时、失败和标题更新。 */
export class ChatSessionService {
    private readonly activeSessions = new Set<string>();
    private initialization?: Promise<void>;
    constructor(private readonly repository: ChatSessionRepository, private readonly harness: ChatAgent,
        private readonly errors: ErrorContainer = errorContainer, private readonly timeoutMs = 120000, private readonly runs?: RunTraceStore) { }

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
        const session: ChatSession = {
            id: generateId(), requestId, title, createdAt: now, updatedAt: now,
            messages: [], modelRequestId: null, sessionStatus: "finished", sessionError: null
        };
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
                session.messages = [...session.messages, message,
                    { id: generateId(), role: "assistant" as const, content: result.content }];
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
            if (status === "success") await this.updateTitle(session, signal, trace);
            if (trace) await this.runs!.finish(trace, status, { assistantMessageId: status === "success" ? session.messages.at(-1)?.id : undefined });
            return session;
        } finally {
            if (trace && !trace.finished) await this.runs!.finish(trace, "failure", { code: "PERSISTENCE_ERROR" });
            this.activeSessions.delete(id);
        }
    }

    private async updateTitle(session: ChatSession, signal?: AbortSignal, trace?: RunRecorder): Promise<void> {
        const started = Date.now();
        const timeout = AbortSignal.timeout(Math.min(this.timeoutMs, 5000));
        const titleSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        trace?.event("title.started");
        try {
            const title = await abortable(() => this.harness.titleFor(structuredClone(session), titleSignal), titleSignal);
            titleSignal.throwIfAborted();
            if (typeof title !== "string" || !title.trim()) throw new Error("Empty session title");
            const changed = title !== session.title;
            if (changed) {
                const updated = { ...session, title };
                await this.repository.save(updated);
                session.title = title;
            }
            trace?.event("title.completed", { durationMs: Date.now() - started, changed });
        } catch (error) {
            // The answer is already committed. Metadata failure cannot undo it.
            trace?.event("title.failed", { durationMs: Date.now() - started, code: failureCode(error), cancelled: signal?.aborted ?? false });
        }
    }
}
