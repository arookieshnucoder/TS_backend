import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { loadConfig } from "../src/config/env.js";

// Default mode uses a real local OpenAI-compatible HTTP endpoint. --live uses the configured provider.
const live = process.argv.includes("--live");
const configured = loadConfig();
configured.math.variant = "general"; // This smoke verifies the preserved generic baseline, not the math profile.
if (live && !configured.llmApiKey) {
  console.error("Live smoke requires LLM_API_KEY in the launching terminal. No provider request was made.");
  process.exitCode = 2;
} else {
  const fixture = await mkdtemp(join(tmpdir(), "ask-agent-smoke-"));
  const workspace = join(fixture, "workspace"), sessions = join(fixture, "sessions");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "answer.ts"), '// Smoke fixture\nexport const answer = "ask-harness-ready";\n');
  const upstreamRequests: any[] = [];
  const events: { name: string; fields?: Record<string, unknown> }[] = [];
  let upstream: Server | undefined, backend: Server | undefined;
  const close = async (server?: Server) => {
    if (!server?.listening) return;
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  try {
    if (!live) {
      upstream = createServer(async (req, res) => {
        let raw = ""; for await (const part of req) raw += part;
        const body = JSON.parse(raw); upstreamRequests.push(body);
        assert.equal(req.url, "/chat/completions");
        const title = body.messages[0]?.content.startsWith("Generate a session title");
        const results = body.messages.filter((message: any) => message.role === "tool");
        const tool = (id: string, name: string, input: Record<string, unknown>) => ({ role: "assistant", content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }] });
        let message: any;
        if (title) message = { role: "assistant", content: "本地问答代理工作流程验证" };
        else if (!results.length) message = tool("search-1", "search_workspace", { path: "src", query: "answer" });
        else if (results.length === 1) {
          assert.equal(results[0].tool_call_id, "search-1");
          assert.match(results[0].content, /src\/answer.ts/);
          message = tool("read-2", "read_file", { path: "src/answer.ts", startLine: 1, endLine: 3 });
        } else {
          assert.equal(results[1].tool_call_id, "read-2");
          assert.match(results[1].content, /ask-harness-ready/);
          message = { role: "assistant", content: "src/answer.ts:2 将 answer 导出为 ask-harness-ready。" };
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: "smoke", object: "chat.completion", created: 1, model: "smoke-model",
          choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
      }).listen(0, "127.0.0.1");
      await once(upstream, "listening");
    }
    const config = { ...configured, sessionDataDir: sessions,
      context: { ...configured.context, elasticsearchUrl: undefined, embeddingBaseUrl: undefined, embeddingModel: undefined },
      harness: { ...configured.harness, workspaceRoot: workspace },
      ...(live ? {} : { llmBaseUrl: `http://127.0.0.1:${(upstream!.address() as AddressInfo).port}`, llmApiKey: "smoke-local", llmModel: "smoke-model" }) };
    const start = async () => {
      backend = createApp(config, createDependencies({ logger: {
        info(name, fields) { events.push({ name, fields }); }, error(name, fields) { events.push({ name, fields }); },
      } }, config)).listen(0, "127.0.0.1");
      await once(backend, "listening");
      return `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    };
    let base = await start();
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const created = await post("/api/chat/sessions", { title: "新对话" });
    assert.equal(created.status, 201);
    const { data: initial } = await created.json() as any;
    const answer = await post(`/api/chat/sessions/${initial.id}/messages`, { content: "请使用工作区工具查找 answer 的定义并读取源码，告诉我导出的字符串值，引用文件路径和行号。" });
    const { data: result } = await answer.json() as any;
    assert.equal(answer.status, 200, result?.sessionError?.message);
    assert.equal(result.sessionStatus, "finished");
    assert.match(result.messages.at(-1).content, /ask-harness-ready/);
    assert.equal(result.messages.length, 2);
    assert.ok(events.some(event => event.name === "agent.tool" && event.fields?.status === "success"));
    if (!live) {
      assert.equal(upstreamRequests.length, 4, "search, read, answer, title");
      assert.deepEqual(events.filter(event => event.name === "agent.tool").map(event => event.fields?.tool), ["search_workspace", "read_file"]);
    }
    const disk = JSON.parse(await readFile(join(sessions, (await readdir(sessions))[0]!), "utf8"));
    assert.deepEqual(disk.messages.map((message: any) => message.role), ["user", "assistant"]);
    await close(backend); base = await start();
    const restored = await (await fetch(`${base}/api/chat/sessions/${initial.id}`)).json() as any;
    assert.deepEqual(restored.data, result);
    console.log(JSON.stringify({ mode: live ? "live-provider" : "local-http", status: "passed", toolCalls: events.filter(event => event.name === "agent.tool").length,
      persistedMessages: result.messages.length, restartRestored: true, fixture }, null, 2));
  } finally { await close(backend); await close(upstream); }
}
