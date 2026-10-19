import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Pool } from "pg";
import { createApp } from "../src/app.js";
import { createDependencies } from "../src/bootstrap/container.js";
import { loadConfig } from "../src/config/env.js";
import { workflowTemplate } from "../src/modules/workflows/templates.js";
import { graphIssues, graphStructureIssues, connectionIssue, observeNode, observeIterations, createNode, type TraceEvent } from "../src/modules/workflows/definition.js";
import { WorkflowStore } from "../src/modules/workflows/workflow.store.js";
import { RunTraceStore } from "../src/modules/observability/run-trace.js";
import { TestAuthStore } from "./auth-fixtures.js";
import { AgentHarness } from "../src/modules/harness/agent-harness.js";
import { AskAgent } from "../src/modules/agent/ask-agent.js";
import { defineReadOnlyTool } from "../src/modules/harness/define-tool.js";
import { withAnswerReview, mathReviewEvidence } from "../src/bootstrap/answer-review.js";
import { SingleTurnAgent } from "../src/modules/agent/single-turn-agent.js";

const logger = { info() {}, error() {} };
test("real harness trace records tool feedback before the bounded final turn without granting delegation", async () => {
    const events: TraceEvent[] = [], seenTools: number[] = [];
    const config = loadConfig({ NODE_ENV: "test", AGENT_MAX_TOOL_STEPS: "1", AGENT_MODEL_RETRIES: "0" });
    const model = { async turn(_messages: unknown, tools: any[]) {
        seenTools.push(tools.length);
        return seenTools.length === 1 ? { content: "calculate", toolCalls: [{ id: "c1", name: "lookup", arguments: {} }] } : { content: "done", toolCalls: [] };
    } };
    const harness = new AgentHarness(model, new AskAgent(), { system: "solve", final: "finish" }, config.context, logger);
    const result = await harness.run({ question: "q", history: [], tools: [defineReadOnlyTool({ name: "lookup", description: "read evidence", parameters: {}, execute: async () => "evidence" })], metadata: {},
        onEvent: (name, fields = {}) => events.push({ sequence: events.length + 1, name, fields, timestamp: new Date().toISOString(), elapsedMs: events.length * 10 }) });
    assert.equal(result.content,"done"); assert.deepEqual(seenTools,[1,0]);
    assert.deepEqual(events.filter(e => e.name === "agent.solve.decision").map(e => e.fields.action),["tools","answer"]);
    assert.ok(events.findIndex(e => e.name === "agent.tool") < events.findIndex(e => e.name === "agent.solve.feedback"));
    const iterations = observeIterations(workflowTemplate("math").graph.nodes.find(n => n.id === "solve-loop")!,{ status:"success",events });
    assert.equal(iterations.length,2); assert.ok(iterations[0]!.events.some(e => e.name === "agent.tool"));
    assert.ok(iterations[1]!.events.some(e => e.name === "agent.solve.limit"));
    const graph = workflowTemplate("math").graph;
    assert.equal(observeNode(graph.nodes.find(n=>n.id==="agent")!,{status:"success",events}).count,1);
    assert.equal(observeNode(graph.nodes.find(n=>n.id==="final")!,{status:"success",events}).count,1,"forced final calls must not also count as research calls");
    assert.equal(events.some(e => e.name === "agent.subagent.started"),false);
});
test("real review trace separates failed review, candidate revision and re-review windows", async () => {
    const config = loadConfig({ NODE_ENV:"test", LLM_BASE_URL:"https://open.bigmodel.cn/api/paas/v4", ANSWER_REVIEW_ENABLED:"true", ANSWER_REVIEW_MAX_REVISIONS:"1", AGENT_MODEL_RETRIES:"0" });
    let reviews = 0, solves = 0; const events: TraceEvent[] = [];
    const solver = { async turn() { return { content: ++solves === 1 ? "wrong" : "fixed", toolCalls:[] }; } };
    const reviewer = { async turn() { return { content: JSON.stringify({ verdict: ++reviews === 1 ? "fail" : "pass", reason:"checked", issues: reviews === 1 ? ["fix arithmetic"] : [] }), toolCalls:[] }; } };
    const harness = new AgentHarness(solver,new SingleTurnAgent(),{system:"solve",final:"answer"},config.context,logger,withAnswerReview({},solver,reviewer,config,"math",mathReviewEvidence));
    const result = await harness.run({ question:"q", history:[], tools:[], metadata:{}, onEvent:(name,fields={}) => events.push({ sequence:events.length+1,name,fields,timestamp:new Date().toISOString(),elapsedMs:events.length*10 }) });
    assert.equal(result.content,"fixed"); assert.equal(result.review?.status,"passed");
    assert.deepEqual(events.filter(e => e.name === "agent.review.decision").map(e => e.fields.canRevise),[true,false]);
    const rounds = observeIterations(workflowTemplate("math").graph.nodes.find(n => n.id === "review-loop")!,{status:"success",events});
    assert.equal(rounds.length,2); assert.ok(rounds[0]!.events.some(e => e.name === "agent.review.revision.completed"));
    assert.equal(rounds[1]!.events.some(e => e.name === "agent.review.revision.started"),false);
});
test("explicit loop returns are bounded, belong to their body and cannot admit external jumps", () => {
    const graph = workflowTemplate("math").graph;
    assert.deepEqual(graphIssues(graph), []);
    assert.equal(connectionIssue(graph, { source: "tool", target: "solve-loop", sourceHandle: "out", targetHandle: "continue" }), undefined);
    const injected = structuredClone(graph);
    injected.edges.push({ id: "injected", source: "prepare", target: "solve-loop", sourceHandle: "out", targetHandle: "continue", label: "" });
    assert.ok(graphIssues(injected).some(i => /外部跳入/.test(i.message)));
    const bypass = structuredClone(graph);
    bypass.edges.push({ id: "bypass", source: "prepare", target: "agent", sourceHandle: "out", targetHandle: "in", label: "" });
    assert.ok(graphIssues(bypass).some(i => /循环体不能由外部/.test(i.message)));
    for (const limit of ["Infinity", "-1", "10001", "runtime.unknown", "process.env.SECRET", "while(true)"]) {
        const invalid = structuredClone(graph); invalid.nodes.find(n => n.id === "solve-loop")!.data.config.maxIterations = limit;
        assert.ok(graphIssues(invalid).some(i => /有限次数/.test(i.message)), limit);
    }
    const noExit = structuredClone(graph); noExit.edges = noExit.edges.filter(e => e.source !== "solve-loop" || e.sourceHandle !== "limit");
    assert.ok(graphIssues(noExit).some(i => /缺少 limit/.test(i.message)));
    const reordered = structuredClone(graph); reordered.edges.reverse();
    assert.deepEqual(graphIssues(reordered), [], "import order must not change loop validity");
});
test("loop logs retain real iteration windows and child model filters exclude sibling tasks", () => {
    const graph = workflowTemplate("math").graph, loop = graph.nodes.find(n => n.id === "solve-loop")!;
    const e = (sequence: number, name: string, fields = {}): TraceEvent => ({ sequence, name, fields, elapsedMs: sequence * 10, timestamp: new Date().toISOString() });
    const events = [e(1,"agent.solve.started"), e(2,"agent.solve.iteration",{step:0}), e(3,"agent.tool.started"), e(4,"agent.solve.feedback"), e(5,"agent.solve.iteration",{step:1,final:true}), e(6,"agent.solve.limit"), e(7,"agent.solve.completed"), e(8,"agent.review.started")];
    const iterations = observeIterations(loop, { status: "success", events });
    assert.deepEqual(iterations.map(i => i.events.map(e => e.sequence)), [[2,3,4],[5,6,7]]);
    assert.match(iterations[1]!.label, /禁用工具收尾/);
    assert.equal(observeIterations(loop, { status: "success", events: [e(1,"agent.model.started")] }).length, 0);
    const reviewer = graph.nodes.find(n => n.id === "review")!;
    const projected = observeNode(reviewer, { status: "success", events: [e(1,"agent.subagent.event",{agent:"math_reviewer",event:"agent.model.started"}),e(2,"agent.subagent.event",{agent:"math_reviser",event:"agent.model.started"}),e(3,"agent.subagent.event",{agent:"math_reviewer",event:"agent.context"})] });
    assert.deepEqual(projected.events.map(e => e.sequence), [1]);
    const solver = graph.nodes.find(n => n.id === "agent")!;
    assert.equal(observeNode(solver,{status:"success",events:[e(1,"agent.model.started",{workflowMode:"direct"})]}).state,"unobserved");
    const english = workflowTemplate("english").graph;
    const calls = [e(1,"agent.subagent.started",{agent:"english_question_solver",purpose:"focused-question",taskId:"a"}),e(2,"agent.subagent.started",{agent:"english_question_solver",purpose:"consensus-recheck",taskId:"b"})];
    assert.deepEqual(observeNode(english.nodes.find(n=>n.id==="focused")!,{status:"pending",events:calls}).events.map(e=>e.sequence),[1]);
    assert.deepEqual(observeNode(english.nodes.find(n=>n.id==="recompare")!,{status:"pending",events:calls}).events.map(e=>e.sequence),[2]);
});
test("all subject templates share one valid generic contract and reject malformed graph semantics", () => {
    for (const subject of ["math", "chinese", "english", "general"] as const) assert.deepEqual(graphIssues(workflowTemplate(subject).graph), []);
    const graph = workflowTemplate("math").graph;
    assert.match(connectionIssue(graph, { source: "end", target: "start", sourceHandle: "out", targetHandle: "in" })!, /端口/);
    assert.match(connectionIssue(graph, { source: "agent", target: "agent", sourceHandle: "out", targetHandle: "in" })!, /自身/);
    assert.match(connectionIssue(graph, graph.edges[0]!)!, /已存在/);
    assert.match(connectionIssue(graph, { source: "protocol", target: "agent", sourceHandle: "out", targetHandle: "in" })!, /回环/);
    assert.ok(graphStructureIssues({ ...graph, nodes: [...graph.nodes, graph.nodes[0]] }).length);
    const unsupported = structuredClone(graph); (unsupported.nodes[0]!.data.config as any).apiKey = "private";
    assert.ok(graphStructureIssues(unsupported).length);
    const branch = structuredClone(graph); branch.edges = branch.edges.filter(e => e.sourceHandle !== "no");
    assert.equal(graphStructureIssues(branch).length, 0, "incomplete topology can be saved as a draft");
    assert.ok(graphIssues(branch).some(issue => issue.message.includes("no 分支")));
    const orphan = createNode("agent", randomUUID(), { x: 0, y: 0 });
    assert.ok(graphIssues({ ...graph, nodes: [...graph.nodes, orphan] }).some(issue => issue.nodeId === orphan.id));
    assert.ok(graphStructureIssues({ ...graph, nodes: [{ ...graph.nodes[0], position: { x: Infinity, y: 0 } }] }).length);
    assert.ok(graphStructureIssues({ ...graph, edges: [{ ...graph.edges[0], target: "absent" }] }).length);
});
test("node observation preserves repeated calls, actual status, filtering and missing evidence", () => {
    const tool = workflowTemplate("math").graph.nodes.find(n => n.id === "tool")!;
    const event = (sequence: number, name: string, fields: Record<string, unknown> = {}): TraceEvent => ({ sequence, name, fields: { workflowMode: "iterative", ...fields }, elapsedMs: sequence * 10, timestamp: new Date().toISOString() });
    const events = [event(1, "agent.tool.started", { callId: "a" }), event(2, "agent.tool.started", { callId: "b" }), event(3, "agent.tool", { callId: "a", durationMs: 20, status: "success" }), event(4, "agent.tool", { callId: "b", durationMs: 30, status: "success" })];
    assert.deepEqual(observeNode(tool, { status: "success", events }), { state: "success", count: 2, events, durationMs: 50 });
    assert.equal(observeNode(tool, { status: "pending", events: events.slice(0, 3) }).state, "running", "one finished parallel call cannot finish another active call");
    assert.equal(observeNode(tool, { status: "success", events: [] }).state, "unobserved");
    assert.equal(observeNode(tool, { status: "pending", events: [events[0]!] }).state, "running");
    assert.equal(observeNode(tool, { status: "interrupted", events: [events[0]!] }).state, "interrupted");
    assert.equal(observeNode(tool, { status: "failure", events: [events[0]!] }).state, "failure");
    const filtered = structuredClone(tool); filtered.data.bindings = [{ event: "agent.tool", role: "finish", field: "tool", value: "math_calculate" }];
    assert.equal(observeNode(filtered, { status: "success", events: [event(1, "agent.tool", { tool: "reading_prepare" })] }).state, "unobserved");
    const end = workflowTemplate("math").graph.nodes.find(n => n.type === "end")!;
    assert.equal(observeNode(end, { status: "cancelled", events: [event(1, "run.cancelled")] }).state, "cancelled");
});
test("historical graph snapshot survives preview bounds, redaction and later graph edits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workflow-trace-")), runs = new RunTraceStore(directory, logger, ["private-secret"]);
    const recorder = (await runs.start({ sessionId: "s", requestId: "r", userMessageId: "m", question: "q" }))!;
    const value = workflowTemplate("math"); value.title += " private-secret";
    value.graph.nodes.find(n => n.id === "agent")!.data.config.system = "private-secret";
    await recorder.workflow({ ...value, runtime: { instructions: "prompt ".repeat(500), solverModel: "glm-4.5-air" } });
    value.graph.nodes[0]!.data.label = "modified";
    await runs.finish(recorder, "success");
    const persisted = await new RunTraceStore(directory, logger).get("s", recorder.id);
    assert.deepEqual(graphIssues(persisted.workflow!.graph), []);
    assert.equal(persisted.workflow!.graph.nodes.length, workflowTemplate("math").graph.nodes.length);
    assert.notEqual(persisted.workflow!.graph.nodes[0]!.data.label, "modified");
    assert.doesNotMatch(JSON.stringify(persisted), /private-secret/);
    assert.ok(!("workflow" in (await runs.list("s")).runs[0]!));
});
test("workflow and trace APIs fail closed without authentication, including forged admin tokens", async () => {
    const config = loadConfig({ NODE_ENV: "test", AUTH_ENABLED: "false", AGENT_TRACE_ENABLED: "false" });
    const deps = createDependencies({ logger, agentHarness: { async run() { return { content: "answer" }; }, async titleFor(s) { return s.title; } } }, config);
    const server = createApp(config, deps).listen(0, "127.0.0.1"); await once(server, "listening");
    try {
        const base = `http://127.0.0.1:${(server.address() as any).port}`;
        for (const path of ["/api/workflows", "/api/workflows/catalog", "/api/workflows/subject-math", "/api/observability/sessions/s/runs"])
            assert.equal((await fetch(base + path, { headers: { Authorization: "Bearer admin-token", "X-Role": "admin" } })).status, 403);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await deps.mcp.close(); }
});
test("real PostgreSQL: workflow versions, revision races, immutable snapshots and admin-only HTTP", { skip: !process.env.AUTH_TEST_DATABASE_URL }, async () => {
    const connectionString = process.env.AUTH_TEST_DATABASE_URL!, pool = new Pool({ connectionString });
    const schema = `workflow_test_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(connectionString); url.searchParams.set("options", `-c search_path=${schema}`);
    const store = new WorkflowStore(url.toString(), [workflowTemplate("math")]);
    let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined, deps: ReturnType<typeof createDependencies> | undefined;
    try {
        await pool.query(`CREATE SCHEMA ${schema}`); await store.initialize();
        const original = await store.get("subject-math"); assert.equal(original.publishedRevision, 1);
        const start = createNode("start","s",{x:0,y:0}), end = createNode("end","e",{x:300,y:0});
        const legacy = { ...workflowTemplate("math"), graph:{schemaVersion:1 as const,nodes:[start,end],edges:[{id:"legacy-edge",source:"s",target:"e",sourceHandle:"out",targetHandle:"in",label:""}]} };
        const legacyStore = new WorkflowStore(url.toString(),[{...legacy,id:"upgrade-system"},{...legacy,id:"preserve-draft"}]);
        try {
            await legacyStore.initialize(); const draft=await legacyStore.get("preserve-draft");
            await legacyStore.save(draft.id,{title:"My draft",description:draft.description,subject:draft.subject,graph:draft.graph},1,"admin@example.com");
        } finally { await legacyStore.close(); }
        const upgradedStore = new WorkflowStore(url.toString(),[{...workflowTemplate("math"),id:"upgrade-system"},{...workflowTemplate("math"),id:"preserve-draft"}]);
        try {
            await upgradedStore.initialize();
            assert.equal((await upgradedStore.get("upgrade-system")).publishedRevision,2);
            assert.equal((await upgradedStore.version("upgrade-system",1)).graph.nodes.length,2);
            assert.ok((await upgradedStore.version("upgrade-system",2)).graph.nodes.some(n=>n.type==="loop"));
            assert.equal((await upgradedStore.get("preserve-draft")).title,"My draft");
            assert.equal((await upgradedStore.get("preserve-draft")).publishedRevision,1);
        } finally { await upgradedStore.close(); }
        const input = { title: "Updated", description: original.description, subject: original.subject, graph: original.graph };
        const results = await Promise.allSettled([store.save(original.id, input, 1, "admin"), store.save(original.id, input, 1, "other")]);
        assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
        assert.equal((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.code, "WORKFLOW_CONFLICT");
        await store.publish(original.id, 2, "admin"); assert.equal((await store.version(original.id)).revision, 2);
        assert.equal((await store.version(original.id, 1)).title, original.title);
        const incomplete = structuredClone(input); incomplete.graph.edges = [];
        await store.save(original.id, incomplete, 2, "admin");
        await assert.rejects(store.publish(original.id, 3, "admin"), { code: "WORKFLOW_INCOMPLETE" });
        assert.equal((await store.version(original.id)).revision, 2);
        const config = loadConfig({ NODE_ENV: "test", AUTH_ENABLED: "true", AGENT_TRACE_ENABLED: "false" });
        deps = createDependencies({ workflows: store, logger, authStore: new TestAuthStore(), agentHarness: { async run() { return { content: "a" }; }, async titleFor(s) { return s.title; } } }, config);
        const admin = await deps.auth!.register({ username: "admin@example.com", password: "test password" });
        const user = await deps.auth!.register({ username: "user@example.com", password: "test password" });
        server = createApp(config, deps).listen(0, "127.0.0.1"); await once(server, "listening");
        const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
        for (const path of ["/workflows", "/workflows/catalog", "/workflows/subject-math", "/workflows/subject-math/versions", "/workflows/subject-math/versions/1", "/observability/sessions/s/runs"]) {
            assert.equal((await fetch(base + path)).status, 401);
            assert.equal((await fetch(base + path, { headers: { Cookie: `songjian_sso=${user.token}`, Authorization: "Bearer admin-token" } })).status, 403);
        }
        const response = await fetch(base + "/workflows/subject-math", { headers: { Cookie: `songjian_sso=${admin.token}` } }); assert.equal(response.status, 200);
        const detail = await response.json() as any;
        assert.ok(detail.data.runtime.instructions); assert.ok(!("apiKey" in detail.data.runtime));
        assert.equal(response.headers.get("cache-control"), "no-store");
        const forbidden = await fetch(base + "/workflows/subject-math/publish", { method: "POST", headers: { Cookie: `songjian_sso=${user.token}`, "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" }, body: JSON.stringify({ expectedRevision: 3 }) }); assert.equal(forbidden.status, 403);
    } finally {
        server?.closeAllConnections(); if (server) await new Promise<void>(r => server!.close(() => r())); await deps?.mcp.close(); await store.close();
        if (!/^workflow_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Invalid schema");
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end();
    }
});
