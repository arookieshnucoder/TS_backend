import { randomUUID } from "node:crypto";
import type { AgentResult, AgentResultContext, AgentRuntime } from "../../agent/contracts.js";
import { parseReviewReport } from "../../agent/answer-review.js";
import { SKILL_AGENTS, type SkillChange, type SolutionSkill, type SolutionSkillDraft } from "./contracts.js";
import { digest, draftSchema, jsonObject, methodFingerprint, parseSkillChange, parseSkillDraft, questionShape, renderSkill, skillRevision, skillText, validateSkillGraph, skillClosure, mergeSkillPatch } from "./document.js";
import type { SolutionSkillLibrary } from "./library.js";

const draftData = (draft: SolutionSkillDraft) => Object.fromEntries(Object.keys(draftSchema.properties).map(key => [key, draft[key as keyof SolutionSkillDraft]]));
const methodRecord = (skill: SolutionSkill) => ({ id: skill.id, revision: skillRevision(skill), componentIds: skill.componentIds, ...draftData(skill) });

/** 兼容原有单方法草稿；新的写操作统一为可审核的变更计划。 */
export function skillChange(value: unknown): SkillChange {
    return value && typeof value === "object" && "action" in value ? parseSkillChange(value) :
        { action: "create", drafts: [parseSkillDraft(value)], reason: "从已复核解答提炼可复用经验" };
}

/** 只允许一次协议纠错；不重放写操作，也不把新草稿误当成已有经验更新。 */
async function requestChange(runtime: AgentRuntime, payload: Record<string, unknown>, signal?: AbortSignal, expected?: SkillChange): Promise<SkillChange | null> {
    let previousResponse = "";
    for (let attempt = 0; ; attempt++) {
        const response = await runtime.delegate({ agent: SKILL_AGENTS.author, input: JSON.stringify({ ...payload,
            ...(expected ? { expectedChange: { action: expected.action, skillId: expected.skillId, expectedRevision: expected.expectedRevision } } : {}),
            ...(attempt ? { previousResponse: previousResponse.slice(0, 22000), protocolCorrection: "上次输出不是合法变更JSON。仅纠正JSON及字段协议，不改目标ID、action或expectedRevision；尚未入库的新草稿不能输出update。create只包含action、drafts、reason；update/split额外包含已有skillId和整数expectedRevision。" } : {}) }) }, signal);
        try {
            const value = jsonObject(response.content);
            if (value === null) return null;
            const change = skillChange(value);
            if (expected && (change.action !== expected.action || change.skillId !== expected.skillId || change.expectedRevision !== expected.expectedRevision ||
                JSON.stringify(change.componentIds ?? []) !== JSON.stringify(expected.componentIds ?? []))) throw new Error("INVALID_SKILL_REPAIR_TARGET");
            return change;
        } catch (error) { if (attempt) throw error; previousResponse = response.content; }
    }
}

/** 查重同时识别包含关系：更小的题型复用已有经验，综合题可引用已有子经验。 */
async function relation(runtime: AgentRuntime, draft: SolutionSkillDraft, catalog: SolutionSkill[], signal?: AbortSignal, targetId?: string) {
    const components: string[] = [];
    for (let offset = 0; offset < catalog.length; offset += 12) {
        const group = catalog.slice(offset, offset + 12);
        let value: unknown;
        for (let attempt = 0; ; attempt++) {
            const response = await runtime.delegate({ agent: SKILL_AGENTS.deduplicator, input: JSON.stringify({ candidate: draft,
                existing: group.map(methodRecord),
                operation: targetId ? "update" : "create", targetId,
                ...(attempt ? { protocolCorrection: "仅返回合法JSON，保留existing中的原始ID。" } : {}) }) }, signal);
            try { value = jsonObject(response.content); break; }
            catch (error) { if (attempt) throw error; }
        }
        const report = value as { verdict?: string; duplicateId?: unknown; relatedIds?: unknown; reason?: unknown };
        if (!report || !["distinct", "duplicate", "covered", "extends", "uncertain"].includes(report.verdict ?? "") || typeof report.reason !== "string" || !report.reason.trim() || report.reason.length > 1500)
            throw new Error("INVALID_SKILL_RELATION_REPORT");
        if (report.verdict === "uncertain") throw new Error("SKILL_RELATION_UNCERTAIN");
        runtime.event("agent.skills.relation", { verdict: report.verdict, id: report.duplicateId, relatedIds: report.relatedIds, reason: report.reason });
        if (report.verdict === "duplicate" || report.verdict === "covered") {
            const reused = group.find(skill => skill.id === report.duplicateId);
            if (!reused) throw new Error("INVALID_SKILL_DUPLICATE_ID");
            // 修订子方法时，被综合方法覆盖是正常包含关系，不等于新增了重复记录。
            if (targetId && report.verdict === "covered") continue;
            return { reused, componentIds: [] };
        }
        if (report.duplicateId !== null) throw new Error("INVALID_SKILL_RELATION_REPORT");
        if (report.verdict === "extends") {
            if (!Array.isArray(report.relatedIds) || !report.relatedIds.length || report.relatedIds.some(id => typeof id !== "string" || !group.some(skill => skill.id === id))) throw new Error("INVALID_SKILL_COMPONENT_REFERENCE");
            components.push(...report.relatedIds);
        }
    }
    return { reused: undefined, componentIds: [...new Set(components)].slice(0, 8) };
}

