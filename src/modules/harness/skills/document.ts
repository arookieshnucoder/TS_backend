import { createHash } from "node:crypto";
import { ToolInputError } from "../tool-contracts.js";
import type { SolutionSkill, SolutionSkillDraft, SkillChange } from "./contracts.js";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export function skillSubject(value: unknown): string {
    if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new ToolInputError("Invalid skill subject");
    return value;
}
export function jsonObject(content: string): unknown {
    return JSON.parse(content.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, "$1"));
}
const fields = ["name", "description", "applicability", "steps", "checks", "exclusions", "keywords"] as const;
// 文档只描述解题方法，不承载可执行脚本或工具权限。
const forbidden = /<\/?(?:system|assistant|tool|script)\b|(?:ignore|override)\s+(?:all\s+)?(?:previous|system|instructions)|忽略.{0,8}(?:指令|规则|系统)|(?:api[_ -]?key|password|authorization)\s*[:=]|(?:https?:\/\/|file:\/\/)|(?:执行|运行).{0,8}(?:命令|脚本|代码)|powershell|cmd\.exe|eval\s*\(/i;
export function parseSkillDraft(value: unknown): SolutionSkillDraft {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key as typeof fields[number])))
        throw new ToolInputError("Invalid skill document fields");
    const raw = value as Record<string, unknown>;
    const string = (key: string, min: number, max: number) => {
        const text = raw[key];
        if (typeof text !== "string" || text.trim().length < min || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
            throw new ToolInputError(`Invalid skill ${key}`);
        return text.trim();
    };
    const list = (key: string, min: number, max: number, size = 280) => {
        const items = raw[key];
        if (!Array.isArray(items) || items.length < min || items.length > max || items.some(item => typeof item !== "string" || !item.trim() || item.length > size))
            throw new ToolInputError(`Invalid skill ${key}`);
        const result = items.map(item => (item as string).trim());
        if (new Set(result.map(normalize)).size !== result.length) throw new ToolInputError(`Duplicate skill ${key}`);
        return result;
    };
    const draft: SolutionSkillDraft = { name: string("name", 3, 64), description: string("description", 12, 350),
        applicability: list("applicability", 1, 5), steps: list("steps", 2, 8), checks: list("checks", 1, 5),
        exclusions: list("exclusions", 1, 5), keywords: list("keywords", 2, 12, 40) };
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(draft.name)) throw new ToolInputError("Skill name must be a lowercase slug");
    if (forbidden.test(JSON.stringify(draft)) || JSON.stringify(draft).length > 5000) throw new ToolInputError("Unsafe or oversized skill document");
    return draft;
}
export const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, "").replace(/[，。；：、,.!?！？]/g, "");
/** 将数值替换为占位符，仅用于识别题形提示，不采信模型提供的名称。 */
const shapeText = (text: string) => normalize(text.replace(/²/g, "^2").replace(/³/g, "^3"))
    .replace(/\^(-?\d+)/g, (_match, exponent: string) => `power${[...exponent].map(digit => ({ "-": "minus", "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine" })[digit]).join("")}`)
    .replace(/\d+(?:\.\d+)?/g, "#");
export const questionShape = (question: string) => digest(shapeText(question.split(/\n\s*A[.．]/)[0]!));
export const methodFingerprint = (draft: SolutionSkillDraft) => digest(shapeText(JSON.stringify([draft.applicability, draft.steps, draft.exclusions])));
export const skillText = (skill: SolutionSkillDraft) => [skill.description, ...skill.applicability, ...skill.keywords, ...skill.steps].join("\n");
export const skillRevision = (skill: SolutionSkill) => skill.revision ?? 1;
export const skillIdPattern = "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$";
export function parseSkillPatch(value: unknown): Partial<SolutionSkillDraft> {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length ||
        Object.keys(value).some(key => !fields.includes(key as typeof fields[number])) || JSON.stringify(value).length > 5000 || forbidden.test(JSON.stringify(value))) throw new ToolInputError("Invalid skill patch fields");
    return value as Partial<SolutionSkillDraft>;
}
export function mergeSkillPatch(skill: SolutionSkillDraft, patch: Partial<SolutionSkillDraft>) {
    return parseSkillDraft({ ...Object.fromEntries(fields.map(key => [key, skill[key]])), ...patch });
}
export function parseSkillChange(value: unknown): SkillChange {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolInputError("Invalid skill change");
    const raw = value as Record<string, unknown>;
    const drafts = raw.drafts === undefined ? [] : raw.drafts;
    if (Object.keys(raw).some(key => !["action", "skillId", "expectedRevision", "drafts", "patch", "componentIds", "reason"].includes(key)) ||
        !["create", "update", "split"].includes(String(raw.action)) || !Array.isArray(drafts) ||
        typeof raw.reason !== "string" || !raw.reason.trim() || raw.reason.length > 1000) throw new ToolInputError("Invalid skill change");
    const action = raw.action as SkillChange["action"];
    const patch = raw.patch === undefined ? undefined : parseSkillPatch(raw.patch);
    if (patch && action !== "update") throw new ToolInputError("Only update accepts a partial patch");
    const ids = raw.componentIds ?? [];
    if (!Array.isArray(ids) || ids.length > 4 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !new RegExp(skillIdPattern).test(id)) || action !== "split" && ids.length) throw new ToolInputError("Invalid existing component IDs");
    if (action === "create" ? raw.skillId !== undefined || raw.expectedRevision !== undefined || drafts.length < 1 || drafts.length > 4 :
        typeof raw.skillId !== "string" || !new RegExp(skillIdPattern).test(raw.skillId) || !Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 1 ||
        (action === "update" ? drafts.length !== (patch ? 0 : 1) : drafts.length + ids.length < 2 || drafts.length + ids.length > 4)) throw new ToolInputError("create requires 1..4 drafts; update requires exactly one full draft or patch; update/split require existing skillId and integer expectedRevision; split needs 2..4 parts");
    return { action, ...(action === "create" ? {} : { skillId: raw.skillId as string, expectedRevision: raw.expectedRevision as number }),
        drafts: drafts.map(parseSkillDraft), ...(patch ? { patch } : {}), ...(ids.length ? { componentIds: ids as string[] } : {}), reason: raw.reason.trim() };
}
export function lexicalSimilarity(a: string, b: string): number {
    const grams = (value: string) => {
        const text = normalize(value); const out = new Set(text.match(/[a-z]+/g) ?? []);
        for (let i = 0; i < text.length - 1; i++) out.add(text.slice(i, i + 2));
        return out;
    };
    const left = grams(a), right = grams(b);
    return [...left].filter(term => right.has(term)).length / Math.max(1, Math.min(left.size, right.size));
}
export function cosine(a: number[], b: number[]): number {
    if (a.length !== b.length || !a.length) return 0;
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2; }
    return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
