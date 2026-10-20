import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../../../common/persistence/atomic-write.js";
import { isSessionStatus } from "../../../modules/chat/domain/session-status.js";
import type { ChatSession } from "../../../modules/chat/entity/chat-session.entity.js";
import type { ChatSessionRepository } from "../../../modules/chat/repository/chat-session.repository.js";

// A single backend process owns the directory. Atomic replacement prevents partial reads.
/** 将会话保存为 JSON 文件，读取时校验实体并还原日期类型。 */
export class JsonChatSessionRepository implements ChatSessionRepository {
    constructor(private readonly directory: string) { }
    async save(session: ChatSession): Promise<void> {
        if (!/^[a-zA-Z0-9-]+$/.test(session.requestId)) throw new Error("Invalid request ID");
        const destination = join(this.directory, `${session.requestId}_${session.createdAt.getTime()}.json`);
        await atomicWriteFile(destination, JSON.stringify(session, null, 2));
    }
    async findById(id: string): Promise<ChatSession | null> {
        return (await this.findAll()).find(session => session.id === id) ?? null;
    }
    async findAll(): Promise<ChatSession[]> {
        await mkdir(this.directory, { recursive: true });
        const names = (await readdir(this.directory)).filter(name => name.endsWith(".json"));
        const readSession = async (name: string): Promise<ChatSession> => {
            const value = JSON.parse(await readFile(join(this.directory, name), "utf8"));
            if (!value || typeof value.id !== "string" || typeof value.requestId !== "string"
                || typeof value.title !== "string" || !Array.isArray(value.messages)
                || !value.messages.every((m: any) => m && typeof m.id === "string"
                    && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
                || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) {
                throw new Error("Invalid session file");
            }
            if (!isSessionStatus(value.sessionStatus)) throw new Error("Invalid session status");
            if (!Object.hasOwn(value, "sessionError")) throw new Error("Missing session error state");
            if (value.sessionError != null && (typeof value.sessionError.code !== "string"
                || typeof value.sessionError.message !== "string" || !Number.isInteger(value.sessionError.httpStatusCode)
                || value.sessionError.httpStatusCode < 400 || value.sessionError.httpStatusCode > 599)) {
                throw new Error("Invalid session error");
            }
            return { ...value, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) } as ChatSession;
        };
        const sessions: ChatSession[] = [];
        // Bound open files and transient JSON buffers as the history grows.
        // Invalid records still reject the read, preserving the existing contract.
        for (let offset = 0; offset < names.length; offset += 16) {
            sessions.push(...await Promise.all(names.slice(offset, offset + 16).map(readSession)));
        }
        return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    }
}