/** 答案已复核后才进入本流程；更新、拆分及新增子经验共享一个学科事务。 */
export async function learnSkill(library: SolutionSkillLibrary, result: AgentResult, runtime: AgentRuntime, context: AgentResultContext,
    subject: string, proposal: SkillChange | undefined, event: (name: string, fields?: Record<string, unknown>) => void, signal?: AbortSignal, loadedIds: string[] = []) {
    const evidence = { subject, question: context.question, original: context.evidence,
        userHistory: context.history.filter(message => message.role === "user").slice(-3).map(message => message.content), verifiedAnswer: result.content };
    if (JSON.stringify(evidence).length > 65000) throw new Error("SKILL_EVIDENCE_TOO_LARGE");
    let change = proposal;
    if (!change) {
        const catalog = (await library.store.list(subject)).sort((a, b) => Number(loadedIds.includes(b.id)) - Number(loadedIds.includes(a.id)));
        const existing: Record<string, unknown>[] = [];
        for (const skill of catalog.slice(0, 12)) {
            const document = methodRecord(skill);
            if (JSON.stringify([...existing, document]).length > 24000) break;
            existing.push(document);
        }
        const authored = await requestChange(runtime, { ...evidence, existing, catalogTotal: catalog.length, existingTruncated: existing.length < catalog.length }, signal);
        if (authored === null) {
            if (loadedIds.length) for (const id of loadedIds) event("agent.skills.reused", { subject, id, reason: "existing_experience_covers_task" });
            else event("agent.skills.skipped", { subject, reason: "no_reusable_change" });
            return;
        }
        change = authored;
    }
    const plan = change;
    const saved = await library.store.withSubjectLock(subject, async transaction => {
        const catalog = await transaction.list(), changed: SolutionSkill[] = [], reused: SolutionSkill[] = [];
        const previous = plan.skillId ? catalog.find(skill => skill.id === plan.skillId) : undefined;
        if (plan.action !== "create" && (!previous || skillRevision(previous) !== plan.expectedRevision)) throw new Error("SKILL_REVISION_CONFLICT");
        if (plan.patch) { plan.drafts = [mergeSkillPatch(previous!, plan.patch)]; delete plan.patch; }
        const referencedDrafts = (plan.componentIds ?? []).map(id => {
                const skill = catalog.find(item => item.id === id && item.id !== previous?.id);
                if (!skill) throw new Error("INVALID_SKILL_COMPONENT_REFERENCE");
                return parseSkillDraft(draftData(skill));
            });
        const validate = async (drafts: SolutionSkillDraft[], attempt = 1) => {
            const fresh = plan.action === "split" ? drafts.slice(referencedDrafts.length) : drafts;
            const response = await runtime.delegate({ agent: SKILL_AGENTS.validator, input: JSON.stringify({ evidence, draft: fresh[0], drafts: fresh,
                reusedComponents: (plan.componentIds ?? []).map(id => methodRecord(catalog.find(skill => skill.id === id)!)),
                operation: plan.action, previous: previous ? methodRecord(previous) : undefined,
                dependents: previous ? catalog.filter(skill => skill.id !== previous.id && skillClosure(catalog, skill.id).some(part => part.id === previous.id)).map(methodRecord) : [], reason: plan.reason }) }, signal);
            const review = parseReviewReport(response.content);
            event("agent.skills.validation", { subject, verdict: review.verdict, reason: review.reason, issues: review.issues, attempt });
            return review;
        };
        const repair = async (drafts: SolutionSkillDraft[], review: ReturnType<typeof parseReviewReport>) => {
            const revised = await requestChange(runtime, { ...evidence, previousDraft: drafts[0], previousChange: { ...plan, drafts }, validation: review }, signal, plan);
            if (!revised) throw new Error("SKILL_REPAIR_DECLINED");
            return revised.patch ? [mergeSkillPatch(previous!, revised.patch)] : revised.drafts;
        };
        const materialize = async (draft: SolutionSkillDraft, componentIds: string[], target?: SolutionSkill) => {
            draft = parseSkillDraft(draftData(draft));
            const fingerprint = methodFingerprint(draft), embedding = await library.vector(skillText(draft), signal), now = new Date().toISOString();
            const skill: SolutionSkill = { ...draft, id: target?.id ?? randomUUID(), subject, fingerprint,
                questionShape: target?.questionShape ?? (plan.action === "split" || plan.drafts.length > 1 ? digest(`component:${fingerprint}`) : questionShape(context.question)),
                sourceHash: digest(JSON.stringify(evidence)), answerHash: digest(result.content), markdown: "", createdAt: target?.createdAt ?? now,
                revision: target ? skillRevision(target) + 1 : 1, updatedAt: now, ...(embedding ? { embedding } : {}), ...(componentIds.length ? { componentIds } : {}) };
            skill.markdown = renderSkill(skill);
            const next = catalog.filter(item => item.id !== skill.id).concat(skill);
            validateSkillGraph(next); signal?.throwIfAborted();
            if (target) await transaction.update(skill, skillRevision(target), plan.reason); else await transaction.insert(skill);
            const index = catalog.findIndex(item => item.id === skill.id); if (index < 0) catalog.push(skill); else catalog[index] = skill;
            changed.push(skill); return skill;
        };
        const resolve = async (draft: SolutionSkillDraft, target?: SolutionSkill) => {
            // 换数后可能越过适用边界；题形只用于召回，不能作为同一经验的证明。
            const exact = catalog.find(skill => skill.id !== target?.id && skill.id !== previous?.id && skill.fingerprint === methodFingerprint(draft));
            if (exact) return { reused: exact, componentIds: [] };
            // 组合经验本来就包含此子经验，不能把父节点误判为“更新后出现重复”。
            const comparable = catalog.filter(skill => skill.id !== previous?.id && (!target || !skillClosure(catalog, skill.id).some(part => part.id === target.id)));
            return relation(runtime, draft, comparable, signal, target?.id);
        };
        if (plan.action === "split" || plan.drafts.length > 1) {
            let drafts = [...referencedDrafts, ...plan.drafts], review = await validate(drafts);
            if (review.verdict === "fail" && plan.drafts.length) { plan.drafts = await repair(plan.drafts, review); drafts = [...referencedDrafts, ...plan.drafts]; review = await validate(drafts, 2); }
            if (review.verdict !== "pass") throw new Error("SKILL_BATCH_NOT_VERIFIED");
            const children: SolutionSkill[] = [];
            for (const draft of drafts) {
                const found = await resolve(draft);
                if (found.reused) { children.push(found.reused); reused.push(found.reused); }
                else children.push(await materialize(draft, found.componentIds));
            }
            const ids = [...new Set(children.map(skill => skill.id))];
            if (plan.action === "split" && ids.length < 2) throw new Error("SKILL_SPLIT_HAS_NO_DISTINCT_PARTS");
            // 父经验保留整体适用边界；子题直接检索子经验，综合题可沿引用加载。
            if (previous) {
                if (JSON.stringify(previous.componentIds ?? []) === JSON.stringify(ids)) reused.push(previous);
                else await materialize(previous, ids, previous);
            }
        } else {
            let draft = plan.drafts[0]!;
            for (let attempt = 0; ; attempt++) {
                if (previous && methodFingerprint(draft) === previous.fingerprint && JSON.stringify(draft) === JSON.stringify(Object.fromEntries(Object.keys(draft).map(key => [key, previous[key as keyof SolutionSkill]])))) {
                    reused.push(previous); break;
                }
                const found = await resolve(draft, previous);
                if (found.reused) {
                    if (previous) throw new Error("SKILL_UPDATE_DUPLICATES_EXISTING");
                    reused.push(found.reused); break;
                }
                const review = await validate([draft], attempt + 1);
                if (review.verdict === "pass") { await materialize(draft, [...new Set([...(previous?.componentIds ?? []), ...found.componentIds])], previous); break; }
                if (review.verdict !== "fail" || attempt) throw new Error("SKILL_CHANGE_NOT_VERIFIED");
                const repaired = await repair([draft], review);
                if (repaired.length !== 1) throw new Error("INVALID_SKILL_REPAIR_TARGET");
                draft = repaired[0]!;
            }
        }
        if (catalog.length > 1000) throw new Error("SKILL_CATALOG_AUDIT_LIMIT");
        return { changed, reused };
    }, signal);
    for (const skill of new Map([...saved.changed, ...saved.reused].map(skill => [skill.id, skill])).values()) {
        try { await library.files.export(skill); } catch { event("agent.skills.export_failed", { subject, id: skill.id }); }
        event(saved.changed.some(changed => changed.id === skill.id) ? skillRevision(skill) > 1 ? "agent.skills.updated" : "agent.skills.created" : "agent.skills.reused",
            { subject, id: skill.id, name: skill.name, revision: skillRevision(skill), componentIds: skill.componentIds ?? [] });
    }
    if (plan.action === "split") event("agent.skills.split", { subject, id: plan.skillId, components: [...saved.changed, ...saved.reused].find(skill => skill.id === plan.skillId)?.componentIds });
}
