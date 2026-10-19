import { mkdir, lstat, writeFile, rename, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { SolutionSkill } from "./contracts.js";
import { skillSubject } from "./document.js";

/** 路径由宿主决定；拒绝符号链接目录，并以原子替换方式导出。 */
export class SkillFiles {
    constructor(readonly root: string) { this.root = resolve(root); }
    async export(skill: SolutionSkill): Promise<string> {
        skillSubject(skill.subject);
        if (!/^[a-f0-9-]{36}$/.test(skill.id)) throw new Error("INVALID_SKILL_ID");
        await mkdir(this.root, { recursive: true });
        if ((await lstat(this.root)).isSymbolicLink()) throw new Error("UNSAFE_SKILL_DIRECTORY");
        const actualRoot = await realpath(this.root);
        let directory = actualRoot;
        for (const part of [skill.subject, skill.id]) {
            directory = join(directory, part); await mkdir(directory, { recursive: true });
            if ((await lstat(directory)).isSymbolicLink()) throw new Error("UNSAFE_SKILL_DIRECTORY");
            const rel = relative(actualRoot, await realpath(directory));
            if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("UNSAFE_SKILL_DIRECTORY");
        }
        const target = join(directory, "SKILL.md"), temporary = join(directory, `${randomUUID()}.tmp`);
        await writeFile(temporary, skill.markdown, { encoding: "utf8", flag: "wx" });
        await rename(temporary, target);
        return `${skill.subject}/${skill.id}/SKILL.md`;
    }
}
