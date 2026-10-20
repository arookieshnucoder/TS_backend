import { generateId } from "../../../utils/snowflake.js";
import { errorContainer, type ErrorContainer } from "../../../common/errors/error-container.js";
import type { ChatSession, ChatMessage } from "../entity/chat-session.entity.js";
import type { ChatSessionRepository } from "../repository/chat-session.repository.js";
import type { ChatAgent } from "./chat-agent.js";
import type { RunRecorder, RunStatus, RunTraceStore } from "../../observability/run-trace.js";
import { failureCode } from "../../harness/recovery.js";
import { abortable } from "../../harness/cancellation.js";
import { identity } from "../../auth/identity.js";
import { BackgroundWorkQueue, type BackgroundWork } from "./background-work.js";

/** 会话业务服务，串行处理同一会话的发送，保存结果并处理超时、失败和标题更新。 */
export class ChatSessionService {
    private readonly activeSessions = new Set<string>();
    private readonly initializations = new Map<string, Promise<void>>();
    constructor(private readonly repository: ChatSessionRepository, private readonly harness: ChatAgent,
        private readonly errors: ErrorContainer = errorContainer, private readonly timeoutMs = 120000, private readonly runs?: RunTraceStore,
        private readonly background = new BackgroundWorkQueue()) { }

    private initialize(): Promise<void> {
        const scope = identity.getStore()?.userId ?? "";
        const existing = this.initializations.get(scope);
        if (existing) return existing;
        const pending = (async () => {
            for (const session of await this.repository.findAll()) {
                if (session.sessionStatus === "pending") {
                    session.sessionStatus = "failure";
                    session.sessionError = this.errors.toSessionError(this.errors.modelFailure());
                    await this.repository.save(session);
                }
            }
        })().catch(error => { this.initializations.delete(scope); throw error; });
        this.initializations.set(scope, pending);
        return pending;
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
        const releaseForeground = this.background.foreground();
        let trace: RunRecorder | undefined;
        let deferredTrace = false;
        let deferredMaintenance: BackgroundWork[] = [];
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
                const maintenance: BackgroundWork[] = [];
                const result = await this.harness.run(session, message, runSignal, { runId: trace?.id ?? requestId,
                    event: trace?.event ?? (() => {}), ...(trace ? { workflow: snapshot => trace!.workflow(snapshot) } : {}),
                    deferMaintenance: work => maintenance.push(work) });
                runSignal.throwIfAborted();
                if (typeof result.content !== "string" || !result.content.trim()) throw new Error("Empty agent answer");
                trace?.event("answer.ready", { content: result.content, modelTurns: result.modelTurns, toolCalls: result.toolCalls });
                session.messages = [...session.messages, message,
                    { id: generateId(), role: "assistant" as const, content: result.content }];
                session.sessionStatus = "finished";
                // Retain work only for this successfully reviewed answer. Submission happens
                // below after persistence, so failed/cancelled answers cannot publish experience.
                deferredMaintenance = maintenance;
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
            const completionFields = { assistantMessageId: status === "success" ? session.messages.at(-1)?.id : undefined };
            if (status === "success" && deferredMaintenance.length) {
                const recorder = trace;
                const task = this.background.enqueue(async scope => {
                    for (const work of deferredMaintenance) await work(scope);
                });
                if (task) {
                    deferredTrace = true;
                    // The trace stays available while maintenance runs, with answer.ready
                    // recording user-visible latency separately from total maintenance time.
                    void task.catch(() => recorder?.event("agent.skills.maintenance.failed", { reason: "cancelled_or_unavailable" }))
                        .then(() => recorder && this.runs!.finish(recorder, "success", completionFields))
                        .catch(() => {});
                } else trace?.event("agent.skills.skipped", { reason: "maintenance_queue_full" });
            }
            if (trace && !deferredTrace) await this.runs!.finish(trace, status, completionFields);
            return session;
        } finally {
            try {
                if (trace && !trace.finished && !deferredTrace) await this.runs!.finish(trace, "failure", { code: "PERSISTENCE_ERROR" });
            } finally { this.activeSessions.delete(id); releaseForeground(); }
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
