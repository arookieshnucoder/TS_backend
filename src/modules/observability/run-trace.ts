import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateId } from "../../utils/snowflake.js";
import type { Logger } from "../../common/logging/logger.js";
import { redact, environmentSecrets } from "../../common/logging/redaction.js";
import { AppError } from "../../common/errors/app-error.js";
import type { WorkflowSnapshot } from "../workflows/definition.js";

export type RunStatus = "pending" | "success" | "failure" | "cancelled" | "timed_out" | "interrupted";
/** 运行追踪中的一个有序事件，记录发生时间、相对耗时和结构化字段。 */
export interface RunEvent { sequence: number; name: string; timestamp: string; elapsedMs: number; fields: Record<string, unknown>; }
/** 一次回答的完整运行记录，关联会话、请求、消息及按顺序发生的事件。 */
export interface RunTrace {
    workflow?: WorkflowSnapshot & { runtime: Record<string, unknown> };
    id: string; sessionId: string; requestId: string; userMessageId: string; assistantMessageId?: string;
    question: string; status: RunStatus; startedAt: string; finishedAt?: string; durationMs?: number;
    events: RunEvent[]; droppedEvents: number;
}
export type RunSummary = Omit<RunTrace, "events" | "workflow"> & { eventCount: number };
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const summary = ({ events, workflow: _workflow, ...run }: RunTrace): RunSummary => ({ ...run, eventCount: events.length });

/** 记录当前运行事件并更新状态，落盘前统一脱敏并限制记录数量。 */
export class RunRecorder {
    private closed = false;
    private queue: Promise<void> = Promise.resolve();
    private queued = false;
    constructor(readonly run: RunTrace, private readonly persist: (run: RunTrace) => Promise<void>,
        private readonly logger: Logger, private readonly secrets: string[], private readonly maxEvents: number) {}
    get id() { return this.run.id; }
    get finished() { return this.closed; }
    async workflow(snapshot: WorkflowSnapshot & { runtime: Record<string, unknown> }): Promise<void> {
        if (this.closed || this.run.workflow) return;
        // Preview redaction truncates nested arrays/depth. A historical graph must retain
        // its full structure, so redact only textual leaves and preserve structural IDs.
        const safe = structuredClone(snapshot);
        const safeText = (value: string) => redact(value, this.secrets, { maxStringLength: 50000, maxCharacters: 50000 }) as string;
        safe.title = safeText(safe.title); safe.description = safeText(safe.description);
        for (const node of safe.graph.nodes) {
            for (const field of ["label", "description", "inputs", "outputs"] as const) node.data[field] = safeText(node.data[field]);
            node.data.config = Object.fromEntries(Object.entries(node.data.config).map(([key, value]) => [key, safeText(value)]));
            for (const binding of node.data.bindings) if (binding.value !== undefined) binding.value = safeText(binding.value);
        }
        for (const edge of safe.graph.edges) edge.label = safeText(edge.label);
        safe.runtime = redact(safe.runtime, this.secrets, { maxStringLength: 50000, maxCharacters: 100000 }) as Record<string, unknown>;
        this.run.workflow = safe;
        this.schedule(); await this.queue;
    }
    readonly event = (name: string, fields: Record<string, unknown> = {}): void => {
        if (this.closed) return;
        if (this.run.events.length >= this.maxEvents - 1) { this.run.droppedEvents++; return; }
        this.add(name, fields);
        this.schedule();
    };
    private add(name: string, fields: Record<string, unknown>) {
        const redacted = redact(fields, this.secrets) as Record<string, unknown>;
        const serialized = JSON.stringify(redacted);
        const safeFields = Buffer.byteLength(serialized) <= 8192 ? redacted : { truncated: true, preview: serialized.slice(0, 1600) };
        this.run.events.push({ sequence: this.run.events.length + 1, name: name.slice(0, 100), timestamp: new Date().toISOString(),
            elapsedMs: Date.now() - Date.parse(this.run.startedAt), fields: safeFields });
    }
    private schedule() {
        if (this.queued) return;
        this.queued = true;
        this.queue = this.queue.then(async () => {
            this.queued = false;
            await this.persist(structuredClone(this.run));
        }).catch(() => { this.logger.error("trace.persist_failed", { runId: this.id }); });
    }
    async finish(status: Exclude<RunStatus, "pending">, fields: Record<string, unknown> = {}): Promise<void> {
        if (this.closed) { await this.queue; return; }
        this.run.status = status; this.run.finishedAt = new Date().toISOString();
        this.run.durationMs = Date.now() - Date.parse(this.run.startedAt);
        if (typeof fields.assistantMessageId === "string") this.run.assistantMessageId = fields.assistantMessageId;
        this.add(`run.${status}`, fields);
        this.closed = true;
        this.schedule();
        await this.queue;
    }
    async flush(): Promise<void> { await this.queue; }
}

