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

test("internal REST callbacks commit 200/400, reject stale requests and never overwrite a completed result",async()=>{
  const repo=new InMemoryChatSessionRepository();
  const config=loadConfig({NODE_ENV:"test",INTERNAL_API_TOKEN:"test-internal-token"});
  let release!:(text:string)=>void;
  const server=createApp(config,createDependencies({
    contextHarness:null,chatSessionRepository:repo,chatModel:{reply:()=>new Promise(resolve=>{release=resolve})},
    logger:{info(){},error(){}},
  },config)).listen(0,"127.0.0.1");
  await once(server,"listening");
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth={Authorization:"Bearer test-internal-token"};
  const post=(path:string,body:unknown,internal=false)=>fetch(base+path,{method:"POST",
    headers:{"Content-Type":"application/json",...(internal?auth:{})},body:JSON.stringify(body)});
  async function pending(id:string) {
    for(let i=0;i<100;i++) {
      const session=await repo.findById(id);
      if(session?.sessionStatus==="pending" && release)return session;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.fail("Model request never entered pending");
  }
  try {
    const {data:created}=await (await post("/api/chat/sessions",{title:"new"})).json() as any;
    const path=`/internal/chat/sessions/${created.id}/result`;
    assert.equal((await fetch(base+path)).status,401);
    assert.equal((await fetch(base+path,{headers:{Authorization:"Bearer wrong"}})).status,401);
    assert.equal((await fetch(base+path,{headers:{...auth,Origin:"http://localhost:5173"}})).status,403);
    assert.equal((await fetch(base+path.replace("/internal","/api"))).status,404);
    const send=post(`/api/chat/sessions/${created.id}/messages`,{content:"hello"});
    const current=await pending(created.id);
    assert.equal((await post(`/api/chat/sessions/${created.id}/messages`,{content:"duplicate"})).status,409);
    assert.equal((await post(path,{requestId:"stale",httpStatusCode:400},true)).status,400);
    assert.equal((await repo.findById(created.id))?.sessionStatus,"pending");
    const success=await post(path,{requestId:current.modelRequestId,httpStatusCode:200,content:"callback answer"},true);
    assert.equal(success.status,200);
    assert.equal((await success.json() as any).data.sessionStatus,"finished");
    const duplicate=await post(path,{requestId:current.modelRequestId,httpStatusCode:400},true);
    assert.equal(duplicate.status,200);
    release("late model reply");
    const original=await send;
    assert.equal(original.status,200);
    const done=await original.json() as any;
    assert.equal(done.data.messages.length,2);
    assert.equal(done.data.messages[1].content,"callback answer");
    assert.equal((await fetch(base+path,{headers:auth})).status,200);

    const second=post(`/api/chat/sessions/${created.id}/messages`,{content:"second"});
    const next=await pending(created.id);
    assert.notEqual(next.modelRequestId,current.modelRequestId);
    assert.equal((await post(path,{requestId:current.modelRequestId,httpStatusCode:200,content:"wrong turn"},true)).status,400);
    const failed=await post(path,{requestId:next.modelRequestId,httpStatusCode:400},true);
    assert.equal(failed.status,400);
    assert.equal((await failed.json() as any).data.sessionStatus,"failure");
    release("late answer");
    assert.equal((await second).status,400);
    assert.equal((await fetch(base+path,{headers:auth})).status,400);
    assert.equal((await repo.findById(created.id))?.messages.length,2);

    const third=post(`/api/chat/sessions/${created.id}/messages`,{content:"empty"});
    const thirdSession=await pending(created.id);
    const empty=await post(path,{requestId:thirdSession.modelRequestId,httpStatusCode:200,content:" "},true);
    assert.equal(empty.status,400);
    release("late");
    assert.equal((await third).status,400);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("pending state is stored; success, failure, restart and retry preserve history",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"simple-chat-"));
  try {
    const repo=new JsonChatSessionRepository(dir);
    let text="answer";
    const service=new ChatSessionService(repo,{async reply(){return text}});
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
    const restarted=new ChatSessionService(new JsonChatSessionRepository(dir),{async reply(){return "recovered"}});
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
  const service=new ChatSessionService(repo,{reply:async(_messages,signal)=>{
    if(!slow)return "ok";
    return new Promise<string>((_resolve,reject)=>signal!.addEventListener("abort",()=>reject(signal!.reason),{once:true}));
  }},undefined,10);
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

test("internal route disabled without a token",async()=>{
  const config=loadConfig({NODE_ENV:"test"});
  const server=createApp(config,createDependencies({chatSessionRepository:new InMemoryChatSessionRepository(),logger:{info(){},error(){}}},config)).listen(0,"127.0.0.1");
  await once(server,"listening");
  try {assert.equal((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/chat/sessions/1/result`)).status,404);}
  finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
