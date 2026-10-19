import type { AppConfig } from "../../config/env.js";
import { MATH_INSTRUCTIONS } from "../math/agent.js";
import { READING_INSTRUCTIONS } from "../reading/agent.js";
import { ENGLISH_INSTRUCTIONS } from "../english/agent.js";
import { createNode, type EventBinding, type NodeType, type WorkflowEdge, type WorkflowSnapshot, type WorkflowSubject, type RuntimeSnapshot } from "./definition.js";

const bind = (event: string, role: EventBinding["role"], field?: string, value?: string): EventBinding => ({ event, role, ...(field ? { field, value } : {}) });
const child = (agent: string, purpose?: string): EventBinding[] => {
    const field = purpose ? "purpose" : "agent", value = purpose ?? agent;
    return [bind("agent.subagent.started", "start", field, value), { ...bind("agent.subagent.event", "activity", field, value), nestedEvent: "agent.model.*" },
        bind("agent.subagent.completed", "finish", field, value), bind("agent.subagent.failed", "error", field, value)];
};

/** Only template data varies by subject; ports, forms, loop validation and logs are generic. */
export function workflowTemplate(subject: WorkflowSubject): WorkflowSnapshot {
    const names = { math: "数学", chinese: "语文", english: "英语", general: "通用" };
    const prefix = subject === "chinese" ? "reading" : subject;
    const nodes: ReturnType<typeof createNode>[] = [], edges: WorkflowEdge[] = [];
    const add = (id: string, type: NodeType, label: string, x: number, y: number, description: string, config: Record<string, string> = {}, bindings: EventBinding[] = []) => {
        const node = createNode(type, id, { x, y });
        node.data = { ...node.data, label, description, config: { ...node.data.config, ...config }, bindings };
        nodes.push(node); return node;
    };
    const link = (source: string, target: string, sourceHandle = "out", label = "", targetHandle = "in") =>
        edges.push({ id: `${source}-${sourceHandle}-${target}-${targetHandle}`, source, target, sourceHandle, targetHandle, label });
    const delegate = (id: string, label: string, agent: string, x: number, y: number, trigger: string, request: string, result: string, purpose?: string) =>
        add(id, "delegate", label, x, y, trigger, { agent, trigger, request, result, permissions: "仅允许宿主注册的工具和后续委派；复核/修订/经验子任务默认无工具、无再次委派。", budget: "共享本轮 SubAgentSession 的调用、深度、并发、超时及输出长度上限；当前值见实际配置。" }, child(agent, purpose));
    const model = (id: string, label: string, x: number, y: number, mode: string, tools: string) =>
        add(id, "model", label, x, y, "模型只返回内容或工具请求；工具执行与子任务委派由宿主提供的实际能力决定。", {
            model: "runtime.solverModel", system: "当前学科 instructions + 已启用的经验工具规则；最终轮附加 final 指令。",
            messages: "system + 证据/历史 + 已有 tool rounds + 当前问题；ContextBuilder 在调用前重新计算预算。", tools,
            response: "content: 可见答案；toolCalls: [{id,name,arguments}]。无工具请求即准备结束。",
            recovery: "RecoveringModel 仅对可重试网络/限流错误有限重试；HarnessRuntime 仅对未执行的非法工具批次进行有限协议纠错，不重放工具。具体次数和实际错误见运行配置/事件。",
        }, [bind("agent.model.started", "start", "workflowMode", mode), bind("agent.model.completed", "finish", "workflowMode", mode), bind("agent.model.failed", "error", "workflowMode", mode), bind("agent.protocol_repair", "activity", "workflowMode", mode)]);

    add("start", "start", "接收本轮问题", 40, 80, "运行记录的起点；失败、取消、超时均保留真实终态。", {}, [bind("run.started", "finish")]);
    add("prepare", "prepare", "题目、材料与历史", 340, 80, "学科入口解析输入，宿主注册工具并建立本轮共享预算。", { rules: "只保留当前学科历史与最新用户更正；原文和工具返回作为不可信数据。" }, [bind("agent.started", "finish")]);
    add("retrieval", "retrieval", "检索经验候选", 640, 80, "宿主预取阶段的经验检索；不是主模型自主决定的委派。", {}, [bind("agent.skills.search", "finish"), bind("agent.skills.loaded", "activity"), bind("agent.skills.unavailable", "error")]);
    delegate("matcher", "核对经验适用边界", "solution_skill_matcher", 940, 80, "经验库启用且有候选、注册了 matcher 时，由宿主显式委派；未调用时显示未观测。", "当前题目 + 候选方法及适用边界", "允许加载的经验 ID；不提供参考答案");
    add("prefetch", "tool", "预取题目与原文证据", 1240, 80, "进入实际作答前，宿主按策略预取历史、经验、检索或材料工具。", { name: "initialCalls / history_lookup / solution_skills", arguments: "由宿主构造，不是主模型的 toolCalls", result: "initialRounds；之后交给 ContextBuilder" }, [bind("agent.tool.started", "start", "workflowMode", "prefetch"), bind("agent.tool", "finish", "workflowMode", "prefetch"), bind("math.retrieval", "activity"), bind("reading.context", "activity"), bind("english.context", "activity")]);
    const iterativeOnly = subject === "math" || subject === "general";
    if (iterativeOnly) add("route", "prepare", "启动已注册的 AskAgent", 1540, 80, "线上数学和通用聊天使用 AskAgent。一次决策无工具请求即可退出，不要求一定调用工具。", { source: "bootstrap/math-chat-agent.ts / bootstrap/chat-agent.ts", rules: "线上数学仅注册 math_analyze、math_calculate 及宿主经验工具；离线 corpus/profile 的程序求解不属于该链路。" }, [bind("agent.solve.started", "finish")]);
    else add("route", "condition", "实际策略需要补读循环？", 1540, 80, "阅读仅在原文不完整且允许补读时进入 AskAgent；完整原文走当前学科直接/逐题策略。", { variable: "workflowMode", operator: "equals", value: "iterative", rules: "yes：AskAgent 补读；no：完整证据直接作答或英语逐题策略。以 solve.route / solve.started 事件为准。" }, [bind("agent.solve.route", "finish"), bind("agent.solve.started", "activity")]);
    add("solve-loop", "loop", "主智能体 · 工具决策循环", 1840, 80, "每轮基于真实工具结果重新决策；答案就绪提前退出，研究预算耗尽禁用工具收尾。", {
        iterator: "step（从 0 开始）", variable: "step", operator: "less_than", value: "runtime.maxToolSteps", maxIterations: "runtime.maxToolSteps",
        exit: "turn.toolCalls.length === 0 → break；返回当前 content。", onLimit: "step 达到 maxToolSteps 后只允许一次无工具最终作答；错误/取消/超时由真实运行终态结束。", state: "rounds: ToolRound[]；每轮追加工具请求与按原顺序返回的结果，step + 1。",
    }, [bind("agent.solve.started", "start"), bind("agent.solve.iteration", "iteration"), bind("agent.solve.limit", "activity"), bind("agent.solve.completed", "finish")]);
    add("context", "context", "每轮重建上下文", 2140, -150, "读取 initialRounds + rounds，按预算压缩与保留题目证据。", { strategy: "ContextBuilder.build：保留最新题目条件、证据和工具结果；final 时工具目录为空。", budget: "runtime.maxInputTokens；压缩事件和实际 token 使用可在日志查看。" }, [bind("agent.context", "activity", "workflowMode", "iterative"), bind("context.compressed", "activity"), bind("context.evidence_selected", "activity")]);
    model("agent", "主模型 · 当前轮决策", 2440, -150, "iterative", "研究轮使用已注册且经过上下文预算筛选的工具；不会自动获得 delegate 能力。");
    add("protocol", "prepare", "校验工具协议与权限", 2740, -150, "校验调用 ID、工具名、JSON 参数、批次与总预算；协议纠错额度耗尽直接失败。", { source: "HarnessRuntime.complete / validateCalls", rules: "未执行的非法请求可在 AGENT_PROTOCOL_REPAIRS 次数内重新请求模型；不重放已经执行的工具；网络重试另计。" }, [bind("agent.protocol.validated", "finish", "workflowMode", "iterative"), bind("agent.protocol_repair", "activity")]);
    add("condition", "condition", "模型请求了工具？", 3040, -150, "这是主模型的实际决策出口，不由图上的连线推测。", { variable: "turn.toolCalls.length", operator: "greater_than", value: "0", rules: "yes：宿主执行工具；no：携带 content 从循环 break 退出。" }, [bind("agent.solve.decision", "finish", "workflowMode", "iterative")]);
    add("tool", "tool", "执行本轮工具批次", 3340, -150, "只读幂等工具可并行；有状态工具构成顺序屏障。模型请求与结果保留 callId。", { name: "turn.toolCalls[*].name", arguments: "已校验的 {id,name,arguments}；最多 runtime.maxCallsPerStep 个/批次。", result: "结果仍与请求顺序一致；超时、有限工具重试、输出截断由 ToolRegistry 控制。" }, [bind("agent.tool.started", "start", "workflowMode", "iterative"), bind("agent.tool", "finish", "workflowMode", "iterative")]);
    add("feedback", "context", "回填结果，进入下一轮", 3340, 180, "把真实工具响应追加到 rounds，随后回到循环继续条件。", { strategy: "rounds.push(toolRound(turn, results))；不把模型请求当作工具已执行。", budget: "工具及模型预算沿用本轮共享计数，不因循环返回而清零。" }, [bind("agent.solve.feedback", "finish")]);
    // The final call uses the same runtime, but a dedicated event marks this path.
    add("final", "model", "预算耗尽 · 无工具收尾", 2140, 400, "达到工具研究轮数后，仅依据现有证据作答；模型继续索要工具会被拒绝。", { model: "runtime.solverModel", system: "学科 final 指令", messages: "initialRounds + 全部已完成 rounds", tools: "[]（强制禁用）", response: "非空 content，toolCalls 必须为空", recovery: "沿用同一 RecoveringModel 与运行总超时；不增加工具研究额度。" }, [bind("agent.solve.limit", "activity"), bind("agent.model.started", "start", "workflowMode", "iterative_final"), bind("agent.model.completed", "finish", "workflowMode", "iterative_final"), bind("agent.model.failed", "error", "workflowMode", "iterative_final")]);
    if (!iterativeOnly) model("direct", "直接求解 · 禁用额外工具", 1840, 750, "direct", "[]；原文完整或补读未启用时由当前学科直接作答。");
    add("candidate", "output", "收集本次候选答案", 3640, 650, "接收当前策略实际产出的答案；此时尚不能宣称独立复核通过。", { format: "完整学科解答和全部子问", persistence: "先交给结果处理器，不提前向学习者宣称审核通过。" }, [bind("agent.workflow.completed", "finish")]);

    link("start", "prepare"); link("prepare", "retrieval"); link("retrieval", "matcher"); link("matcher", "prefetch"); link("prefetch", "route");
    link("route", "solve-loop", iterativeOnly ? "out" : "yes", "允许工具决策"); link("solve-loop", "context", "body", "step < maxToolSteps"); link("context", "agent"); link("agent", "protocol"); link("protocol", "condition");
    link("condition", "tool", "yes", "toolCalls > 0"); link("tool", "feedback"); link("feedback", "solve-loop", "out", "结果回填 · 下一轮", "continue");
    link("condition", "solve-loop", "no", "答案就绪 · 提前退出", "break"); link("solve-loop", "final", "limit", "达到预算 · 工具置空"); link("final", "solve-loop", "out", "完成收尾", "break"); link("solve-loop", "candidate", "done", "离开求解循环");
    if (!iterativeOnly) link("direct", "candidate");
    if (subject === "english") {
        add("focus-route", "condition", "完整阅读且 grounded？", 1540, 470, "只在实际条件满足时逐题隔离求解；其他题型走直接或补读路径。", { variable: "workflowMode", operator: "equals", value: "focused", rules: "完整原文 + grounded + 全部为 reading；由 EnglishAgent 判断。" }, [bind("agent.solve.route", "finish")]);
        model("batch", "整体作答供一致性比较", 1840, 1080, "focused", "[]；整体候选不传入其他题目的子任务。");
        add("focus-loop", "loop", "遍历阅读子题", 2140, 1080, "按 questions 顺序逐题委派。子任务失败时宿主对剩余题做有限收尾，不伪造逐题成功。", { iterator: "questionIndex", variable: "questionIndex", operator: "less_than", value: "run.questionCount", maxIterations: "run.questionCount", state: "answers[] 逐题追加；子任务只收到本题、全文和可复用方法。", exit: "子任务失败由主模型收尾剩余题后 break。", onLimit: "全部题目完成后汇总答案并 break。" }, [bind("english.focus.started", "start"), bind("english.focus.iteration", "iteration"), bind("english.focus.completed", "finish"), bind("english.focus.failed", "activity")]);
        delegate("focused", "隔离求解当前题", "english_question_solver", 2440, 900, "EnglishAgent 遍历当前阅读题时显式委派；不是主模型自主调用。", "当前题目 + 完整原文 + 适用方法；不带兄弟题答案", "当前题唯一结论与原文依据", "focused-question");
        add("consensus", "condition", "整体与本题结论有分歧？", 2740, 900, "两个候选均可解析且字母不同才重新比较；不把候选当作参考答案。", { variable: "consensus.disagreement", operator: "equals", value: "true", rules: "yes：同一注册子任务重新对照原文；no：直接记录本题结果。" }, [bind("english.consensus.decision", "finish"), bind("english.consensus.unavailable", "error")]);
        delegate("recompare", "重新比较分歧选项", "english_question_solver", 3040, 900, "仅本题的两个候选有分歧时，宿主再次显式委派。", "本题 + 原文 + 排序后的候选选项；次序不表示优先级", "重新判断的唯一结论；失败保留真实 unavailable 事件", "consensus-recheck");
        model("focus-fallback", "子任务失败 · 收尾剩余题", 2740, 1440, "focused_fallback", "[]；只回答尚未完成的题目，不重放已完成子任务。");
        add("focus-next", "context", "记录本题，继续下一题", 3040, 1190, "将当前结果放入 answers，再进入下一子题。", { strategy: "answers.push(selected)；不将本题答案泄露给下一题子任务。" }, [bind("english.focus.feedback", "finish")]);
        add("focus-done", "output", "汇总逐题答案", 2440, 1440, "达到题目数量后结束遍历；失败收尾仍由原英语策略处理。", { format: "answers.join 换行；保留全部待答题。" }, [bind("english.focus.completed", "finish")]);
        link("route", "focus-route", "no"); link("focus-route", "batch", "yes"); link("focus-route", "direct", "no"); link("batch", "focus-loop");
        link("focus-loop", "focused", "body"); link("focused", "consensus"); link("consensus", "recompare", "yes"); link("consensus", "focus-next", "no"); link("recompare", "focus-next");
        link("focus-next", "focus-loop", "out", "下一题", "continue"); link("focus-loop", "focus-done", "limit", "题目已遍历"); link("focus-done", "focus-loop", "out", "汇总完成", "break"); link("focus-loop", "candidate", "done");
        link("focused", "focus-fallback", "error", "子任务失败"); link("focus-fallback", "focus-loop", "out", "剩余题收尾完成", "break"); link("recompare", "focus-next", "error", "保留已得到的本题结果");
    } else if (!iterativeOnly) link("route", "direct", "no", "完整证据直接作答");

    add("review-enabled", "condition", "启用独立答案复核？", 40, 1850, "由实际 reviewEnabled 与已注册结果处理器决定。", { variable: "runtime.reviewEnabled", operator: "equals", value: "true", rules: "yes：reviewer / reviser 循环；no：沿用宿主未配置复核的行为。" }, [bind("agent.review.loop.started", "finish")]);
    add("review-loop", "loop", "答案复核与修订循环", 340, 1850, "最多 maxRevisions + 1 次核验。只有确定错误且有额度时修订；不确定与无法核验直接退出。", { iterator: "attempt（从 1 开始）", variable: "attempt", operator: "less_or_equal", value: "runtime.maxReviewAttempts", maxIterations: "runtime.maxReviewAttempts", exit: "pass / uncertain / 无剩余修订次数 / 复核异常 → break。", onLimit: "复核仍未通过，返回 failed；不得发布错误候选。", state: "candidate 被真实 reviser 输出替换；attempt 增加，revised=true。" }, [bind("agent.review.loop.started", "start"), bind("agent.review.started", "iteration"), bind("agent.review.completed", "finish"), bind("agent.review.failed", "error")]);
    delegate("review", "Reviewer 独立核验", `${prefix}_reviewer`, 640, 1650, "AnswerReview.process 每次核验显式委派；实际模型 runtime.reviewerModel。", "原题/完整原文 evidence + 当前 candidate", '{verdict: pass|fail|uncertain, reason, issues}');
    add("repair-condition", "condition", "确定错误且仍有修订额度？", 940, 1650, "不是每次复核都重复：pass 结束；uncertain 结束；fail 才检查修订额度。", { variable: "review.canRevise", operator: "equals", value: "true", rules: "report.verdict === fail && revision < maxRevisions；错误协议/调用异常直接 unavailable，不进入修订。" }, [bind("agent.review.decision", "finish")]);
    delegate("reviser", "Reviser 修正候选答案", `${prefix}_reviser`, 1240, 1650, "只有 canRevise=true 时由 AnswerReview 显式委派；使用主求解模型。", "evidence + candidate + 具体 review 问题", "替换后的完整答案，而不是仅返回修改意见");
    add("review-feedback", "context", "替换候选，再次核验", 1240, 1950, "candidate = repair.content，随后进入下一次 reviewer 调用。", { strategy: "不重跑主工具循环；核验的是修订后的新 candidate。" }, [bind("agent.review.revision.completed", "finish")]);
    add("review-result", "review", "记录复核终态并退出", 640, 2160, "passed / failed / uncertain / unavailable 都明确记录，只有 passed 才能视为通过。", { criteria: "按实际 ReviewReport 与宿主修订上限处理。", repair: "保留 attempts、revised 和最终 status；不确定/失败时不释放原错误候选。" }, [bind("agent.review.completed", "finish"), bind("agent.review.failed", "error")]);
    link("candidate", "review-enabled"); link("review-enabled", "review-loop", "yes"); link("review-enabled", "learning", "no", "未配置复核");
    link("review-loop", "review", "body", "本次核验"); link("review", "repair-condition"); link("repair-condition", "reviser", "yes", "fail 且未超限"); link("reviser", "review-feedback"); link("review-feedback", "review-loop", "out", "新候选 · 再次核验", "continue");
    link("repair-condition", "review-result", "no", "通过 / 不确定 / 无修订额度"); link("review-loop", "review-result", "limit", "次数上限"); link("review-result", "review-loop", "out", "保留真实终态", "break"); link("review-loop", "learning", "done");
    link("review", "review-result", "error", "无法完成核验"); link("reviser", "review-result", "error", "无法完成修订"); link("matcher", "prefetch", "error", "经验不可用时继续原求解");
    add("learning", "output", "经验维护与审核", 1540, 2160, "仅在经验库启用且答案复核通过等实际条件满足时执行；未写入、复用和跳过都如实记录。", { format: "现有 SolutionSkillLibrary 管理 author / validator / deduplicator 子任务及原子提交。", persistence: "solution_skills / solution_skill_revisions；不是主智能体任意写库。" }, [bind("agent.skills.created", "finish"), bind("agent.skills.updated", "finish"), bind("agent.skills.split", "finish"), bind("agent.skills.skipped", "finish"), bind("agent.skills.reused", "activity")]);
    add("output", "output", "展示并保存答案", 1840, 2160, "学习者只接收解题内容，画布和过程日志仅管理员可见。", { format: "实际通过或无法可靠确认的回复", persistence: "复用 ChatSessionService 保存结果。" }, [bind("answer.ready", "start"), bind("session.saved", "finish"), bind("session.failed", "error")]);
    add("end", "end", "本轮真实终态", 2140, 2160, "完成、失败、取消、超时和中断以 RunTrace 为准。", {}, [bind("run.success", "finish"), bind("run.failure", "error"), bind("run.cancelled", "error"), bind("run.timed_out", "error"), bind("run.interrupted", "error")]);
    // Maintenance is a host-controlled phase with optional calls, not a fixed
    // author -> validator -> deduplicator sequence (create/split differ).
    add("skill-dispatch", "agent", "按变更类型调度经验子任务", 1240, 2500, "下方是本阶段可调用的子任务关系；实际先后顺序按变更类型决定，并非固定串行或并行。", {
        role: "现有 SolutionSkillLibrary / learning.ts 的提交阶段，不由主求解模型任意调度。",
        instructions: "create/update：生成草稿 → 关系/重复检查 → 独立审核 → 提交。split/多草稿：生成计划 → 批量审核 → 逐组件关系检查 → 原子提交。已有方法可直接复用，未通过则停止提交；确定错误时允许一次修订再审核。具体调用顺序与次数见真实时间线。",
        tools: "共享已注册的 solution_skill_author / validator / deduplicator；子任务默认无工具和再次委派权限。",
    }, [bind("agent.skills.maintenance.started", "start"), bind("agent.skills.maintenance.completed", "finish")]);
    delegate("skill-author", "提炼经验变更草稿", "solution_skill_author", 1540, 2500, "复核通过并且需要维护经验时由宿主触发；允许一次草稿协议纠错。", "原题、已复核答案、已用方法与现有经验目录", "create / update / split 变更计划或无变更");
    delegate("skill-validator", "独立审核经验草稿", "solution_skill_validator", 1840, 2500, "存在有效变更计划时由技能库显式委派，未通过不得写入。", "证据 + 待审核的方法与边界", "pass / fail / uncertain 审核报告");
    delegate("skill-deduplicator", "核对语义重复与版本", "solution_skill_deduplicator", 2140, 2500, "提交前在当前学科事务与锁内按需检查方法重复。", "新方法 + 现有方法候选", "是否复用、更新或提交；保存由现有存储执行");
    for (const edge of edges) if (edge.target === "learning") edge.target = "skill-dispatch";
    for (const id of ["skill-author", "skill-validator", "skill-deduplicator"]) {
        link("skill-dispatch", id, "out", "阶段内按需调用 · 顺序见日志");
        link(id, "learning", "out", "汇总阶段结果");
    }
    for (const id of ["skill-author", "skill-validator", "skill-deduplicator"]) link(id, "learning", "error", "记录未提交原因");
    link("learning", "output"); link("output", "end");
    if (subject === "english") {
        add("format-enabled", "condition", "启用 grounded 格式检查？", 2440, 2850, "EnglishResponseProcessor 仅由 grounded 策略注册；direct 模式不进入该循环。", { variable: "runtime.workflow", operator: "equals", value: "grounded", rules: "yes：检查唯一结论；no：直接进入独立语义复核。" }, [bind("english.response.started", "finish")]);
        add("format-loop", "loop", "检查题号与唯一结论", 2740, 2850, "grounded 的格式处理器检查每题唯一结论；最多修正一次，再交给独立语义复核。", { iterator: "attempt（0 / 1）", variable: "attempt", operator: "less_than", value: "2", maxIterations: "2", exit: "所有题号与唯一答案可解析时 break；不可修复时返回无法可靠确认。", onLimit: "不猜测缺失或冲突的答案，记录 unavailable。", state: "content 可被一次无工具重答替换；同字母的重复结论只规范化一次。" }, [bind("english.response.started", "start"), bind("english.response.check", "iteration"), bind("english.response.completed", "finish")]);
        add("format-valid", "condition", "每题都有唯一结论？", 3040, 2700, "校验的是题号和可见结论格式，不等同于答案语义正确。", { variable: "response.valid", operator: "equals", value: "true", rules: "yes：退出格式检查；no：检查是否还允许一次格式修正。" }, [bind("english.response.check", "finish")]);
        add("format-repairable", "condition", "仍允许一次格式修正？", 3340, 2700, "仅首次格式失败且仍在宿主模型预算内时修正。", { variable: "response.canRepair", operator: "equals", value: "true", rules: "attempt === 0 && result.modelTurns < maxToolSteps + 1。" }, [bind("english.response.invalid", "finish")]);
        model("format-repair", "无工具修正全部题号结论", 3640, 2700, "postprocess", "[]；依据原文重新作答全部题，不能编造参考答案。");
        add("format-unavailable", "output", "格式仍有遗漏或冲突", 3040, 3020, "有限修正后仍不合格，保留 unavailable 并退出，不伪造答案字母。", { format: "明确告知本次英语答案无法可靠确认。" }, [bind("english.response.unavailable", "finish")]);
        const candidateEdge = edges.find(e => e.source === "candidate" && e.target === "review-enabled")!; candidateEdge.target = "format-enabled";
        link("format-enabled", "format-loop", "yes"); link("format-enabled", "review-enabled", "no");
        link("format-loop", "format-valid", "body"); link("format-valid", "format-loop", "yes", "格式有效", "break"); link("format-valid", "format-repairable", "no");
        link("format-repairable", "format-repair", "yes"); link("format-repair", "format-loop", "out", "重新检查格式", "continue"); link("format-repairable", "format-unavailable", "no");
        link("format-loop", "format-unavailable", "limit"); link("format-unavailable", "format-loop", "out", "保留不可用状态", "break"); link("format-loop", "review-enabled", "done");
    }
    return { id: `subject-${subject}`, title: `${names[subject]} · Agent 工作流`, description: "展开真实策略、工具决策循环、宿主委派与复核修订；定义编辑不改变执行引擎。", subject, revision: 1, graph: { schemaVersion: 1, nodes, edges } };
}

