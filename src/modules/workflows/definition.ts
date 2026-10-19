/** Browser-safe canonical contract. Both API validation and Vue canvas use this registry. */
export interface FieldDefinition { key: string; label: string; multiline?: boolean; default: string; options?: string[]; help?: string }
export interface NodeDefinition { type: string; label: string; icon: string; color: string; description: string; inputs: string[]; outputs: string[]; fields: FieldDefinition[] }
const field = (key: string, label: string, value = "", multiline = true): FieldDefinition => ({ key, label, default: value, multiline });
export const nodeDefinitions: NodeDefinition[] = [
    { type: "start", label: "开始", icon: "▷", color: "#50866c", description: "接收问题并建立本轮运行", inputs: [], outputs: ["out"], fields: [field("variables", "输入契约", "question: 当前问题\nhistory: 同学科历史")] },
    { type: "prepare", label: "输入准备", icon: "≡", color: "#6587ad", description: "解析题目、材料和最新条件", inputs: ["in"], outputs: ["out"], fields: [field("source", "输入来源", "当前问题与同学科对话"), field("rules", "整理规则")] },
    { type: "context", label: "上下文", icon: "▤", color: "#9482b5", description: "历史、原文证据与上下文预算", inputs: ["in"], outputs: ["out"], fields: [field("strategy", "证据与历史策略"), field("budget", "预算说明", "由现有 harness 控制")] },
    { type: "retrieval", label: "经验检索", icon: "⌕", color: "#a8874e", description: "查找方法并核对适用边界", inputs: ["in"], outputs: ["out"], fields: [field("source", "检索来源", "当前学科的解题经验库"), field("query", "查询与筛选说明"), field("boundary", "适用边界")] },
    { type: "agent", label: "智能体", icon: "✦", color: "#558c87", description: "现有 agent 的决策、求解和委派", inputs: ["in"], outputs: ["out"], fields: [field("role", "职责说明"), field("instructions", "提示词说明"), field("tools", "工具权限说明")] },
    { type: "loop", label: "循环控制", icon: "↻", color: "#ac794d", description: "显式判断继续条件、提前退出与次数上限", inputs: ["in", "continue", "break"], outputs: ["body", "done", "limit"], fields: [field("iterator", "迭代变量", "iteration", false), field("variable", "继续条件 · 变量", "iteration", false), { ...field("operator", "继续条件 · 运算符", "less_than", false), options: ["less_than", "less_or_equal", "equals", "not_equals"] }, field("value", "继续条件 · 比较值", "3", false), { ...field("maxIterations", "有限次数上限", "3", false), help: "填写 0–10000 的整数，或 runtime.maxToolSteps / runtime.maxReviewAttempts / run.questionCount；引用只用于说明，不执行表达式。" }, field("exit", "提前退出条件", "结果就绪时进入 break"), field("onLimit", "达到上限的处理", "经 limit 端口退出"), field("state", "每轮携带与更新的状态")] },
    { type: "model", label: "模型调用", icon: "✧", color: "#558c87", description: "一次模型决策，明确输入、工具权限和返回契约", inputs: ["in"], outputs: ["out"], fields: [field("model", "模型引用", "runtime.solverModel", false), field("system", "System 提示词来源"), field("messages", "输入消息与证据"), field("tools", "本次可用工具"), field("response", "响应契约", "content + toolCalls"), field("recovery", "超时、重试与协议纠错边界")] },
    { type: "delegate", label: "子任务委派", icon: "⇢", color: "#927ba5", description: "宿主按注册权限调用子智能体，返回结果后继续", inputs: ["in"], outputs: ["out", "error"], fields: [field("agent", "注册子智能体名称", "", false), field("trigger", "实际触发者与条件"), field("request", "子任务输入契约"), field("result", "返回契约"), field("permissions", "工具与再次委派权限", "由宿主注册表授权；不继承主智能体全部权限"), field("budget", "次数、深度、并发与超时预算")] },
    { type: "tool", label: "工具", icon: "⚒", color: "#7186a2", description: "受 harness 预算约束的工具调用", inputs: ["in"], outputs: ["out"], fields: [field("name", "工具名称", "", false), field("arguments", "参数契约"), field("result", "结果契约")] },
    { type: "condition", label: "条件分支", icon: "◇", color: "#b68b55", description: "记录阶段的选择条件与分支", inputs: ["in"], outputs: ["yes", "no"], fields: [field("variable", "判断变量", "", false), field("operator", "比较方式", "equals", false), field("value", "比较值", "", false), field("rules", "分支说明")] },
    { type: "review", label: "答案复核", icon: "✓", color: "#7b91b6", description: "独立核验并记录修订与结论", inputs: ["in"], outputs: ["out"], fields: [field("criteria", "复核准则"), field("repair", "修订策略说明", "确定错误时由主模型修订，再独立复核；遵循宿主修订上限")] },
    { type: "output", label: "输出与保存", icon: "↗", color: "#729575", description: "整理最终答案或保存处理结果", inputs: ["in"], outputs: ["out"], fields: [field("format", "输出契约"), field("persistence", "持久化说明")] },
    { type: "end", label: "结束", icon: "■", color: "#69766e", description: "本轮运行到达终态", inputs: ["in"], outputs: [], fields: [field("completion", "完成条件", "以真实运行终态为准")] },
    { type: "note", label: "注释", icon: "✎", color: "#b29b65", description: "画布上的纯文本说明", inputs: [], outputs: [], fields: [field("text", "注释内容")] },
];
export type NodeType = "start" | "prepare" | "context" | "retrieval" | "agent" | "loop" | "model" | "delegate" | "tool" | "condition" | "review" | "output" | "end" | "note";
export interface EventBinding { event: string; role: "start" | "finish" | "activity" | "error" | "iteration"; field?: string; value?: string; nestedEvent?: string }
export interface WorkflowNode { id: string; type: NodeType; position: { x: number; y: number }; data: { label: string; description: string; inputs: string; outputs: string; config: Record<string, string>; bindings: EventBinding[] } }
export interface WorkflowEdge { id: string; source: string; target: string; sourceHandle: string; targetHandle: string; label: string }
export interface WorkflowGraph { schemaVersion: 1; nodes: WorkflowNode[]; edges: WorkflowEdge[] }
export type WorkflowSubject = "math" | "chinese" | "english" | "general";
export type RuntimeSnapshot = { solverModel: string; reviewerModel: string; reviewEnabled: boolean; maxRevisions: number; timeoutMs: number; maxInputTokens: number; maxToolSteps: number; skillsEnabled: boolean; subject: string; variant: string; instructions: string; workflow?: string; maxReviewAttempts: number; maxCallsPerStep: number; maxProtocolRepairs: number; modelRetries: number; toolRetries: number; modelAttemptTimeoutMs: number; toolTimeoutMs: number };
export interface WorkflowSnapshot { id: string; title: string; description: string; subject: WorkflowSubject; revision: number; graph: WorkflowGraph }
export interface WorkflowRecord extends WorkflowSnapshot { publishedRevision: number | null; updatedAt: string; updatedBy: string }
export interface WorkflowVersion extends WorkflowSnapshot { publishedAt: string; publishedBy: string }
export interface GraphIssue { message: string; nodeId?: string; edgeId?: string }
export const definitionFor = (type: string) => nodeDefinitions.find(definition => definition.type === type);
export function createNode(type: NodeType, id: string, position: { x: number; y: number }): WorkflowNode {
    const definition = definitionFor(type);
    if (!definition) throw new TypeError("Unknown workflow node");
    return { id, type, position, data: { label: definition.label, description: "", inputs: "", outputs: "",
        config: Object.fromEntries(definition.fields.map(f => [f.key, f.default])), bindings: [] } };
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 12000): value is string => typeof value === "string" && value.length <= max;
const validId = (value: unknown): value is string => text(value, 100) && /^[a-zA-Z0-9_-]+$/.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

