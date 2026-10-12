import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateId } from "../../../utils/snowflake.js";
import { isSessionStatus } from "../../../modules/chat/domain/session-status.js";
import type { ChatSession } from "../../../modules/chat/entity/chat-session.entity.js";
import type { ChatSessionRepository } from "../../../modules/chat/repository/chat-session.repository.js";

// A single backend process owns the directory. Atomic replacement prevents partial reads.
export class JsonChatSessionRepository implements ChatSessionRepository {
    constructor(private readonly directory: string) { }
    async save(session: ChatSession): Promise<void> {
        if (!/^[a-zA-Z0-9-]+$/.test(session.requestId)) throw new Error("Invalid request ID");
        await mkdir(this.directory, { recursive: true });
        const destination = join(this.directory, `${session.requestId}_${session.createdAt.getTime()}.json`);
        const temporary = `${destination}.${generateId()}.tmp`;
        try {
            await writeFile(temporary, JSON.stringify(session, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
            await rename(temporary, destination);
        } finally {
            await rm(temporary, { force: true });
        }
    }
    async findById(id: string): Promise<ChatSession | null> {
        return (await this.findAll()).find(session => session.id === id) ?? null;
    }
    async findAll(): Promise<ChatSession[]> {
        await mkdir(this.directory, { recursive: true });
        const names = (await readdir(this.directory)).filter(name => name.endsWith(".json"));
        const sessions = await Promise.all(names.map(async name => {
            const value = JSON.parse(await readFile(join(this.directory, name), "utf8"));
            if (!value || typeof value.id !== "string" || typeof value.requestId !== "string"
                || typeof value.title !== "string" || !Array.isArray(value.messages)
                || !value.messages.every((m: any) => m && typeof m.id === "string"
                    && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
                || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) {
                throw new Error("Invalid session file");
            }
            // Migrate the removed state before validating older persisted sessions.
            if (value.sessionStatus === "generating") value.sessionStatus = "pending";
            if (value.sessionStatus !== undefined && !isSessionStatus(value.sessionStatus)) throw new Error("Invalid session status");
            if (value.sessionError != null && (typeof value.sessionError.code !== "string"
                || typeof value.sessionError.message !== "string" || !Number.isInteger(value.sessionError.httpStatusCode)
                || value.sessionError.httpStatusCode < 400 || value.sessionError.httpStatusCode > 599)) {
                throw new Error("Invalid session error");
            }
            return { ...value, sessionStatus: value.sessionStatus ?? "finished", sessionError: value.sessionError ?? null, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) } as ChatSession;
        }));
        return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    }
}
