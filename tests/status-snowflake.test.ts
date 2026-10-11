import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SnowflakeIdGenerator } from "../src/utils/snowflake.js";
import { createApp } from "../src/app.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { loadConfig } from "../src/config/env.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";
import { JsonChatSessionRepository } from "../src/infrastructure/persistence/json/json-chat-session.repository.js";
import { ChatSessionService } from "../src/modules/chat/service/chat-session.service.js";
import { testHarness, textModel } from "./helpers.js";

test("snowflake uniqueness, worker bits, overflow and clock rollback",()=>{
  let now=SnowflakeIdGenerator.epoch+1000;
  const generator=new SnowflakeIdGenerator(37,()=>now);
  const ids=Array.from({length:4096},()=>generator.nextId());
  assert.equal(new Set(ids).size,4096);
  assert.equal(BigInt(ids[0])>>22n,1000n);
  assert.equal((BigInt(ids[0])>>12n)&1023n,37n);
  assert.throws(()=>generator.nextId(),/exhausted/);
  now++; assert.ok(BigInt(generator.nextId())>BigInt(ids.at(-1)!));
  now--; assert.throws(()=>generator.nextId(),/backwards/);
  assert.throws(()=>new SnowflakeIdGenerator(1024),/WORKER/);
});

test("removed result endpoints cannot bypass a pending agent run", async () => {
  const repo = new InMemoryChatSessionRepository();
  const config = loadConfig({ NODE_ENV: "test", INTERNAL_API_TOKEN: "obsolete-token" });
  let release!: (text: string) => void;
  const server = createApp(config, createDependencies({ chatSessionRepository: repo,
    agentHarness: testHarness(repo, textModel(() => new Promise(resolve => { release = resolve; }))),
    logger: { info() {}, error() {} },
  }, config)).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: {
    "Content-Type": "application/json", Authorization: "Bearer obsolete-token",
  }, body: JSON.stringify(body) });
  try {
    const { data: created } = await (await post("/api/chat/sessions", { title: "new" })).json() as any;
    const pending = post(`/api/chat/sessions/${created.id}/messages`, { content: "hello" });
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(release, "Agent must have started");
    assert.equal((await post(`/api/chat/sessions/${created.id}/messages`, { content: "duplicate" })).status, 409);
    const running = (await repo.findById(created.id))!;
    const path = `/internal/chat/sessions/${created.id}/result`;
    assert.equal((await post(path, { requestId: running.modelRequestId, httpStatusCode: 200, content: "injected answer" })).status, 404);
    assert.equal((await fetch(base + path)).status, 404);
    assert.equal((await repo.findById(created.id))!.sessionStatus, "pending");
    assert.equal((await repo.findById(created.id))!.messages.length, 0);
    release("agent answer");
    const response = await pending;
    assert.equal(response.status, 200);
    const { data: result } = await response.json() as any;
    assert.deepEqual(result.messages.map((message: any) => message.content), ["hello", "agent answer"]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("pending state is stored; success, failure, restart and retry preserve history",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"simple-chat-"));
  try {
    const repo=new JsonChatSessionRepository(dir);
    let text="answer";
    const service=new ChatSessionService(repo,testHarness(repo,textModel(async () => text)));
    const session=await service.create("title","request-1");
    assert.equal((await service.send(session.id,"hello")).sessionStatus,"finished");
    text=" ";
    const failure=await service.send(session.id,"empty");
    assert.equal(failure.sessionStatus,"failure");
    assert.equal(failure.sessionError?.httpStatusCode,400);
    assert.equal(failure.messages.length,2);
    const file=join(dir,(await readdir(dir))[0]);
    const disk=JSON.parse(await readFile(file,"utf8"));
    assert.equal(disk.sessionStatus,"failure");
    disk.sessionStatus="pending";
    await writeFile(file,JSON.stringify(disk));
    const restoredRepo = new JsonChatSessionRepository(dir);
    const restarted=new ChatSessionService(restoredRepo,testHarness(restoredRepo,textModel(async () => "recovered")));
    assert.equal((await restarted.getById(session.id)).sessionStatus,"failure");
    assert.equal((await restarted.send(session.id,"retry")).sessionStatus,"finished");
    const abort=new AbortController();abort.abort();
    assert.equal((await restarted.send(session.id,"cancel",abort.signal)).sessionStatus,"failure");
  } finally {// Keep test artifacts: repository policy forbids batch deletion.
  }
});

test("timeout maps to failure/400 and a retry can succeed",async()=>{
  const repo=new InMemoryChatSessionRepository();
  let slow=true;
  const service=new ChatSessionService(repo,testHarness(repo,textModel(async(_messages,signal)=>{
    if(!slow)return "ok";
    return new Promise<string>((_resolve,reject)=>signal!.addEventListener("abort",()=>reject(signal!.reason),{once:true}));
  })),undefined,10);
  const session=await service.create("timeout","request-1");
  // Keep event loop alive because AbortSignal.timeout uses an unref'd timer.
  const keepAlive=setTimeout(()=>{},1000);
  try {
    const failed=await service.send(session.id,"hello");
    assert.equal(failed.sessionStatus,"failure");
    assert.equal(failed.sessionError?.httpStatusCode,400);
    slow=false;
    assert.equal((await service.send(session.id,"retry")).sessionStatus,"finished");
  } finally {clearTimeout(keepAlive)}
});
