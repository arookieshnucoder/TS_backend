import assert from "node:assert/strict";
import test from "node:test";
import { loadContextConfig } from "../src/modules/harness/context/config.js";
import { TokenBudget } from "../src/modules/harness/context/tokens.js";
import { ContextCompressor } from "../src/modules/harness/context/services.js";
import { SessionTitleGenerator, SharedMemoryRetriever, validTitle } from "../src/modules/chat/service/context-services.js";
import { createChatAgent } from "../src/bootstrap/chat-agent.js";
import { LocalMemorySearch, ElasticsearchMemorySearch } from "../src/infrastructure/llm/memory-search.js";
import { InMemoryChatSessionRepository } from "../src/infrastructure/persistence/memory/in-memory-chat-session.repository.js";
import { ChatSessionService } from "../src/modules/chat/service/chat-session.service.js";
import type { ChatSession } from "../src/modules/chat/entity/chat-session.entity.js";
import type { MemorySearch } from "../src/modules/chat/service/memory-search.js";
import type { AgentMessage } from "../src/modules/agent/contracts.js";
import { textModel } from "./helpers.js";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

const config = loadContextConfig({ LLM_MAX_INPUT_TOKENS: "4096" });
const tokens = new TokenBudget(config);
const logger = { info() {}, error() {} };
const session = (id = "one", title = "上下文管理功能设计方案"): ChatSession => ({ id, title, requestId: id,
  createdAt: new Date(), updatedAt: new Date(), messages: [], sessionStatus: "finished", sessionError: null });

test("512/1024 chunks cover multilingual text with bounded overlap and no corrupt Unicode", () => {
  const source = "上下文检索😀 English conversation with facts. ".repeat(150);
  for (const size of [512, 1024]) {
    const chunks = tokens.chunks(source, size);
    assert.ok(chunks.length > 1);
    let rebuilt = chunks[0]!;
    for (const chunk of chunks.slice(1)) {
      let overlap = Math.min(rebuilt.length, chunk.length);
      while (overlap && rebuilt.slice(-overlap) !== chunk.slice(0, overlap)) overlap--;
      // Repeated source has ambiguous overlap, so independently check coverage below.
      assert.ok(overlap > 0);
      rebuilt += chunk.slice(overlap);
    }
    assert.ok(chunks.every(chunk => tokens.count(chunk) <= size && !chunk.includes("�")));
    assert.equal(chunks[0], source.slice(0, chunks[0]!.length));
    assert.ok(source.endsWith(chunks.at(-1)!));
  }
  const unique = Array.from({length: 500}, (_, i) => `项目${i}说明`).join(" ");
  const chunks = tokens.chunks(unique, 128);
  let position = 0;
  for (let i = 0; i < chunks.length; i++) {
    const start = unique.indexOf(chunks[i]!, Math.max(0, position - 100));
    assert.ok(start >= 0 && start <= position);
    if (i) assert.ok(tokens.count(unique.slice(start, position)) <= Math.ceil(128 * .15));
    position = start + chunks[i]!.length;
  }
  assert.equal(position, unique.length);
  assert.throws(() => loadContextConfig({ CONTEXT_OVERLAP_RATIO: ".16" }));
  for (const [key, value] of [["CONTEXT_COMPRESSION_TRIGGER", ".71"], ["CONTEXT_COMPRESSION_TARGET", ".11"], ["LLM_MAX_INPUT_TOKENS", "0"]])
    assert.throws(() => loadContextConfig({ [key!]: value }));
});

test("map/reduce compression bounds its own inputs and outputs", async () => {
  const calls: string[] = [];
  const compression = new ContextCompressor(textModel(async messages => { calls.push(messages[0]!.content); return "用户偏好中文，项目使用向量检索。"; }), tokens, config);
  const result = await compression.execute({ text: "用户偏好中文，项目使用向量检索。".repeat(1000), budget: 100 });
  assert.ok(tokens.count(result) <= 100);
  assert.ok(calls.length > 1);
  assert.ok(calls.every(call => tokens.count(call) < config.maxInputTokens));
  await assert.rejects(new ContextCompressor(textModel(async () => ""), tokens, config).execute({ text: "a ".repeat(500), budget: 10 }), /Empty/);
});

