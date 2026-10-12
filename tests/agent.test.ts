import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { LangChainChatModel } from "../src/infrastructure/llm/langchain-chat-model.js";
import { loadConfig } from "../src/config/env.js";
import { createChatAgent } from "../src/bootstrap/chat-agent.js";
import { LocalMemorySearch } from "../src/infrastructure/llm/memory-search.js";
import { TokenBudget } from "../src/modules/harness/context/tokens.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";
import { ChatSessionService } from "../src/modules/chat/service/chat-session.service.js";

const logger = {info(){},error(){}};

test("real LangChain adapter round-trips tool_calls and tool_call_id through the harness", async () => {
  const calls: any[] = [];
  const server = createServer(async (req,res) => {
    let raw = ""; for await(const part of req) raw += part;
    const request = JSON.parse(raw); calls.push(request);
    const title = request.messages[0]?.content.startsWith("Generate a session title");
    const first = calls.length === 1;
    res.setHeader("Content-Type","application/json");
    res.end(JSON.stringify({id:"test",object:"chat.completion",created:1,model:"test",choices:[{
      index:0,finish_reason:first ? "tool_calls" : "stop",
      message:first ? {role:"assistant",content:null,tool_calls:[{id:"real-call",type:"function",function:{name:"search_session_memory",arguments:'{"query":"姓名"}'}}]} :
        {role:"assistant",content:title ? "用户姓名记录与会话回顾" : "没有找到之前记录的姓名。"},
    }]}));
  }).listen(0,"127.0.0.1");
  await once(server,"listening");
  try {
    const config = loadConfig({LLM_API_KEY:"test-key",LLM_MODEL:"test",LLM_BASE_URL:`http://127.0.0.1:${(server.address() as AddressInfo).port}`});
    const model = new LangChainChatModel(config), repository = new InMemoryChatSessionRepository();
    const harness = createChatAgent(repository,model,()=>new LocalMemorySearch(new TokenBudget(config.context)),config.context,logger);
    const service = new ChatSessionService(repository,harness);
    const session = await service.create("新对话","request");
    const result = await service.send(session.id,"我的姓名是什么？");
    assert.equal(result.sessionStatus,"finished");
    assert.equal(result.title,"用户姓名记录与会话回顾");
    assert.equal(calls.length,3);
    assert.equal(calls[0].tools[0].function.name,"search_session_memory");
    assert.equal(calls[1].messages.find((m:any)=>m.role==="tool").tool_call_id,"real-call");
    assert.equal(calls[1].messages.find((m:any)=>m.tool_calls)?.tool_calls[0].id,"real-call");
    assert.equal(result.messages.length,2,"tool protocol never enters visible history");
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("agent refuses endless tool loops and aborts retrieval before model invocation", async () => {
  const config = loadConfig({AGENT_MAX_TOOL_STEPS:"2"}).context;
  const repository = new InMemoryChatSessionRepository();
  let calls = 0;
  const model = {async turn(){calls++;return {content:"",toolCalls:[{id:String(calls),name:"search_session_memory",arguments:{query:"x"}}]};}};
  const harness = createChatAgent(repository,model,()=>new LocalMemorySearch(new TokenBudget(config)),config,logger);
  const service = new ChatSessionService(repository,harness);
  const s = await service.create("新对话","loop");
  assert.equal((await service.send(s.id,"hello")).sessionStatus,"failure");
  assert.equal(calls,3);
  assert.equal((await service.getById(s.id)).messages.length,0);
  const abort = new AbortController();abort.abort();
  await assert.rejects(harness.run(s,{id:"u",role:"user",content:"hello"},abort.signal),{name:"AbortError"});
  assert.equal(calls,3);
});
