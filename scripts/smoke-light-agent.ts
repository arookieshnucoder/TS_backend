import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config/env.js";
import { GlmModel } from "../src/infrastructure/llm/glm-model.js";
import { AgentHarness } from "../src/modules/harness/agent-harness.js";
import { AskAgent } from "../src/modules/agent/ask-agent.js";
import { ASK_INSTRUCTIONS, FINAL_INSTRUCTIONS } from "../src/modules/agent/prompt.js";
import { createWorkspaceTools } from "../src/modules/harness/workspace-tools.js";
import { taskPlanTool } from "../src/modules/harness/task-tools.js";
import { defineReadOnlyTool } from "../src/modules/harness/define-tool.js";
import { mathCalculateTool } from "../src/modules/math/task-tools.js";
import { MathRag, corpusDigest } from "../src/modules/math/rag.js";
import type { Embeddings, MathQuestion } from "../src/modules/math/contracts.js";
import { createMathProfile } from "../src/modules/math/profile.js";
import type { HarnessInput, HarnessRunner } from "../src/modules/harness/agent-harness.js";

// 可重复的少量真实模型检查；夹具内容是合成数据，不代表公开基准或真实天气。
const config = loadConfig({ ...process.env, MATH_AGENT_VARIANT: "general",
    LLM_MODEL: process.env.LLM_MODEL ?? "glm-4.5-air", LLM_BASE_URL: process.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
    GLM_THINKING: process.env.GLM_THINKING ?? "enabled", AGENT_MODEL_ATTEMPT_TIMEOUT_MS: "60000",
    AGENT_MAX_TOOL_STEPS: "6", AGENT_MAX_MCP_TOOLS: "8", AGENT_PROTOCOL_REPAIRS: process.env.AGENT_PROTOCOL_REPAIRS ?? "1" });
if (!config.llmApiKey) throw new Error("Set LLM_API_KEY in the launching process");
const directory = join("data", "evaluations", "glm45-air-harness-smoke");
await mkdir(directory, { recursive: true });
const fixture = await mkdtemp(join(directory, "fixture-"));
await mkdir(join(fixture, "src"));
await writeFile(join(fixture, "src", "marker.ts"), '// Synthetic smoke fixture\nexport const marker = "air-harness-verified";\n');
const model = new GlmModel(config, config.math.thinking);
const logger = { info() {}, error() {} };
const createHarness = () => new AgentHarness(model, new AskAgent(), { system: ASK_INSTRUCTIONS, final: FINAL_INSTRUCTIONS }, config.context, logger, config.harness);
const results: Record<string, unknown>[] = [];

async function check(id: string, harness: HarnessRunner, input: HarnessInput, answer: RegExp, requiredTools: string[]) {
    const events: { name: string; fields?: Record<string, unknown> }[] = [];
    const started = Date.now();
    try {
        const result = await harness.run({ ...input, onEvent: (name, fields) => events.push({ name, fields }) }, AbortSignal.timeout(120000));
        const tools = events.filter(event => event.name === "agent.tool" && event.fields?.status === "success").map(event => String(event.fields?.tool));
        assert.match(result.content, answer);
        assert.ok(requiredTools.every(tool => tools.includes(tool)), `Missing evidence tools: ${requiredTools.filter(tool => !tools.includes(tool))}`);
        if (id === "plan-and-tools") {
            const lastPlan = events.filter(event => event.name === "agent.tool" && event.fields?.tool === "manage_todo_list").at(-1);
            const todos = JSON.parse(String(lastPlan?.fields?.result)).todos;
            assert.equal(todos.length, 2);
            assert.ok(todos.every((todo: { status: string }) => todo.status === "completed"));
        }
        results.push({ id, passed: true, durationMs: Date.now() - started, ...result, tools,
            repairs: events.filter(event => event.name === "agent.protocol_repair").length });
        console.log(JSON.stringify({ id, passed: true, tools, modelTurns: result.modelTurns, durationMs: Date.now() - started }));
    } catch (error) {
        // 不输出供应商原始异常；报告只保留固定错误类别和合成任务的验证失败。
        results.push({ id, passed: false, durationMs: Date.now() - started, code: error instanceof Error ? error.name : "Error" });
        console.log(JSON.stringify({ id, passed: false, code: error instanceof Error ? error.name : "Error" }));
    }
    await writeFile(join(directory, "report.json"), JSON.stringify({ model: config.llmModel, thinking: config.math.thinking,
        scope: "Small synthetic end-to-end smoke; not a benchmark or a capability improvement estimate", results }, null, 2));
}