/** 运行追踪存储，管理活动记录、历史查询及后端重启后的中断状态。 */
export class RunTraceStore {
    private readonly active = new Map<string, RunRecorder>();
    private readonly secrets: string[];
    constructor(private readonly directory: string, private readonly logger: Logger, secrets: (string | undefined)[] = [], private readonly maxEvents = 512) {
        this.secrets = [...environmentSecrets(), ...secrets.filter((s): s is string => !!s)];
        if (!Number.isInteger(maxEvents) || maxEvents < 2 || maxEvents > 1024) throw new TypeError("Invalid trace event limit");
    }
    private file(sessionId: string, id: string) {
        if (!validId(sessionId) || !validId(id)) throw new AppError(400, "TRACE_INVALID_ID", "运行记录 ID 无效。");
        return join(this.directory, sessionId, `${id}.json`);
    }
    private async save(run: RunTrace) {
        const destination = this.file(run.sessionId, run.id);
        await mkdir(join(this.directory, run.sessionId), { recursive: true });
        const temporary = `${destination}.${generateId()}.tmp`;
        await writeFile(temporary, JSON.stringify(run), { mode: 0o600, flag: "wx" });
        await rename(temporary, destination);
    }
    async start(input: { sessionId: string; requestId: string; userMessageId: string; question: string }): Promise<RunRecorder | undefined> {
        const run: RunTrace = { ...input, question: redact(input.question, this.secrets) as string, id: generateId(), status: "pending",
            startedAt: new Date().toISOString(), events: [], droppedEvents: 0 };
        const recorder = new RunRecorder(run, value => this.save(value), this.logger, this.secrets, this.maxEvents);
        this.active.set(run.id, recorder);
        try { await this.save(run); recorder.event("run.started", { question: run.question }); return recorder; }
        catch { this.active.delete(run.id); this.logger.error("trace.start_failed", { runId: run.id }); return undefined; }
    }
    async finish(recorder: RunRecorder, status: Exclude<RunStatus, "pending">, fields?: Record<string, unknown>) {
        await recorder.finish(status, fields);
        this.active.delete(recorder.id);
    }
    async get(sessionId: string, id: string): Promise<RunTrace> {
        const file = this.file(sessionId, id);
        const active = this.active.get(id);
        if (active?.run.sessionId === sessionId) return structuredClone(active.run);
        let run: RunTrace;
        try {
            if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error("Oversized trace");
            run = JSON.parse(await readFile(file, "utf8"));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "TRACE_NOT_FOUND", "运行记录不存在。");
            throw new AppError(500, "TRACE_INVALID_RECORD", "运行记录无法读取。");
        }
        if (run.id !== id || run.sessionId !== sessionId || !Array.isArray(run.events) || run.events.length > 1024 || typeof run.question !== "string" ||
            typeof run.requestId !== "string" || typeof run.userMessageId !== "string" || !Number.isSafeInteger(run.droppedEvents) || run.droppedEvents < 0 ||
            !run.events.every((event, index) => event && event.sequence === index + 1 && typeof event.name === "string" &&
                Number.isFinite(Date.parse(event.timestamp)) && typeof event.elapsedMs === "number" && Number.isFinite(event.elapsedMs) &&
                event.fields && typeof event.fields === "object" && !Array.isArray(event.fields)) ||
            !Number.isFinite(Date.parse(run.startedAt)) || !["pending", "success", "failure", "cancelled", "timed_out", "interrupted"].includes(run.status))
            throw new AppError(500, "TRACE_INVALID_RECORD", "运行记录格式无效。");
        // A pending file without a live recorder came from an interrupted backend process.
        if (run.status === "pending") {
            run.status = "interrupted"; run.finishedAt = new Date().toISOString();
            run.events.push({ sequence: run.events.length + 1, name: "run.interrupted", timestamp: run.finishedAt,
                elapsedMs: Date.now() - Date.parse(run.startedAt), fields: { reason: "backend_restarted" } });
            await this.save(run).catch(() => this.logger.error("trace.persist_failed", { runId: id }));
        }
        return run;
    }
    async list(sessionId: string, limit = 20, before?: string): Promise<{ runs: RunSummary[]; nextCursor?: string }> {
        if (!validId(sessionId) || !Number.isInteger(limit) || limit < 1 || limit > 50 || (before !== undefined && !/^\d{17,20}$/.test(before)))
            throw new AppError(400, "TRACE_INVALID_QUERY", "运行记录查询参数无效。");
        let names: string[];
        try { names = await readdir(join(this.directory, sessionId)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { runs: [] }; throw error; }
        const ids = [...new Set([...names.filter(n => /^\d{17,20}\.json$/.test(n)).map(n => n.slice(0, -5)),
            ...[...this.active.values()].filter(r => r.run.sessionId === sessionId).map(r => r.id)])]
            .filter(id => before === undefined || BigInt(id) < BigInt(before)).sort((a, b) => BigInt(a) > BigInt(b) ? -1 : BigInt(a) < BigInt(b) ? 1 : 0);
        const runs: RunSummary[] = [];
        let index = 0;
        for (; index < ids.length && runs.length < limit; index++) {
            try { runs.push(summary(await this.get(sessionId, ids[index]!))); }
            catch { this.logger.error("trace.invalid_record", { runId: ids[index] }); }
        }
        return { runs, ...(index < ids.length && runs.length ? { nextCursor: runs.at(-1)!.id } : {}) };
    }
}
