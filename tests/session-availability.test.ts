import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ChatSessionService } from "../src/modules/chat/service/chat-session.service.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";

for (const cancelled of [false, true]) {
    test(`${cancelled ? "cancellation" : "timeout"} releases a session even when its agent ignores AbortSignal`, async () => {
        const repository = new InMemoryChatSessionRepository();
        let complete!: (result: { content: string }) => void;
        let started!: () => void;
        const running = new Promise<void>(resolve => { started = resolve; });
        let calls = 0;
        const service = new ChatSessionService(repository, {
            run: async () => {
                if (++calls > 1) return { content: "next answer" };
                started();
                return new Promise(resolve => { complete = resolve; });
            },
            titleFor: async session => session.title,
        }, undefined, cancelled ? 1000 : 20);
        const session = await service.create("test", "request");
        const controller = new AbortController();
        const pending = service.send(session.id, "slow question", controller.signal);
        await running;
        if (cancelled) controller.abort();
        const settled = await Promise.race([pending.then(() => true), delay(150).then(() => false)]);
        // Always settle the non-cooperating agent, including when this assertion fails.
        complete({ content: "late answer" });
        await pending;
        assert.equal(settled, true, "the request must finish before the ignored agent completes");
        assert.equal((await repository.findById(session.id))?.sessionStatus, "failure");
        assert.deepEqual((await repository.findById(session.id))?.messages, []);
        const recovered = await service.send(session.id, "next question");
        assert.equal(recovered.sessionStatus, "finished");
        assert.deepEqual(recovered.messages.map(message => message.content), ["next question", "next answer"]);
    });
}
