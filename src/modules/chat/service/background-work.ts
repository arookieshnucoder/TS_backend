import { abortable } from "../../harness/cancellation.js";

export type BackgroundWork = (signal: AbortSignal) => Promise<void>;

/** Bounded, serial best-effort learning. Foreground solving never queues behind it. */
export class BackgroundWorkQueue {
    private readonly controller = new AbortController();
    private readonly preempted = new Error("Foreground work has priority");
    private active?: AbortController;
    private foregroundCount = 0;
    private readonly idleWaiters = new Set<() => void>();
    private tail: Promise<void> = Promise.resolve();
    private pending = 0;
    constructor(private readonly limit = 16, private readonly timeoutMs = 120000, private readonly idleDelayMs = 1000) {}
    /** Suspend learning immediately; a preempted transaction rolls back and restarts when idle. */
    foreground(): () => void {
        this.foregroundCount++;
        this.active?.abort(this.preempted);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (--this.foregroundCount === 0) for (const wake of this.idleWaiters) wake();
        };
    }
    private async idle() {
        while (this.foregroundCount) {
            let wake!: () => void;
            try { await abortable(() => new Promise<void>(resolve => { wake = resolve; if (this.foregroundCount) this.idleWaiters.add(wake); else resolve(); }), this.controller.signal); }
            finally { this.idleWaiters.delete(wake); }
        }
    }
    enqueue(work: BackgroundWork): Promise<void> | undefined {
        if (this.controller.signal.aborted || this.pending >= this.limit) return undefined;
        this.pending++;
        const operation = this.tail.then(async () => {
            for (;;) {
                await this.idle();
                if (this.foregroundCount) continue;
                const active = new AbortController();
                this.active = active;
                const signal = AbortSignal.any([this.controller.signal, active.signal, AbortSignal.timeout(this.timeoutMs)]);
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    // Avoid competing with the next question or returning the answer late.
                    await abortable(() => new Promise<void>(resolve => { timer = setTimeout(resolve, this.idleDelayMs); }), signal);
                    await abortable(() => work(signal), signal);
                    return;
                } catch (error) {
                    if (active.signal.reason !== this.preempted || this.controller.signal.aborted) throw error;
                } finally {
                    clearTimeout(timer);
                    if (this.active === active) this.active = undefined;
                }
            }
        }).finally(() => { this.pending--; });
        this.tail = operation.catch(() => {});
        return operation;
    }
    async close() {
        this.controller.abort(new Error("Server shutting down"));
        await this.tail;
    }
    async drain() { await this.tail; }
}