/** Explicit allowlist of real settings; never serialize AppConfig or process.env to the browser. */
export function runtimeSnapshot(config: AppConfig, subject: WorkflowSubject): RuntimeSnapshot {
    return { solverModel: config.llmModel, reviewerModel: config.verification.model, reviewEnabled: config.verification.enabled,
        maxRevisions: config.verification.maxRevisions, maxReviewAttempts: config.verification.maxRevisions + 1, timeoutMs: config.llmTimeoutMs,
        maxInputTokens: config.context.maxInputTokens, maxToolSteps: config.context.maxToolSteps,
        maxCallsPerStep: config.harness.maxCallsPerStep, maxProtocolRepairs: config.harness.maxProtocolRepairs,
        modelRetries: config.harness.recovery.modelRetries, toolRetries: config.harness.recovery.toolRetries,
        modelAttemptTimeoutMs: config.harness.recovery.modelAttemptTimeoutMs, toolTimeoutMs: config.harness.toolTimeoutMs,
        skillsEnabled: config.skills.enabled, subject,
        variant: subject === "math" ? config.math.variant : subject === "chinese" ? config.reading.variant : subject === "english" ? config.english.variant : "general",
        instructions: subject === "math" ? MATH_INSTRUCTIONS : subject === "chinese" ? READING_INSTRUCTIONS : subject === "english" ? ENGLISH_INSTRUCTIONS : "",
        ...(subject === "english" ? { workflow: config.english.workflow } : {}) };
}