export function renderSkill(skill: Pick<SolutionSkill, "id" | "subject" | "revision" | "componentIds"> & SolutionSkillDraft): string {
    const section = (heading: string, lines: string[]) => `## ${heading}\n\n${lines.map((line, i) => `${i + 1}. ${line}`).join("\n")}\n`;
    return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\nsubject: ${skill.subject}\nid: ${skill.id}\nversion: 1\n` +
        ((skill.revision ?? 1) > 1 ? `revision: ${skill.revision}\n` : "") + (skill.componentIds?.length ? `components: ${JSON.stringify(skill.componentIds)}\n` : "") + `---\n\n` +
        `# ${skill.name}\n\n${skill.description}\n\n` + section("适用条件", skill.applicability) + "\n" + section("解题流程", skill.steps) + "\n" +
        section("校验", skill.checks) + "\n" + section("不适用情形", skill.exclusions) + `\n关键词：${skill.keywords.join("、")}\n`;
}
export const draftSchema = { type: "object", additionalProperties: false, required: [...fields], properties: {
    name: { type: "string", pattern: "^[a-z][a-z0-9-]{2,63}$", maxLength: 64 }, description: { type: "string", minLength: 12, maxLength: 350 },
    ...Object.fromEntries(["applicability", "steps", "checks", "exclusions", "keywords"].map(key => [key, { type: "array", items: { type: "string", maxLength: key === "keywords" ? 40 : 280 }, minItems: key === "steps" || key === "keywords" ? 2 : 1, maxItems: key === "keywords" ? 12 : key === "steps" ? 8 : 5 }])),
} };

/** 数据库、快照和导出共用文档校验，避免各入口各维护一套结构。 */
export function parseStoredSkill(value: unknown): SolutionSkill {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_STORED_SKILL");
    const skill = value as SolutionSkill;
    const draft = parseSkillDraft(Object.fromEntries(fields.map(key => [key, skill[key]])));
    if (!new RegExp(skillIdPattern).test(skill.id) || typeof skill.questionShape !== "string" || !skill.questionShape ||
        !Number.isSafeInteger(skillRevision(skill)) || skillRevision(skill) < 1 ||
        skill.componentIds !== undefined && (!Array.isArray(skill.componentIds) || skill.componentIds.length > 8 ||
            new Set(skill.componentIds).size !== skill.componentIds.length || skill.componentIds.some(id => typeof id !== "string" || !new RegExp(skillIdPattern).test(id) || id === skill.id)) ||
        renderSkill({ ...skill, ...draft, subject: skillSubject(skill.subject) }) !== skill.markdown) throw new Error("INVALID_STORED_SKILL");
    if (skill.embedding && (typeof skill.embedding.model !== "string" || !skill.embedding.model || !Array.isArray(skill.embedding.vector) || !skill.embedding.vector.length || skill.embedding.vector.length > 4096 ||
        skill.embedding.vector.some(n => typeof n !== "number" || !Number.isFinite(n)) || !skill.embedding.vector.some(n => n !== 0))) throw new Error("INVALID_SKILL_EMBEDDING");
    return { ...skill, ...draft };
}

/** 子经验图必须同学科、无环且深度有限；提交前检查完整图。 */
export function validateSkillGraph(skills: SolutionSkill[]) {
    for (const skill of skills) skillClosure(skills, skill.id);
}
/** 加载与评测共用依赖展开，防止“评分覆盖了子经验但实际未加载”的口径偏差。 */
export function skillClosure(skills: SolutionSkill[], rootId: string): SolutionSkill[] {
    const catalog = new Map(skills.map(skill => [skill.id, skill])), selected = new Map<string, SolutionSkill>();
    const root = catalog.get(rootId);
    if (!root) throw new Error("INVALID_SKILL_COMPONENT_REFERENCE");
    const visit = (skill: SolutionSkill, path: Set<string>) => {
        if (path.has(skill.id) || path.size >= 4) throw new Error("INVALID_SKILL_COMPONENT_GRAPH");
        if (selected.has(skill.id)) return;
        if (selected.size >= 16) throw new Error("INVALID_SKILL_COMPONENT_GRAPH");
        selected.set(skill.id, skill);
        for (const id of skill.componentIds ?? []) {
            const child = catalog.get(id);
            if (!child || child.subject !== root.subject) throw new Error("INVALID_SKILL_COMPONENT_REFERENCE");
            visit(child, new Set([...path, skill.id]));
        }
    };
    visit(root, new Set()); return [...selected.values()];
}
