import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { loadConfig } from "../src/config/env.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";

test("model failure is an actual HTTP 400 JSON response, even if client asks for the removed stream format",async()=>{
  const config=loadConfig({NODE_ENV:"test"});
  const server=createApp(config,createDependencies({chatSessionRepository:new InMemoryChatSessionRepository(),
    chatModel:{async reply(){throw Object.assign(new Error("private-key"),{status:401})}},logger:{info(){},error(){}}},config)).listen(0,"127.0.0.1");
  await once(server,"listening");
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat/sessions`;
  const post=(path:string,body:unknown)=>fetch(path,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/x-ndjson"},body:JSON.stringify(body)});
  try {
    const invalid=await post(base,{title:""});
    assert.equal(invalid.status,400);
    const {data}=await (await post(base,{title:"test"})).json() as any;
    const response=await post(`${base}/${data.id}/messages`,{content:"hello"});
    assert.equal(response.status,400);
    assert.match(response.headers.get("content-type")!,/application\/json/);
    const body=await response.json() as any;
    assert.equal(body.httpStatusCode,400);
    assert.equal(body.data.sessionStatus,"failure");
    assert.equal(body.error.code,"MODEL_REQUEST_FAILED");
    assert.match(body.error.message,/401/);
    assert.doesNotMatch(JSON.stringify(body),/private-key/);
    assert.equal(body.requestId,response.headers.get("x-request-id"));
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