/** Strict decoding: malformed or unsupported definitions never silently become another graph. */
export function graphStructureIssues(value: unknown): GraphIssue[] {
    const invalid = (message: string): GraphIssue[] => [{ message }];
    if (!record(value) || !keys(value, ["schemaVersion", "nodes", "edges"]) || value.schemaVersion !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return invalid("工作流必须使用 schemaVersion=1 的规范图数据。");
    if (value.nodes.length > 150 || value.edges.length > 400 || JSON.stringify(value).length > 600000) return invalid("画布超过节点、连线或内容大小上限。");
    const nodeIds = new Set<string>(), edgeIds = new Set<string>();
    for (const n of value.nodes) {
        if (!record(n) || !keys(n, ["id", "type", "position", "data"]) || !validId(n.id) || nodeIds.has(n.id) || typeof n.type !== "string") return invalid("节点 ID 无效或重复。");
        const definition = definitionFor(n.type);
        if (!definition || !record(n.position) || !keys(n.position, ["x", "y"]) || ![n.position.x, n.position.y].every(v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1000000)) return invalid("节点类型或坐标无效。");
        if (!record(n.data) || !keys(n.data, ["label", "description", "inputs", "outputs", "config", "bindings"]) || !text(n.data.label, 100) || !n.data.label.trim() || !text(n.data.description, 3000) || !text(n.data.inputs) || !text(n.data.outputs) || !record(n.data.config) || !keys(n.data.config, definition.fields.map(f => f.key)) || !Object.values(n.data.config).every(v => text(v))) return invalid("节点属性无效；仅支持该类型定义的说明字段，禁止保存凭据。");
        if (!Array.isArray(n.data.bindings) || n.data.bindings.length > 24 || !n.data.bindings.every(b => record(b) && keys(b, ["event", "role", "field", "value", "nestedEvent"]) && text(b.event, 100) && /^[a-z][a-z0-9_.-]*(?:\.\*)?$/.test(b.event) && ["start", "finish", "activity", "error", "iteration"].includes(String(b.role)) && (b.nestedEvent === undefined || b.event === "agent.subagent.event" && text(b.nestedEvent, 100) && /^[a-z][a-z0-9_.-]*(?:\.\*)?$/.test(b.nestedEvent)) && (b.field === undefined || text(b.field, 100) && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(b.field) && !["constructor", "prototype"].includes(b.field)) && (b.value === undefined || text(b.value, 2000)) && (b.field === undefined) === (b.value === undefined))) return invalid("事件绑定格式无效，筛选字段和比较值必须同时填写；内部事件仅用于子任务事件。");
        if (n.type === "note" && n.data.bindings.length) return invalid("注释节点不能绑定运行事件。");
        nodeIds.add(n.id);
    }
    const graph = value as unknown as WorkflowGraph;
    const accepted: WorkflowEdge[] = [];
    for (const e of value.edges) {
        if (!record(e) || !keys(e, ["id", "source", "target", "sourceHandle", "targetHandle", "label"]) || !validId(e.id) || edgeIds.has(e.id) || !validId(e.source) || !validId(e.target) || !text(e.sourceHandle, 30) || !text(e.targetHandle, 30) || !text(e.label, 200)) return invalid("连线属性或 ID 无效。");
        const issue = connectionIssue({ ...graph, edges: accepted }, e as unknown as WorkflowEdge);
        if (issue) return [{ message: issue, edgeId: e.id }];
        accepted.push(e as unknown as WorkflowEdge); edgeIds.add(e.id);
    }
    return [];
}
export function connectionIssue(graph: WorkflowGraph, edge: Pick<WorkflowEdge, "source" | "target" | "sourceHandle" | "targetHandle">): string | undefined {
    const source = graph.nodes.find(n => n.id === edge.source), target = graph.nodes.find(n => n.id === edge.target);
    if (!source || !target) return "连线两端必须是存在的节点。";
    if (source.id === target.id) return "节点不能连接自身。";
    if (!definitionFor(source.type)?.outputs.includes(edge.sourceHandle) || !definitionFor(target.type)?.inputs.includes(edge.targetHandle)) return "只能从有效输出端口连到输入端口。";
    if (graph.edges.some(e => e.source === edge.source && e.target === edge.target && e.sourceHandle === edge.sourceHandle && e.targetHandle === edge.targetHandle)) return "这条连线已存在。";
    if (isLoopReturn(graph, edge)) return undefined;
    const visited = new Set<string>(), queue = [target.id];
    while (queue.length) {
        const id = queue.pop()!;
        if (id === source.id) return "普通连线不能形成回环；请连接循环节点的 continue / break 入口。";
        if (visited.has(id)) continue;
        visited.add(id); queue.push(...graph.edges.filter(e => e.source === id && !isLoopReturn(graph, e)).map(e => e.target));
    }
    return undefined;
}
export function isLoopReturn(graph: WorkflowGraph, edge: Pick<WorkflowEdge, "target" | "targetHandle">): boolean {
    return graph.nodes.some(n => n.id === edge.target && n.type === "loop") && ["continue", "break"].includes(edge.targetHandle);
}
export const loopLimitReferences = ["runtime.maxToolSteps", "runtime.maxReviewAttempts", "run.questionCount"];
export const portLabel = (type: string, port: string) => type === "loop" ? ({ in: "进入", continue: "下一轮", break: "提前退出", body: "继续循环", done: "完成", limit: "达到上限" } as Record<string, string>)[port] ?? port : ({ yes: "是", no: "否", in: "输入", out: "输出", error: "异常" } as Record<string, string>)[port] ?? port;
export function loopBodyIds(graph: WorkflowGraph, loopId: string): Set<string> {
    const body = new Set<string>(), queue = graph.edges.filter(e => e.source === loopId && ["body", "limit"].includes(e.sourceHandle)).map(e => e.target);
    while (queue.length) { const id = queue.pop()!; if (body.has(id)) continue; body.add(id); queue.push(...graph.edges.filter(e => e.source === id && !isLoopReturn(graph, e)).map(e => e.target)); }
    return body;
}
export function graphIssues(graph: WorkflowGraph, complete = true): GraphIssue[] {
    const structural = graphStructureIssues(graph);
    if (structural.length || !complete) return structural;
    const issues: GraphIssue[] = [], nodes = graph.nodes.filter(n => n.type !== "note");
    const starts = nodes.filter(n => n.type === "start"), ends = nodes.filter(n => n.type === "end");
    if (starts.length !== 1) issues.push({ message: "发布需要且只能有一个开始节点。" });
    if (!ends.length) issues.push({ message: "发布至少需要一个结束节点。" });
    const reachable = (ids: string[], reverse: boolean) => {
        const seen = new Set<string>(), queue = [...ids];
        while (queue.length) { const id = queue.pop()!; if (seen.has(id)) continue; seen.add(id); queue.push(...graph.edges.filter(e => (reverse ? e.target : e.source) === id).map(e => reverse ? e.source : e.target)); }
        return seen;
    };
    const fromStart = reachable(starts.map(n => n.id), false), toEnd = reachable(ends.map(n => n.id), true);
    for (const node of nodes) {
        if (!fromStart.has(node.id)) issues.push({ message: `${node.data.label} 无法从开始节点到达。`, nodeId: node.id });
        if (!toEnd.has(node.id)) issues.push({ message: `${node.data.label} 没有通向结束节点的路径。`, nodeId: node.id });
        if (node.type === "condition") for (const handle of ["yes", "no"]) if (!graph.edges.some(e => e.source === node.id && e.sourceHandle === handle)) issues.push({ message: `${node.data.label} 缺少 ${handle} 分支。`, nodeId: node.id });
        if (node.type === "loop") {
            const c = node.data.config;
            if (!c.variable?.trim() || !c.value?.trim() || !["less_than", "less_or_equal", "equals", "not_equals"].includes(c.operator ?? "") || !(/^(0|[1-9]\d{0,4})$/.test(c.maxIterations ?? "") && Number(c.maxIterations) <= 10000 || loopLimitReferences.includes(c.maxIterations ?? ""))) issues.push({ message: `${node.data.label} 需要继续条件和有限次数上限，不能执行任意表达式。`, nodeId: node.id });
            for (const handle of ["body", "done", "limit"]) if (!graph.edges.some(e => e.source === node.id && e.sourceHandle === handle)) issues.push({ message: `${node.data.label} 缺少 ${handle} 路径。`, nodeId: node.id });
            if (!graph.edges.some(e => e.target === node.id && e.targetHandle === "in")) issues.push({ message: `${node.data.label} 缺少正常进入路径。`, nodeId: node.id });
            const body = loopBodyIds(graph, node.id);
            const returns = graph.edges.filter(e => e.target === node.id && isLoopReturn(graph, e));
            if (!returns.length) issues.push({ message: `${node.data.label} 缺少 continue 或 break 返回路径。`, nodeId: node.id });
            for (const edge of returns) if (!body.has(edge.source)) issues.push({ message: "循环控制入口只能接收本循环体的返回，不能由外部跳入。", edgeId: edge.id, nodeId: node.id });
            if (nodes.some(n => n.type === "end" && body.has(n.id))) issues.push({ message: `${node.data.label} 的循环体必须经过 continue / break 返回控制节点。`, nodeId: node.id });
            for (const edge of graph.edges) if (body.has(edge.target) && !body.has(edge.source) && !(edge.source === node.id && ["body", "limit"].includes(edge.sourceHandle))) issues.push({ message: "循环体不能由外部直接进入，请先连接循环的 in 入口。", edgeId: edge.id });
        }
    }
    return issues;
}
export interface TraceEvent { sequence: number; name: string; timestamp: string; elapsedMs: number; fields: Record<string, unknown> }
export interface TraceInput { status: string; events: TraceEvent[] }
export function matchesBinding(binding: EventBinding, event: TraceEvent): boolean {
    return (binding.event.endsWith(".*") ? event.name.startsWith(binding.event.slice(0, -1)) : event.name === binding.event) &&
        (binding.nestedEvent === undefined || (binding.nestedEvent.endsWith(".*") ? String(event.fields.event).startsWith(binding.nestedEvent.slice(0, -1)) : event.fields.event === binding.nestedEvent)) &&
        (binding.field === undefined || Object.hasOwn(event.fields, binding.field) && String(event.fields[binding.field]) === binding.value);
}
export type NodeState = "unobserved" | "observed" | "running" | "success" | "skipped" | "warning" | "failure" | "cancelled" | "interrupted";
export interface NodeObservation { state: NodeState; events: TraceEvent[]; count: number; durationMs?: number }
/** Never infer execution from topology; preserve all repeated/parallel events and terminal failures. */
export function observeNode(node: WorkflowNode, trace: TraceInput): NodeObservation {
    const matched = trace.events.flatMap(event => {
        const bindings = node.data.bindings.filter(binding => matchesBinding(binding, event));
        return bindings.length ? [{ event, bindings }] : [];
    });
    let state: NodeState = "unobserved", count = 0, duration = 0, hasDuration = false, hadError = false;
    const pending = new Map<string, number>();
    for (const { event, bindings } of matched) {
        const key = String(event.fields.callId ?? event.fields.modelCallId ?? event.fields.taskId ?? "phase");
        if (bindings.some(b => b.role === "start")) { state = "running"; pending.set(key, pending.get(key) ?? event.elapsedMs); count++; }
        if (bindings.some(b => b.role === "activity") && state === "unobserved") state = "observed";
        if (bindings.some(b => b.role === "finish")) {
            const started = key === "phase" && pending.size ? Math.min(...pending.values()) : pending.get(key);
            const elapsed = typeof event.fields.durationMs === "number" ? event.fields.durationMs : started === undefined ? undefined : Math.max(0, event.elapsedMs - started);
            if (elapsed !== undefined) { duration += elapsed; hasDuration = true; }
            if (key === "phase") pending.clear(); else pending.delete(key);
            state = pending.size ? "running" : event.name.endsWith(".skipped") ? "skipped" : "success";
        }
        if (bindings.some(b => b.role === "error") || ["failure", "failed", "error", "timed_out"].includes(String(event.fields.status))) {
            state = "failure"; hadError = true; pending.delete(key);
            if (!bindings.some(b => b.role === "finish") && typeof event.fields.durationMs === "number") { duration += event.fields.durationMs; hasDuration = true; }
        }
        if (event.fields.status === "cancelled") state = "cancelled";
        if (["uncertain", "unavailable"].includes(String(event.fields.status))) state = "warning";
        if (event.name === "run.cancelled") state = "cancelled";
        if (event.name === "run.interrupted") state = "interrupted";
    }
    if (hadError && (state === "success" || state === "skipped")) state = "warning";
    if (state === "running" && trace.status !== "pending") state = ["cancelled", "interrupted"].includes(trace.status) ? trace.status as NodeState : "failure";
    return { state, events: matched.map(m => m.event), count: count || matched.length, ...(hasDuration ? { durationMs: duration } : {}) };
}
export const nodeStateLabels: Record<NodeState, string> = { unobserved: "未观测", observed: "已观测", running: "进行中", success: "已完成", skipped: "已跳过", warning: "需关注", failure: "失败", cancelled: "已取消", interrupted: "已中断" };

export interface LoopIteration { index: number; label: string; events: TraceEvent[]; durationMs: number; completed: boolean }
/** Slice only observed iteration windows, bounded by the actual loop completion. */
export function observeIterations(node: WorkflowNode, trace: TraceInput): LoopIteration[] {
    if (node.type !== "loop") return [];
    const markers = trace.events.filter(e => node.data.bindings.some(b => b.role === "iteration" && matchesBinding(b, e)));
    return markers.map((marker, index) => {
        const finish = trace.events.find(e => e.sequence > marker.sequence && node.data.bindings.some(b => b.role === "finish" && matchesBinding(b, e)));
        const next = markers[index + 1];
        const boundary = next && (!finish || next.sequence < finish.sequence) ? next : finish;
        const events = trace.events.filter(e => e.sequence >= marker.sequence && (!boundary || e.sequence < boundary.sequence || boundary === finish && e.sequence === boundary.sequence));
        return { index: index + 1, label: String(marker.fields.label ?? `第 ${index + 1} 轮${marker.fields.final === true ? " · 禁用工具收尾" : ""}`), events,
            durationMs: Math.max(0, (boundary?.elapsedMs ?? trace.events.at(-1)?.elapsedMs ?? marker.elapsedMs) - marker.elapsedMs), completed: !!boundary || trace.status !== "pending" };
    });
}
