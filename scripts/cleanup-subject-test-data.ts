import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { parseStoredSkill, renderSkill, skillRevision } from "../src/modules/harness/skills/document.js";
import { SkillFiles } from "../src/modules/harness/skills/files.js";

// One explicitly audited incident; no credentials or broad schema-name matching.
const skillId = "e7fc8e41-c7e2-4001-8382-84dbbd2f159a";
const reason = "修复古诗词经验误归数学学科；迁移至语文学科并保留原始修订审计记录";
const schemas = [
    ["experience_study_20261019", "archive_20261031_study_20261019"],
    ["experience_study_20261019_v3", "archive_20261031_study_20261019_v3"],
    ["experience_study_20261019_v5", "archive_20261031_study_20261019_v5"],
    ["harness_smoke_7b9c68dfbdfc41349fcbc6516c45373d", "archive_20261031_smoke_7b9c68df"],
    ["harness_smoke_d17ec7a980d74deca770b03d63c1f227", "archive_20261031_smoke_d17ec7a9"],
    ["harness_smoke_faba86c11e7c4be4b368ec41256dc0a0", "archive_20261031_smoke_faba86c1"],
] as const;
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--apply")) throw new Error("Usage: tsx scripts/cleanup-subject-test-data.ts [--apply]");
const apply = args.includes("--apply");
const backend = fileURLToPath(new URL("..", import.meta.url));
const data = resolve(backend, "data");
const skillRoot = join(data, "solution-skills");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const backup = join(data, "cleanup-backups", `20261031-${stamp}`);
function insideData(path: string) {
    const target = resolve(path), rel = relative(data, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("BACKUP_PATH_OUTSIDE_DATA");
    return target;
}
async function exists(path: string) { return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; }); }
async function safePath(path: string) {
    const target = insideData(path);
    if ((await lstat(data)).isSymbolicLink() || resolve(await realpath(data)).toLowerCase() !== data.toLowerCase()) throw new Error("UNSAFE_DATA_DIRECTORY");
    let cursor = data;
    for (const part of relative(data, target).split(/[\\/]/)) {
        cursor = join(cursor, part);
        if (await exists(cursor)) {
            if ((await lstat(cursor)).isSymbolicLink()) throw new Error("SYMLINK_IN_MAINTENANCE_PATH");
            insideData(await realpath(cursor));
        }
    }
    return target;
}
const quote = (name: string) => { if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error("UNSAFE_SCHEMA_NAME"); return `"${name}"`; };
async function counts(client: PoolClient) {
    return {
        subjects: (await client.query("SELECT subject,count(*)::integer AS count FROM public.solution_skills GROUP BY subject ORDER BY subject")).rows,
        users: Number((await client.query("SELECT count(*) AS count FROM public.auth_users")).rows[0].count),
        sessions: Number((await client.query("SELECT count(*) AS count FROM public.auth_sessions")).rows[0].count),
        admins: (await client.query("SELECT username,role FROM public.auth_users WHERE role='admin' ORDER BY username")).rows,
        workflows: Number((await client.query("SELECT count(*) AS count FROM public.workflow_definitions")).rows[0].count),
    };
}
const pool = new Pool({ connectionString: process.env.AUTH_DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 20000 });
let databaseCommitted = false;
try {
    const client = await pool.connect();
    let report: Record<string, unknown> = {};
    let updated: ReturnType<typeof parseStoredSkill>;
    try {
        await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
        const db = (await client.query("SELECT current_database() AS name")).rows[0].name;
        if (db !== "agentest") throw new Error("MAINTENANCE_REQUIRES_AGENTEST_DATABASE");
        if (apply) {
            // Same lock order used by normal skill initialization/writes.
            await client.query("SELECT pg_advisory_xact_lock(741280164)");
            for (const subject of ["chinese", "math"]) await client.query("SELECT pg_advisory_xact_lock(741280165,hashtext($1))", [subject]);
            await client.query("LOCK TABLE public.solution_skills,public.solution_skill_revisions IN SHARE ROW EXCLUSIVE MODE");
        }
        const before = await counts(client);
        const found = await client.query("SELECT * FROM public.solution_skills WHERE id=$1", [skillId]);
        if (found.rowCount !== 1) throw new Error("AUDITED_SKILL_MISSING");
        const original = parseStoredSkill(found.rows[0].document);
        if (original.name !== "classical-poetry-comprehensive-analysis") throw new Error("AUDITED_SKILL_CHANGED");
        const alreadyMigrated = original.subject === "chinese" && skillRevision(original) === 2;
        if (!alreadyMigrated && (original.subject !== "math" || found.rows[0].subject !== "math" || skillRevision(original) !== 1)) throw new Error("AUDITED_SKILL_REVISION_CHANGED");
        if ((original.componentIds ?? []).length) throw new Error("AUDITED_SKILL_HAS_COMPONENTS");
        const refs = await client.query("SELECT id FROM public.solution_skills WHERE coalesce(document->'componentIds','[]'::jsonb) ? $1", [skillId]);
        if (refs.rowCount) throw new Error("AUDITED_SKILL_HAS_DEPENDENTS");
        const conflicts = await client.query("SELECT id FROM public.solution_skills WHERE subject='chinese' AND fingerprint=$1 AND id<>$2", [original.fingerprint, skillId]);
        if (conflicts.rowCount) throw new Error("TARGET_SUBJECT_FINGERPRINT_CONFLICT");
        const history = (await client.query("SELECT * FROM public.solution_skill_revisions WHERE skill_id=$1 ORDER BY revision", [skillId])).rows;
        if (!history.some(row => row.revision === 1)) throw new Error("ORIGINAL_REVISION_MISSING");
        const archives: Array<{ source: string; target: string; active: boolean; skills: number; revisions: number }> = [];
        const snapshot: Record<string, unknown> = {};
        for (const [source, target] of schemas) {
            const names = (await client.query("SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])", [[source, target]])).rows.map(row => row.nspname);
            if (names.length !== 1) throw new Error("ARCHIVE_SCHEMA_MISSING_OR_CONFLICT");
            const active = names[0] === source, current = active ? source : target;
            if (apply && active) await client.query(`LOCK TABLE ${quote(current)}.solution_skills,${quote(current)}.solution_skill_revisions IN SHARE MODE`);
            const skills = (await client.query(`SELECT * FROM ${quote(current)}.solution_skills ORDER BY id`)).rows;
            const revisions = (await client.query(`SELECT * FROM ${quote(current)}.solution_skill_revisions ORDER BY skill_id,revision`)).rows;
            snapshot[source] = { sourceSchema: current, archiveSchema: target, solution_skills: skills, solution_skill_revisions: revisions };
            archives.push({ source, target, active, skills: skills.length, revisions: revisions.length });
        }
        updated = alreadyMigrated ? original : { ...original, subject: "chinese", revision: 2, updatedAt: new Date().toISOString() };
        updated.markdown = renderSkill(updated);
        parseStoredSkill(updated);
        report = { mode: apply ? "apply" : "dry-run", database: db, skillId, before, archives, alreadyMigrated,
            expectedSubjects: before.subjects.map(row => ({ ...row, count: row.count + (!alreadyMigrated ? row.subject === "math" ? -1 : row.subject === "chinese" ? 1 : 0 : 0) })),
            ...(apply ? { backup } : {}) };
        if (!apply) {
            await client.query("ROLLBACK");
            console.log(JSON.stringify(report, null, 2));
            process.exitCode = 0;
        } else {
            const plannedNewFile = await safePath(join(skillRoot, "chinese", skillId, "SKILL.md"));
            const plannedOldFile = await safePath(join(skillRoot, "math", skillId, "SKILL.md"));
            if (await exists(plannedNewFile) && await readFile(plannedNewFile, "utf8") !== updated.markdown) throw new Error("TARGET_SKILL_FILE_CONFLICT");
            if (await exists(plannedOldFile) && await readFile(plannedOldFile, "utf8") !== history.find(row => row.revision === 1).document.markdown) throw new Error("OLD_SKILL_FILE_CHANGED");
            await safePath(backup);
            await mkdir(backup, { recursive: true });
            const beforeSnapshot = { ...report, exportedAt: new Date().toISOString(), originalSkill: found.rows[0], originalRevisions: history, schemas: snapshot };
            await writeFile(join(backup, "before.json"), JSON.stringify(beforeSnapshot, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
            // Read back the backup before mutating the database.
            if (JSON.parse(await readFile(join(backup, "before.json"), "utf8")).originalSkill.id !== skillId) throw new Error("BACKUP_VERIFICATION_FAILED");
            for (const archive of archives) if (archive.active) await client.query(`ALTER SCHEMA ${quote(archive.source)} RENAME TO ${quote(archive.target)}`);
            if (!alreadyMigrated) {
                const result = await client.query("UPDATE public.solution_skills SET subject='chinese',document=$2 WHERE id=$1 AND subject='math'", [skillId, JSON.stringify(updated)]);
                if (result.rowCount !== 1) throw new Error("SKILL_MIGRATION_CONFLICT");
                await client.query("INSERT INTO public.solution_skill_revisions(skill_id,revision,document,reason) VALUES($1,2,$2,$3)", [skillId, JSON.stringify(updated), reason]);
            }
            const after = await counts(client);
            if (JSON.stringify(before.admins) !== JSON.stringify(after.admins) || before.users !== after.users || before.sessions !== after.sessions || before.workflows !== after.workflows) throw new Error("UNRELATED_DATA_CHANGED");
            if (JSON.stringify(after.subjects) !== JSON.stringify(report.expectedSubjects)) throw new Error("SUBJECT_COUNTS_CHANGED");
            for (const archive of archives) {
                const oldName = (await client.query("SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname=$1", [archive.source])).rows[0].n;
                const skillCount = (await client.query(`SELECT count(*)::integer AS n FROM ${quote(archive.target)}.solution_skills`)).rows[0].n;
                const revisionCount = (await client.query(`SELECT count(*)::integer AS n FROM ${quote(archive.target)}.solution_skill_revisions`)).rows[0].n;
                if (oldName !== 0 || skillCount !== archive.skills || revisionCount !== archive.revisions) throw new Error("ARCHIVE_VERIFICATION_FAILED");
            }
            const reloaded = parseStoredSkill((await client.query("SELECT document FROM public.solution_skills WHERE id=$1", [skillId])).rows[0].document);
            if (reloaded.subject !== "chinese" || skillRevision(reloaded) !== 2) throw new Error("MIGRATED_SKILL_INVALID");
            const revisionRows = (await client.query("SELECT revision,document->>'subject' AS subject FROM public.solution_skill_revisions WHERE skill_id=$1 ORDER BY revision", [skillId])).rows;
            if (revisionRows.length !== 2 || revisionRows[0].subject !== "math" || revisionRows[1].subject !== "chinese") throw new Error("REVISION_AUDIT_INVALID");
            await client.query("COMMIT");
            databaseCommitted = true;
            report = { ...report, after, revisions: revisionRows, committed: true };
            // File exports are rebuildable. If interrupted, re-running repairs them safely.
            const newFile = await safePath(join(skillRoot, "chinese", skillId, "SKILL.md"));
            if (await exists(newFile) && await readFile(newFile, "utf8") !== updated.markdown) throw new Error("TARGET_SKILL_FILE_CONFLICT");
            await new SkillFiles(skillRoot).export(updated);
            const oldDirectory = await safePath(join(skillRoot, "math", skillId));
            const oldFile = join(oldDirectory, "SKILL.md");
            if (await exists(oldFile)) {
                const originalMarkdown = history.find(row => row.revision === 1).document.markdown;
                if ((await readFile(oldFile, "utf8")) !== originalMarkdown) throw new Error("OLD_SKILL_FILE_CHANGED");
                const destination = await safePath(join(backup, "old-math-export", skillId));
                if (await exists(destination)) throw new Error("BACKUP_EXPORT_DESTINATION_EXISTS");
                await mkdir(dirname(destination), { recursive: true });
                await rename(oldDirectory, destination);
            }
            if (!await exists(newFile) || await exists(oldFile) || await readFile(newFile, "utf8") !== updated.markdown) throw new Error("EXPORT_VERIFICATION_FAILED");
            report = { ...report, exportedSkill: newFile, oldMathExportAbsent: true, finishedAt: new Date().toISOString() };
            await writeFile(join(backup, "report.json"), JSON.stringify(report, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
            console.log(JSON.stringify(report, null, 2));
        }
    } catch (error) {
        if (!databaseCommitted) await client.query("ROLLBACK").catch(() => {});
        if (apply && await exists(backup)) await writeFile(join(backup, "failure.json"), JSON.stringify({ databaseCommitted, code: error instanceof Error ? error.message : "MAINTENANCE_FAILED" }, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 }).catch(() => {});
        throw error;
    } finally { client.release(); }
} catch (error) {
    // Never print a provider/connection error body that may expose credentials.
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : (error as { code?: string })?.code ?? "MAINTENANCE_FAILED";
    console.error(JSON.stringify({ error: code, databaseCommitted }));
    process.exitCode = 1;
} finally { await pool.end(); }
