import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { PostgresSkillStore } from "../src/infrastructure/persistence/postgres/postgres-skill.store.js";
import { GlmEmbeddings } from "../src/infrastructure/llm/glm-model.js";
import { loadConfig } from "../src/config/env.js";
import { validateSkillCatalog } from "../src/modules/evaluation/skill-retrieval-catalog.js";
import { digest, skillText, skillClosure } from "../src/modules/harness/skills/document.js";
import { SkillFiles } from "../src/modules/harness/skills/files.js";

/** 联调只使用自编题与通用方法，经验放在独立schema；既有账号只在本机验证登录。 */
const schema = process.env.EXPERIENCE_STUDY_SCHEMA ?? "experience_study_20261019";
if (!/^experience_study_[a-z0-9_]{1,40}$/.test(schema) || !process.env.AUTH_DATABASE_URL || !process.env.LLM_API_KEY) throw new Error("Set study database/API environment and a valid owned schema");
const url = new URL(process.env.AUTH_DATABASE_URL); url.searchParams.set("options", `-c search_path=${schema}`);
process.env.SOLUTION_SKILLS_DATABASE_URL = url.toString();
process.env.SOLUTION_SKILLS_DIR = "data/experience-study/skills";
const config = loadConfig(), admin = new Pool({ connectionString: process.env.AUTH_DATABASE_URL });
try { await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`); } finally { await admin.end(); }
const store = new PostgresSkillStore(url.toString());
try {
    await store.initialize();
    // 默认不预置经验；仅在手动指定时导入经验快照，不依赖旧固定数据。
    const catalog = process.env.EXPERIENCE_STUDY_CATALOG ? validateSkillCatalog(JSON.parse(await readFile(process.env.EXPERIENCE_STUDY_CATALOG, "utf8"))) : [];
    const embeddings = new GlmEmbeddings({ ...config, llmBaseUrl: config.skills.embeddingBaseUrl, llmApiKey: config.skills.embeddingApiKey });
    for (const subject of ["math", "english", "chinese"]) {
        const existing = await store.list(subject), missing = catalog.filter(skill => skill.subject === subject && !existing.some(item => item.id === skill.id))
            .sort((a, b) => skillClosure(catalog, a.id).length - skillClosure(catalog, b.id).length);
        if (!missing.length) continue;
        const vectors = await embeddings.embed(missing.map(skillText));
        await store.withSubjectLock(subject, async transaction => {
            for (const [index, skill] of missing.entries()) await transaction.insert({ ...skill, createdAt: "2026-10-19T00:00:00.000Z",
                questionShape: digest(`authored-fixture:${skill.id}`), embedding: { model: embeddings.model, vector: vectors[index]! } });
        });
    }
    const initial = (await Promise.all(["math", "english", "chinese"].map(subject => store.list(subject)))).flat();
    for (const skill of initial) await new SkillFiles(config.skills.directory).export(skill);
    await mkdir("data/experience-study", { recursive: true });
    await writeFile("data/experience-study/initial-catalog.json", JSON.stringify(initial, null, 2));
    console.log(JSON.stringify({ studySchema: schema, syntheticSkills: initial.length, catalogHash: createHash("sha256").update(JSON.stringify(initial)).digest("hex") }));
} finally { await store.close(); }

try { await import("./smoke-solution-skills.js"); }
finally {
    const snapshot = new PostgresSkillStore(url.toString());
    try {
        const catalog = (await Promise.all(["math", "english", "chinese"].map(subject => snapshot.list(subject)))).flat();
        await writeFile("data/experience-study/learned-catalog.json", JSON.stringify(catalog, null, 2));
        console.log(JSON.stringify({ persistedStudySkills: catalog.length, revised: catalog.filter(skill => (skill.revision ?? 1) > 1).length }));
    } finally { await snapshot.close(); }
}