await check("workspace-find-read", createHarness(), { history: [], metadata: {}, tools: createWorkspaceTools(fixture),
    question: "请先用 find_files 找到 marker.ts，再用 read_file 读取实际内容，告诉我 marker 的字符串值并引用行号。" }, /air-harness-verified/, ["find_files", "read_file"]);
await check("numeric-verification", createHarness(), { history: [], metadata: {}, tools: [mathCalculateTool()],
    question: "请调用 math_calculate 核验 sqrt(144)/(7-3)，输出计算结果。" }, /3/, ["math_calculate"]);
await check("bounded-context-text", { async run(input, signal) {
    const turn = await model.turn([{ role: "user", content: input.question }], [], signal, 96);
    return { content: turn.content, modelTurns: 1, toolCalls: turn.toolCalls.length };
} }, { history: [], metadata: {}, tools: [], question: "Summarize this synthetic memory in at most 96 tokens. Preserve its exact marker: AIR_MEM_42. The user prefers concise answers. Output only the summary." }, /AIR_MEM_42/, []);
await check("plan-and-tools", createHarness(), { history: [], metadata: {}, tools: [taskPlanTool(), mathCalculateTool()],
    question: "先用 manage_todo_list 创建两步计划：计算、核验。用 math_calculate 计算 (17+23)*4，再用工具核验 160/4，完成后把计划两个步骤标为 completed 并给出结论。" }, /160/, ["manage_todo_list", "math_calculate"]);
await check("history-correction", createHarness(), { metadata: {}, tools: [], history: [
    { role: "user", content: "第1题：x+3=10，求x。" }, { role: "assistant", content: "x=7" },
    { role: "user", content: "更正第1题，等号右侧改为20，其余不变。" }, { role: "assistant", content: "仍然是7。" },
], question: "前面第1题按我的最新更正，x现在是多少？请依据历史原文核对，不采信助手旧结论。" }, /17/, ["history_lookup"]);

const overview = defineReadOnlyTool({ name: "overview", description: "Inspect workspace catalog overview 概况", parameters: {},
    execute: async () => "This synthetic catalog contains a weather forecast service. Discover by query: weather. Then use its returned schema." });
const weather = defineReadOnlyTool({ name: "weather_forecast", description: "weather forecast 天气预报", parameters: {},
    execute: async () => JSON.stringify({ source: "synthetic-fixture", temperatureC: 23 }) });
const catalog = [overview, weather].map(tool => ({ ...tool, source: { type: "mcp" as const, serverId: "fixture", toolName: tool.definition.name } }));
const discoveryHarness = new AgentHarness(model, new AskAgent(), { system: ASK_INSTRUCTIONS, final: FINAL_INSTRUCTIONS }, config.context, logger,
    { ...config.harness, maxMcpTools: 1 });
await check("discover-and-call", discoveryHarness, { metadata: {}, history: [], tools: catalog,
    question: "先调用 overview 查看这个合成服务目录的概况，根据概况发现推荐的服务，再调用对应工具给出它的数值结果。" }, /23/, ["overview", "tool_search", "weather_forecast"]);

if (process.argv.includes("--math")) {
    // 只使用这里声明的合成例题和本地固定向量；不读取现有语料或索引，不调用 embedding 服务。
    const examples: MathQuestion[] = [{ id: "synthetic-quadratic", question: "解方程 x²-6x+8=0", topic: "quadratic",
        options: ["2和4", "1和8", "-2和-4", "0和6"], answer: "A", solution: "分解(x-2)(x-4)=0，根为2和4，代回原式均为0。",
        source: { url: "https://example.com/synthetic-fixture", row: 1, sha256: "synthetic", dataset: "generated-smoke", kind: "authored" } }];
    const embeddings: Embeddings = { model: "synthetic-local", dimensions: 1,
        async embed(texts, signal) { signal?.throwIfAborted(); return texts.map(() => [1]); } };
    const rag = new MathRag(examples, { version: 1, corpusHash: corpusDigest(examples), model: embeddings.model, dimensions: 1,
        ids: examples.map(question => question.id), vectors: [[1]] }, embeddings);
    const profile = createMathProfile("adaptive", rag, model, config.context, logger, config.harness);
    await check("adaptive-math", profile.harness, { metadata: {}, history: [], tools: [rag.tool(profile.mode)],
        question: "解方程 x²-5x+6=0。\nA. 0和5\nB. -2和-3\nC. 2和3\nD. 1和6\n最后一行给出答案字母，先检验原方程。" }, /答案[：:]\s*\**C/, ["math_search_batch"]);
}
process.exitCode = results.every(result => result.passed) ? 0 : 1;
