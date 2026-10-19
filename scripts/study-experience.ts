import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { PostgresSkillStore } from "../src/infrastructure/persistence/postgres/postgres-skill.store.js";
import { GlmEmbeddings } from "../src/infrastructure/llm/glm-model.js";
import { loadConfig } from "../src/config/env.js";
import { validateSkillCatalog } from "../src/modules/evaluation/skill-retrieval-catalog.js";
import { digest, methodFingerprint, parseSkillDraft, renderSkill, skillText } from "../src/modules/harness/skills/document.js";
import type { SolutionSkill } from "../src/modules/harness/skills/contracts.js";
import { SkillFiles } from "../src/modules/harness/skills/files.js";

/** 联调只使用自编题与通用方法，经验放在独立schema；既有账号只在本机验证登录。 */
const schema = process.env.EXPERIENCE_STUDY_SCHEMA ?? "experience_study_20261019";
if (!/^experience_study_[a-z0-9_]{1,40}$/.test(schema) || !process.env.AUTH_DATABASE_URL || !process.env.LLM_API_KEY) throw new Error("Set study database/API environment and a valid owned schema");
const url = new URL(process.env.AUTH_DATABASE_URL); url.searchParams.set("options", `-c search_path=${schema}`);
process.env.SOLUTION_SKILLS_DATABASE_URL = url.toString();
process.env.SOLUTION_SKILLS_DIR = "data/experience-study/skills";
process.env.SKILLS_SMOKE_FIXTURES ??= "benchmarks/rag/experience-problems.json";
const config = loadConfig(), admin = new Pool({ connectionString: process.env.AUTH_DATABASE_URL });
try { await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`); } finally { await admin.end(); }
const store = new PostgresSkillStore(url.toString());
try {
    await store.initialize();
    const catalog = validateSkillCatalog(JSON.parse(await readFile("benchmarks/rag/skills-catalog.json", "utf8")));
    const compositeDraft = parseSkillDraft({ name: "quadratic-chord-composite", description: "分别处理因式分解求二次方程实根与圆内弦长计算的两问综合题，独立核对各问条件。",
        applicability: ["综合题同时包含可因式分解的二次方程求根与已知半径弦心距求弦长两问"],
        steps: ["第一问确认二次项系数非零并将方程分解为两个一次因式", "分别令一次因式为零并检验全部根", "第二问确认弦心距小于半径，利用垂径定理构造直角三角形", "用勾股定理求半弦长并乘二，各问分别作答"],
        checks: ["方程根代回成立且没有遗漏重根", "弦长计算没有遗漏乘二且几何对象确实存在"],
        exclusions: ["方程无实根或不能在要求数域内因式分解", "直线与圆相切、不相交或几何条件不足"], keywords: ["综合题", "二次方程", "因式分解", "圆", "弦长"] });
    const composite: SolutionSkill = { ...compositeDraft, id: "00000000-0000-4000-8000-000000000005", subject: "math", fingerprint: methodFingerprint(compositeDraft),
        questionShape: digest("authored-composite-fixture"), sourceHash: digest("repository-authored-composite"), answerHash: digest("fixture-not-a-solved-student-answer"),
        markdown: "", createdAt: "2026-10-19T00:00:00.000Z" };
    composite.markdown = renderSkill(composite); catalog.push(composite);
    const embeddings = new GlmEmbeddings({ ...config, llmBaseUrl: config.skills.embeddingBaseUrl, llmApiKey: config.skills.embeddingApiKey });
    for (const subject of ["math", "english", "chinese"]) {
        const existing = await store.list(subject), missing = catalog.filter(skill => skill.subject === subject && !existing.some(item => item.id === skill.id));
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
