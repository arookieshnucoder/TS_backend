import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteFile } from "../src/common/persistence/atomic-write.js";
import { JsonChatSessionRepository } from "../src/infrastructure/persistence/json/json-chat-session.repository.js";

test("atomic replacement preserves complete UTF-8 content and leaves no temporary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "atomic-content-"));
    const file = join(root, "nested", "session.json");
    await atomicWriteFile(file, JSON.stringify({ text: "原始内容" }));
    const content = JSON.stringify({ text: "更新内容 👨‍👩‍👧‍👦".repeat(1000) });
    const writing = atomicWriteFile(file, content);
    const observed = JSON.parse(await readFile(file, "utf8"));
    assert.ok(observed.text === "原始内容" || observed.text === JSON.parse(content).text);
    await writing;
    assert.equal(await readFile(file, "utf8"), content);
    assert.deepEqual(await readdir(join(root, "nested")), ["session.json"]);
});

test("failed replacement cleans only its own temporary file and retains the destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "atomic-failure-"));
    const destination = join(root, "existing-directory");
    await mkdir(destination);
    await writeFile(join(destination, "keep.txt"), "existing data");
    await assert.rejects(atomicWriteFile(destination, "must not replace a directory"));
    assert.deepEqual(await readdir(root), ["existing-directory"]);
    assert.equal(await readFile(join(destination, "keep.txt"), "utf8"), "existing data");
});

test("bounded session reads retain every record, descending date order and date types", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-batches-"));
    const repository = new JsonChatSessionRepository(root);
    for (let i = 0; i < 35; i++) {
        const date = new Date(Date.UTC(2026, 0, 1, 0, i));
        await repository.save({ id: `s-${i}`, requestId: `r-${i}`, title: `会话 ${i}`, createdAt: date, updatedAt: date,
            messages: [], sessionStatus: "finished", sessionError: null });
    }
    const sessions = await repository.findAll();
    assert.deepEqual(sessions.map(session => session.id), Array.from({ length: 35 }, (_, i) => `s-${34 - i}`));
    assert.ok(sessions.every(session => session.createdAt instanceof Date && session.updatedAt instanceof Date));
    assert.equal((await repository.findById("s-17"))?.title, "会话 17");
    await writeFile(join(root, "zz-invalid.json"), "{}");
    await assert.rejects(repository.findAll(), /Invalid session file/);
});
