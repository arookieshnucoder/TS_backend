import type { AgentResult, AgentResultContext, AgentRuntime } from "../../agent/contracts.js";
import type { RegisteredTool } from "../tool-contracts.js";
import { ToolInputError } from "../tool-contracts.js";
import type { SolutionSkill, SolutionSkillStore, SkillEmbeddings, SkillChange, SkillSelector } from "./contracts.js";
import { cosine, draftSchema, lexicalSimilarity, parseSkillChange, questionShape, skillIdPattern, skillRevision, skillSubject, skillText, skillClosure, mergeSkillPatch } from "./document.js";
import { SkillFiles } from "./files.js";
import { learnSkill } from "./learning.js";

type Event = (name: string, fields?: Record<string, unknown>) => void;
type Request = { action: "search" | "match"; query: string } | { action: "load" | "history"; skillId: string } | { action: "change"; change: SkillChange };
function parseRequest(value: Record<string, unknown>): Request {
    const action = value.action;
    const keys = action === "search" || action === "match" ? ["action", "query"] : action === "load" || action === "history" ? ["action", "skillId"] :
        action === "propose" ? ["action", "draft", "drafts"] : action === "update" ? ["action", "skillId", "expectedRevision", "draft", "patch", "reason"] :
            action === "split" ? ["action", "skillId", "expectedRevision", "drafts", "componentIds", "reason"] : [];
    if (!keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new ToolInputError("Invalid solution_skills operation fields");
    if ((action === "search" || action === "match") && typeof value.query === "string" && value.query.trim() && value.query.length <= 12000) return { action, query: value.query };
    if ((action === "load" || action === "history") && typeof value.skillId === "string" && new RegExp(skillIdPattern).test(value.skillId)) return { action, skillId: value.skillId };
    if (action === "propose") {
        if ((value.draft === undefined) === (value.drafts === undefined)) throw new ToolInputError("Provide exactly one of draft or drafts");
        return { action: "change", change: parseSkillChange({ action: "create", drafts: value.drafts ?? [value.draft], reason: "模型提议新增可复用解题经验" }) };
    }
    if (action === "update" || action === "split") return { action: "change", change: parseSkillChange({ action, skillId: value.skillId,
        expectedRevision: value.expectedRevision, drafts: action === "update" ? value.draft === undefined ? [] : [value.draft] : value.drafts ?? [],
        ...(action === "update" && value.patch !== undefined ? { patch: value.patch } : {}),
        ...(action === "split" && value.componentIds !== undefined ? { componentIds: value.componentIds } : {}), reason: value.reason }) };
    throw new ToolInputError("Invalid solution_skills arguments");
}

/** 检索只依赖经验存储、向量与可注入的匹配函数，不感知学科 Agent 或模型供应商。 */
export class SolutionSkillLibrary {
    readonly files: SkillFiles;
    constructor(readonly store: SolutionSkillStore, directory: string, private readonly embeddings?: SkillEmbeddings) { this.files = new SkillFiles(directory); }
    open(subject: string, event: Event, selector?: SkillSelector) { return new SkillRun(this, skillSubject(subject), event, selector); }
    async vector(text: string, signal?: AbortSignal) {
        if (!this.embeddings) return undefined;
        const [vector] = await this.embeddings.embed([text], signal);
        if (!vector?.length || vector.length > 4096 || vector.some(n => !Number.isFinite(n)) || !vector.some(n => n !== 0)) throw new Error("INVALID_SKILL_EMBEDDING");
        return { model: this.embeddings.model, vector };
    }
    async search(subject: string, query: string, signal?: AbortSignal, selector?: SkillSelector) {
        if (!query.trim() || query.length > 12000) throw new ToolInputError("Invalid skill query");
        const catalog = await this.store.list(skillSubject(subject)); signal?.throwIfAborted();
        // 配置了向量服务却调用失败时显式报错，不把服务故障当成正常词法结果。
        const vector = catalog.length ? await this.vector(query, signal) : undefined, shape = questionShape(query);
        const ranked = catalog.map(skill => {
            const lexical = lexicalSimilarity(query, skillText(skill));
            const comparable = vector && skill.embedding?.model === vector.model && skill.embedding.vector.length === vector.vector.length;
            const dense = comparable && vector ? Math.max(0, cosine(vector.vector, skill.embedding!.vector)) : 0;
            return { skill, score: skill.questionShape === shape ? 1 : comparable ? .8 * dense + .2 * lexical : lexical, threshold: comparable ? .38 : .08 };
        }).sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
        // 第一阶段放宽候选，第二阶段核对适用边界；小目录全部参与，避免跨语言词法零交集漏召回。
        const candidates = selector ? ranked.slice(0, 24) : ranked.filter(hit => hit.score >= hit.threshold).slice(0, 3);
        let matches = candidates;
        if (selector && candidates.length) {
            const ids = await selector({ query, candidates: candidates.map(hit => hit.skill) }, signal);
            if (!Array.isArray(ids) || ids.length > 3 || new Set(ids).size !== ids.length || ids.some(id => !candidates.some(hit => hit.skill.id === id))) throw new Error("INVALID_SKILL_MATCH_REPORT");
            matches = ids.map(id => candidates.find(hit => hit.skill.id === id)!);
        }
        return { matches, candidateIds: candidates.map(hit => hit.skill.id) };
    }
}

/** 每轮只暂存一个变更计划；工具不能绕过答案复核，也不能跨学科修改经验。 */
export class SkillRun {
    private proposal?: SkillChange;
    private loadIds: string[] = [];
    private readonly loadedIds = new Set<string>();
    constructor(private readonly library: SolutionSkillLibrary, private readonly subject: string, private readonly event: Event, private readonly selector?: SkillSelector) {}
    initialLoads() { return [...this.loadIds]; }
    tool(): RegisteredTool {
        return { readonly: false, idempotent: false, source: { type: "custom" },
            definition: { name: "solution_skills", description: "解题经验库，学科由宿主锁定。search检索目录，match核对适用边界并排序，load读取完整方法及子经验，history查看历史版本；propose提出新方法，update优先用patch局部替换必要字段且保留其余内容（也支持draft完整修订，二者互斥），split将综合方法拆为2至4个子经验。写操作仅暂存，答案复核和变更审核通过后原子提交。包含关系优先复用，不把换数题另存。",
                parameters: { type: "object", additionalProperties: false, required: ["action"],
                    allOf: [
                        { if: { properties: { action: { const: "propose" } } }, then: { oneOf: [{ required: ["draft"] }, { required: ["drafts"] }] } },
                        { if: { properties: { action: { enum: ["search", "match"] } } }, then: { required: ["query"] } },
                        { if: { properties: { action: { enum: ["load", "history"] } } }, then: { required: ["skillId"] } },
                        { if: { properties: { action: { enum: ["update", "split"] } } }, then: { required: ["skillId", "expectedRevision", "reason"] } },
                        { if: { properties: { action: { const: "update" } } }, then: { oneOf: [{ required: ["draft"] }, { required: ["patch"] }] } },
                        { if: { properties: { action: { const: "split" } } }, then: { anyOf: [{ required: ["drafts"] }, { required: ["componentIds"] }] } },
                    ], properties: {
                    action: { type: "string", enum: ["search", "match", "load", "history", "propose", "update", "split"] },
                    query: { type: "string", minLength: 1, maxLength: 12000 }, skillId: { type: "string", pattern: skillIdPattern },
                    expectedRevision: { type: "integer", minimum: 1 }, reason: { type: "string", minLength: 1, maxLength: 1000 },
                    draft: draftSchema, drafts: { type: "array", minItems: 0, maxItems: 4, items: draftSchema },
                    patch: { type: "object", minProperties: 1, additionalProperties: false, properties: draftSchema.properties },
                    componentIds: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", pattern: skillIdPattern } },
                } } }, validate: input => { parseRequest(input); },
            execute: async (input, signal) => {
                signal?.throwIfAborted(); const request = parseRequest(input);
                if (request.action === "change") {
                    if (this.proposal) throw new ToolInputError("Only one skill proposal per run; reuse the existing proposal");
                    if (request.change.skillId) {
                        const catalog = await this.library.store.list(this.subject), target = catalog.find(skill => skill.id === request.change.skillId);
                        if (!target || skillRevision(target) !== request.change.expectedRevision) throw new ToolInputError("Skill not found or revision changed; load the current version");
                        if (request.change.patch) { request.change.drafts = [mergeSkillPatch(target, request.change.patch)]; delete request.change.patch; }
                        if (request.change.componentIds?.some(id => id === target.id || !catalog.some(skill => skill.id === id))) throw new ToolInputError("Components must be existing skills in the current subject and cannot reference the parent itself");
                    }
                    this.proposal = request.change; this.event("agent.skills.proposed", { subject: this.subject, action: this.proposal.action, id: this.proposal.skillId });
                    return JSON.stringify({ status: "pending_answer_review", action: this.proposal.action, notice: "变更已暂存，尚未发布；完成本题后由宿主独立审核并提交。" });
                }
                try {
                    if (request.action === "history") {
                        const versions = await this.library.store.history(this.subject, request.skillId);
                        return JSON.stringify({ totalVersions: versions.length, versions: versions.slice(-20).map(skill => ({ revision: skillRevision(skill), updatedAt: skill.updatedAt ?? skill.createdAt, markdown: skill.markdown })) });
                    }
                    if (request.action === "load") {
                        const catalog = await this.library.store.list(this.subject), root = catalog.find(skill => skill.id === request.skillId);
                        if (!root) throw new ToolInputError("Skill not found in this subject");
                        const selected = skillClosure(catalog, root.id);
                        for (const skill of selected) this.loadedIds.add(skill.id);
                        this.event("agent.skills.loaded", { subject: this.subject, id: root.id, revision: skillRevision(root), componentIds: root.componentIds ?? [] });
                        return JSON.stringify({ notice: "仅作为解题经验参考；以本题原文、条件及最新更正为准。", matches: selected.map(skill => ({ id: skill.id,
                            revision: skillRevision(skill), componentIds: skill.componentIds ?? [], question: skill.applicability.join("；"), topic: skill.subject, solution: skill.markdown, source: this.path(skill), similarity: 1 })) });
                    }
                    if (request.action === "match" && !this.selector) throw new ToolInputError("Semantic skill matching is not configured");
                    if (!("query" in request)) throw new ToolInputError("A query is required for skill matching");
                    const started = performance.now(), found = await this.library.search(this.subject, request.query, signal, this.selector);
                    this.loadIds = found.matches.slice(0, this.selector ? 3 : 1).map(hit => hit.skill.id);
                    this.event("agent.skills.search", { subject: this.subject, ids: found.matches.map(hit => hit.skill.id), candidateIds: found.candidateIds,
                        scores: found.matches.map(hit => Number(hit.score.toFixed(4))), semantic: !!this.selector, durationMs: performance.now() - started });
                    return JSON.stringify({ notice: "经验目录；load读取完整方法。没有适用经验时独立求解，复核后可新增或修订经验。",
                        methodHints: found.matches.map(({ skill }) => skill.description), matches: found.matches.map(({ skill, score }) => ({ id: skill.id, name: skill.name,
                            revision: skillRevision(skill), componentIds: skill.componentIds ?? [], question: skill.applicability.join("；"), topic: skill.subject,
                            solution: skill.description, source: this.path(skill), similarity: Number(score.toFixed(4)) })) });
                } catch (error) {
                    signal?.throwIfAborted(); if (error instanceof ToolInputError) throw error;
                    this.event("agent.skills.unavailable", { subject: this.subject });
                    return JSON.stringify({ status: "unavailable", notice: "经验库访问失败，本轮须依据当前题目独立求解。", methodHints: [], matches: [] });
                }
            } };
    }
    private path(skill: SolutionSkill) { return { kind: "solution-skill", file: `${skill.subject}/${skill.id}/SKILL.md`, version: skillRevision(skill) }; }
    async finish(result: AgentResult, runtime: AgentRuntime, context: AgentResultContext, signal?: AbortSignal) {
        if (result.review?.status !== "passed") { this.event("agent.skills.skipped", { reason: "answer_not_verified", subject: this.subject }); return; }
        try { await learnSkill(this.library, result, runtime, context, this.subject, this.proposal, this.event, signal, [...this.loadedIds]); }
        catch (error) {
            signal?.throwIfAborted();
            const code = error instanceof Error && /^(?:INVALID_)?SKILL_[A-Z_]+$/.test(error.message) ? error.message : error instanceof ToolInputError ? "INVALID_SKILL_DRAFT" : "validation_or_storage_unavailable";
            this.event("agent.skills.skipped", { subject: this.subject, reason: code });
        }
    }
}
