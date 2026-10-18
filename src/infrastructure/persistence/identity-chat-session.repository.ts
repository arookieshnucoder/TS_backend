import type { ChatSessionRepository } from "../../modules/chat/repository/chat-session.repository.js";
import type { ChatSession } from "../../modules/chat/entity/chat-session.entity.js";
import { identity } from "../../modules/auth/identity.js";

/** The same scoped port is used by HTTP and agent memory tools. Legacy ownerless data stays private. */
export class IdentityChatSessionRepository implements ChatSessionRepository {
    constructor(private readonly repository: ChatSessionRepository) { }
    async save(session: ChatSession) {
        const owner = identity.getStore()?.userId;
        if (owner) {
            if (session.ownerId && session.ownerId !== owner) throw new Error("Session owner mismatch");
            session = { ...session, ownerId: owner };
        }
        await this.repository.save(session);
    }
    async findAll() {
        const all = await this.repository.findAll();
        const owner = identity.getStore()?.userId;
        return owner ? all.filter(session => session.ownerId === owner) : all;
    }
    async findById(id: string) {
        const session = await this.repository.findById(id);
        const owner = identity.getStore()?.userId;
        return session && (!owner || session.ownerId === owner) ? session : null;
    }
}
