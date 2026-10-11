import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { JsonChatSessionRepository } from "../src/infrastructure/persistence/json/json-chat-session.repository.js";
import { LangChainChatModel } from "../src/infrastructure/llm/langchain-chat-model.js";
import { ChatSessionService } from "../src/modules/chat/service/chat-session.service.js";

test("JSON HTTP sessions survive restart; real LangChain adapter sends managed context without persisting credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-json-"));
  const calls: any[] = [];
  let upstreamStatus = 200;
  let empty = false;
  const upstream = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader("Content-Type", "application/json");
    if (upstreamStatus !== 200) { res.writeHead(upstreamStatus); res.end(JSON.stringify({error:{message:"secret-test-key"}})); return; }
    res.end(JSON.stringify({ id: "completion-1", object: "chat.completion", created: 1, model: "deepseek-flash",
      choices: [{ index: 0, message: { role: "assistant", content: empty ? "" : calls.at(-1).body.messages[0]?.content.startsWith("Generate a session title") ? "用户姓名记录与对话回顾" : "真实适配器测试回复" }, finish_reason: "stop" }],
      usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2} }));
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const config = loadConfig({ NODE_ENV: "test", SESSION_DATA_DIR: directory, LLM_API_KEY: "secret-test-key",
    LLM_MODEL: "deepseek-flash", LLM_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` });
  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  async function start() {
    server = createApp(config, createDependencies({logger:{info(){},error(){}}}, config)).listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat/sessions`;
  }
  async function close() { server?.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  const post = (url: string, body: unknown) => fetch(url, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  try {
    let base = await start();
    const response = await post(base, {title:"新对话"});
    const {data: created} = await response.json() as any;
    const filename = `${response.headers.get("x-request-id")}_${Date.parse(created.createdAt)}.json`;
    assert.deepEqual(await readdir(directory), [filename]);
    let sent = await post(`${base}/${created.id}/messages`, {content:"我叫小明"});
    assert.equal(sent.status, 200);
    const {data: first} = await sent.json() as any;
    assert.equal(first.title, "用户姓名记录与对话回顾");
    assert.equal(first.messages.length, 2);
    await close(); base = await start();
    const restored = await (await fetch(`${base}/${created.id}`)).json() as any;
    assert.deepEqual(restored.data, first);
    sent = await post(`${base}/${created.id}/messages`, {content:"我叫什么？"});
    assert.equal(sent.status, 200);
    assert.equal(calls[2].path, "/chat/completions");
    assert.equal(calls[2].authorization, "Bearer secret-test-key");
    assert.equal(calls[2].body.model, "deepseek-flash");
    assert.match(calls[2].body.messages.map((m:any)=>m.content).join("\n"), /我叫小明/);
    assert.equal(calls[2].body.messages.at(-1).content, "我叫什么？");
    const disk = await readFile(join(directory,filename),"utf8");
    assert.doesNotMatch(disk,/secret-test-key|authorization|llmApiKey/);
    assert.equal(JSON.parse(disk).messages.length,4);
    for (const content of ["", " ", 42, "x".repeat(12001)]) {
      assert.equal((await post(`${base}/${created.id}/messages`,{content})).status,400);
    }
    assert.equal((await post(`${base}/missing/messages`,{content:"hi"})).status,404);
    for (const status of [401, 429, 500]) {
      upstreamStatus = status;
      const beforeCalls = calls.length;
      const failed = await post(`${base}/${created.id}/messages`,{content:"失败"});
      assert.equal(failed.status,400);
      const body = await failed.text();
      assert.match(body,new RegExp("HTTP " + status));
      assert.doesNotMatch(body,/secret-test-key/);
      assert.equal(calls.length,beforeCalls+1,"no retries or alternate model calls");
    }
    upstreamStatus = 200; empty = true;
    assert.equal((await post(`${base}/${created.id}/messages`,{content:"空回复"})).status,400);
    const failureState = JSON.parse(await readFile(join(directory,filename),"utf8"));
    assert.deepEqual(failureState.messages, JSON.parse(disk).messages);
    assert.equal(failureState.sessionStatus, "failure");
    assert.equal(failureState.sessionError.httpStatusCode, 400);
    assert.deepEqual(await readdir(directory),[filename]);
  } finally {
    if(server?.listening) await close();
    upstream.closeAllConnections(); await new Promise<void>(resolve=>upstream.close(()=>resolve()));
    // Keep test artifacts: repository policy forbids batch deletion.
  }
});

test("missing key, concurrent turns, cancellation and invalid disk data fail safely", async () => {
  await assert.rejects(new LangChainChatModel(loadConfig({})).reply([]), {code:"MODEL_REQUEST_FAILED",statusCode:400});
  const directory = await mkdtemp(join(tmpdir(),"chat-lock-"));
  const repository = new JsonChatSessionRepository(directory);
  let release!: (value:string)=>void;
  const service = new ChatSessionService(repository,{ reply:()=>new Promise(resolve=>{release=resolve}) });
  try {
    const session = await service.create("失败","request-1");
    const abort = new AbortController();
    const pending = service.send(session.id,"first",abort.signal);
    while (!release) await new Promise(resolve=>setTimeout(resolve,5));
    await assert.rejects(service.send(session.id,"second"),{code:"SESSION_BUSY"});
    abort.abort(); release("cancelled");
    assert.equal((await pending).sessionStatus,"failure");
    assert.equal((await repository.findById(session.id))?.messages.length,0);
    await writeFile(join(directory,"broken.json"),"{}");
    await assert.rejects(repository.findAll(),/Invalid session file/);
    await assert.rejects(repository.save({...session,requestId:"../escape"}),/Invalid request ID/);
  } finally { // Keep test artifacts: repository policy forbids batch deletion.
  }
});
