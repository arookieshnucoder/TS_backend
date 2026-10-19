import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SolutionSkill, SolutionSkillStore } from "../harness/skills/contracts.js";
import { digest, methodFingerprint, parseSkillDraft, renderSkill, skillSubject, parseStoredSkill, validateSkillGraph } from "../harness/skills/document.js";

/** 导出文件不包含原始题形与向量，读取时明确标记缺失，不能编造。 */
export function parseSkillExport(markdown: string): SolutionSkill {
    const field = (key: string) => markdown.match(new RegExp(`^${key}: (.+)$`, "m"))?.[1];
    const id = field("id"), subject = skillSubject(field("subject"));
    if (!id || !/^[a-f0-9-]{36}$/.test(id) || field("version") !== "1") throw new Error("Invalid skill export");
    const section = (heading: string) => {
        const body = markdown.split(`## ${heading}\n\n`)[1]?.split(/\n## |\n关键词：/)[0] ?? "";
        return [...body.matchAll(/^\d+\. (.+)$/gm)].map(match => match[1]!);
    };
    const draft = parseSkillDraft({ name: field("name"), description: JSON.parse(field("description") ?? "null"),
        applicability: section("适用条件"), steps: section("解题流程"), checks: section("校验"), exclusions: section("不适用情形"),
        keywords: (markdown.match(/^关键词：(.+)$/m)?.[1] ?? "").split("、") });
    const skill = { ...draft, id, subject, markdown, fingerprint: methodFingerprint(draft), questionShape: "unavailable-in-export",
        ...(field("revision") ? { revision: Number(field("revision")) } : {}), ...(field("components") ? { componentIds: JSON.parse(field("components")!) as string[] } : {}),
        sourceHash: digest(markdown), answerHash: "unavailable-in-export", createdAt: "unavailable-in-export" };
    if (renderSkill(skill).trim() !== markdown.trim()) throw new Error("Skill export does not match its fields");
    return parseStoredSkill(skill);
}

export async function readSkillExports(directory: string): Promise<SolutionSkill[]> {
    const skills: SolutionSkill[] = [];
    for (const subject of (await readdir(directory, { withFileTypes: true })).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        for (const entry of (await readdir(join(directory, subject.name), { withFileTypes: true })).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
            const skill = parseSkillExport((await readFile(join(directory, subject.name, entry.name, "SKILL.md"), "utf8")).replace(/\r\n/g, "\n"));
            if (skill.id !== entry.name || skill.subject !== subject.name) throw new Error("Skill path and document disagree");
            skills.push(skill);
        }
    }
    return validateSkillCatalog(skills);
}

export function validateSkillCatalog(value: unknown): SolutionSkill[] {
    if (!Array.isArray(value) || !value.length) throw new Error("Skill catalog must be nonempty");
    const seen = new Set<string>();
    for (const raw of value) {
        const skill = parseStoredSkill(raw);
        if (seen.has(skill.id)) throw new Error("Duplicate catalog ID");
        seen.add(skill.id);
    }
    validateSkillGraph(value as SolutionSkill[]);
    return value as SolutionSkill[];
}

export function readonlySkillStore(skills: SolutionSkill[]): SolutionSkillStore {
    return { async initialize() {}, async close() {}, async list(subject) { return structuredClone(skills.filter(skill => skill.subject === subject)); },
        async history(subject, id) { return structuredClone(skills.filter(skill => skill.subject === subject && skill.id === id)); },
        async withSubjectLock() { throw new Error("Evaluation cannot write skills"); } };
}