test("title validates both languages, retries invalid output and freezes after five completed turns", async () => {
  assert.ok(validTitle("上下文管理功能设计方案"));
  assert.ok(validTitle("Designing reusable tools for conversation memory"));
  for (const value of ["太短", "one two", "中".repeat(16), "one two three four five\nsix"]) assert.equal(validTitle(value), false);
  let calls = 0;
  const tool = new SessionTitleGenerator(textModel(async () => ++calls === 1 ? "短" : "上下文管理功能设计方案"), tokens, config);
  const s = session(); s.messages.push({id:"u",role:"user",content:"上下文"});
  assert.equal(await tool.execute(s), "上下文管理功能设计方案");
  assert.equal(calls, 2);
  s.messages = Array.from({length:6}, (_, i) => ({id:String(i), role:"user",content:"new topic"}));
  s.title = "已经冻结的会话标题示例";
  assert.equal(await tool.execute(s), s.title);
  assert.equal(calls, 2);
});

test("harness text generation uses turn without tools, honors output limits and rejects tool requests", async () => {
  const requests: number[] = [];
  const invalidModel = { async turn(_messages: AgentMessage[], tools: unknown[], _signal?: AbortSignal, maxOutputTokens?: number) {
    assert.deepEqual(tools, []);
    assert.ok(maxOutputTokens && maxOutputTokens > 0);
    requests.push(maxOutputTokens!);
    return { content: "上下文管理功能设计方案", toolCalls: [{ id: "bad", name: "read_file", arguments: {} }] };
  } };
  await assert.rejects(new ContextCompressor(invalidModel, tokens, config).execute({ text: "history ".repeat(200), budget: 32 }), /invalid context summary/);
  const s = session(); s.messages = [{ id: "u", role: "user", content: "topic" }];
  await assert.rejects(new SessionTitleGenerator(invalidModel, tokens, config).execute(s), /Unexpected tool call/);
  assert.equal(requests.at(-1), 96);
});

test("shared memory considers ten most recent sessions and summarizes only title matches", async () => {
  const sessions = Array.from({length:12}, (_, i) => ({ ...session(String(i)), updatedAt: new Date(i * 1000),
    messages: [{id:"u",role:"user" as const,content:`source ${i}`}]}));
  let candidates: string[] = [];
  const search: MemorySearch = { async sync() {}, async search() { return []; }, async titles(_query, ids) { candidates = ids; return ["11", "0"]; } };
  const tool = new SharedMemoryRetriever(search, new ContextCompressor(textModel(async () => "summary"), tokens, config), config);
  const result = await tool.execute({sessions,query:"上下文"});
  assert.deepEqual(candidates, ["11","10","9","8","7","6","5","4","3","2"]);
  assert.match(result, /source 11/);
  assert.doesNotMatch(result, /source 0/);
});

test("agent invokes tools, compacts long histories, preserves storage, and freezes title across service recreation", async () => {
  const repository = new InMemoryChatSessionRepository();
  let titleCalls = 0, turns = 0;
  const events: string[] = [];
  const requests: AgentMessage[][] = [];
  const model = {
    async turn(messages: AgentMessage[]) {
      if (messages[0]!.content.startsWith("Generate")) { titleCalls++; return { content: titleCalls < 3 ? "上下文管理功能设计方案" : "跨会话记忆检索设计方案", toolCalls: [] }; }
      if (messages[0]!.content.startsWith("Summarize")) return { content: "用户要求保留历史，使用检索管理上下文。", toolCalls: [] };
      requests.push(structuredClone(messages));
      if (turns++ === 0) return {content:"",toolCalls:[{id:"call1",name:"search_session_memory",arguments:{query:"历史"}}]};
      return {content:"已完成回答",toolCalls:[]};
    },
  };
  const harness = createChatAgent(repository, model, () => new LocalMemorySearch(tokens), config,
    { info(event) { events.push(event); }, error() {} });
  let service = new ChatSessionService(repository, harness);
  const s = await service.create("新对话", "req-test");
  for (let i = 0; i < 6; i++) {
    const result = await service.send(s.id, i < 2 ? "历史信息 ".repeat(180) : "下一轮");
    assert.equal(result.sessionStatus, "finished");
    if (i === 4) service = new ChatSessionService(repository, harness);
  }
  assert.equal(titleCalls, 5);
  assert.equal((await service.getById(s.id)).title, "跨会话记忆检索设计方案");
  assert.equal((await service.getById(s.id)).messages.length, 12);
  assert.equal((await service.getById(s.id)).messages[0]!.content, "历史信息 ".repeat(180));
  assert.ok(requests.some(messages => messages.some(m => m.role === "tool" && m.toolCallId === "call1")));
  assert.ok(requests.every(messages => tokens.count(JSON.stringify(messages)) < config.maxInputTokens * .65));
  assert.ok(events.includes("context.compressed"));
});

