import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
if (!process.env.LLM_API_KEY) throw new Error("Live smoke requires LLM_API_KEY");
const directory = await mkdtemp(join(tmpdir(), "math-live-smoke-"));
const config = loadConfig({ ...process.env, NODE_ENV: "test", MATH_AGENT_VARIANT: "combined", LLM_MODEL: "glm-4.7", LLM_BASE_URL: "https://open.bigmodel.cn/api/paas/v4",
    SESSION_DATA_DIR: join(directory, "sessions"), MATH_SUBMISSIONS_PATH: join(directory, "questions"), AGENT_MODEL_ATTEMPT_TIMEOUT_MS: "120000", AGENT_TOOL_TIMEOUT_MS: "30000" });
const server = createApp(config).listen(0, "127.0.0.1"); await once(server, "listening");
try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (path: string, body: unknown) => { const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        assert.ok(response.ok, `HTTP ${response.status}`); return response.json(); };
    const session = (await post("/api/chat/sessions", { title: "数学真实链路测试" })).data;
    const result = (await post(`/api/chat/sessions/${session.id}/messages`, { content: "解方程 x²-5x+6=0。A.0和5 B.-2和-3 C.2和3 D.1和6。最后单独一行‘答案：选项字母’。" })).data;
    assert.match(result.messages.at(-1).content, /答案[：:]\s*\**C/);
    const submissions = await readdir(config.math.submissionsPath); assert.equal(submissions.length, 1);
    const record = JSON.parse(await readFile(join(config.math.submissionsPath, submissions[0]!), "utf8"));
    assert.equal(record.vector.length, 256); assert.equal(record.status, "solved_unverified"); assert.equal(record.trusted, false); assert.match(record.normalized, /x\^\{2\}/);
    const ocr = await fetch(`${base}/api/math/ocr`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); assert.equal(ocr.status, 501);
    const openResult = (await post(`/api/chat/sessions/${session.id}/messages`, { content: "求函数 y=x²-4x+1 的最小值。这是非选择题，请写实际数值并检验。" })).data;
    const openAnswer = openResult.messages.at(-1).content;
    assert.match(openAnswer, /-3/); assert.doesNotMatch(openAnswer, /(?:^|\n)\s*(?:\*\*)?答案[：:]\s*(?:\*\*)?[A-D](?:\s|$)/);
    console.log("LIVE PASS: HTTP → text normalization → vector persistence → hybrid RAG → GLM-4.7 solve → session/submission save; multiple-choice and open-question review; OCR reserved 501.");
} finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