test("oversized current input and unknown agent tools fail without storing a partial turn", async () => {
  const repository = new InMemoryChatSessionRepository();
  let calls = 0;
  const model = { async turn(){ calls++; return {content:"",toolCalls:[{id:"bad",name:"delete_files",arguments:{query:"x"}}]};} };
  const harness = createChatAgent(repository,model,()=>new LocalMemorySearch(tokens),config,logger);
  const s = session(); await repository.save(s);
  await assert.rejects(harness.run(s,{id:"u",role:"user",content:"中".repeat(10000)}),/Current message/);
  assert.equal(calls, 0);
  const service = new ChatSessionService(repository,harness);
  assert.equal((await service.send(s.id,"hello")).sessionStatus,"failure");
  assert.equal((await repository.findById(s.id))!.messages.length,0);
});

test("Elasticsearch adapter indexes vectors and fuses filtered BM25/kNN through real HTTP", async () => {
  const requests: {url:string;body:any}[] = [];
  const storedIds = new Set<string>();
  const server = createServer(async (req,res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({url:req.url!,body});
    res.setHeader("Content-Type","application/json");
    if(req.method === "HEAD") {res.writeHead(404);res.end();return;}
    if(req.url === "/embeddings") {res.end(JSON.stringify({data:[{embedding:[1,0,0]}]}));return;}
    if(req.url?.includes("/_mget")) {res.end(JSON.stringify({docs:body.ids.map((id:string)=>({_id:id,found:storedIds.has(id)}))}));return;}
    if(req.url?.includes("/_doc/")) storedIds.add(req.url.split("/_doc/")[1]!);
    if(req.url?.endsWith("/_search")) {
      res.end(JSON.stringify({hits:{hits:[{_id:"hit",_source:{id:"hit",sessionId:"one",title:"上下文",text:"remember"}}]}}));return;
    }
    res.end(JSON.stringify({acknowledged:true}));
  }).listen(0,"127.0.0.1");
  await once(server,"listening");
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const settings = loadContextConfig({ELASTICSEARCH_URL:url,EMBEDDING_BASE_URL:url,EMBEDDING_MODEL:"test-embedding",EMBEDDING_DIMENSIONS:"3"});
    const search = new ElasticsearchMemorySearch(tokens,settings);
    const s = session(); s.messages = [{id:"m",role:"user",content:"remember"}];
    await search.sync([s]);
    const embedded = requests.filter(r => r.url === "/embeddings").length;
    // A new adapter represents a process/request restart; stored chunks must not be re-embedded.
    await new ElasticsearchMemorySearch(tokens,settings).sync([s]);
    assert.equal(requests.filter(r => r.url === "/embeddings").length, embedded);
    assert.deepEqual(await search.titles("上下文",[s.id]),[s.id]);
    assert.equal((await search.search("remember",[s.id],8)).length,1,"RRF deduplicates hits");
    const mapping = requests.find(r=>r.body?.mappings)!.body.mappings;
    assert.equal(mapping.properties.vector.dims,3);
    const queries = requests.filter(r=>r.url.endsWith("/_search"));
    assert.equal(queries.length,4);
    for(const request of queries) {
      const filter = request.body.knn?.filter ?? request.body.query.bool.filter;
      assert.deepEqual(filter[0],{terms:{sessionId:["one"]}});
      assert.ok(filter[2].terms.id.length > 0);
    }
    assert.ok(requests.some(r=>r.body?.vector?.length === 3));
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
