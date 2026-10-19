import { Pool, type PoolClient } from "pg";
import type { SolutionSkill, SolutionSkillStore, SkillTransaction } from "../../../modules/harness/skills/contracts.js";
import { parseStoredSkill, skillRevision, skillSubject, validateSkillGraph } from "../../../modules/harness/skills/document.js";

const schema = `CREATE TABLE IF NOT EXISTS solution_skills (
    id UUID PRIMARY KEY,
    subject VARCHAR(32) NOT NULL,
    fingerprint CHAR(64) NOT NULL,
    question_shape CHAR(64) NOT NULL,
    document JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(subject, fingerprint)
);
ALTER TABLE solution_skills DROP CONSTRAINT IF EXISTS solution_skills_subject_question_shape_key;
CREATE INDEX IF NOT EXISTS solution_skills_subject ON solution_skills(subject);
CREATE INDEX IF NOT EXISTS solution_skills_shape ON solution_skills(subject, question_shape);
CREATE TABLE IF NOT EXISTS solution_skill_revisions (
    skill_id UUID NOT NULL REFERENCES solution_skills(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    document JSONB NOT NULL,
    reason TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(skill_id, revision)
);
INSERT INTO solution_skill_revisions(skill_id, revision, document, reason)
SELECT id, COALESCE((document->>'revision')::integer, 1), document, '保留现有经验版本'
FROM solution_skills ON CONFLICT DO NOTHING;`;

/** PostgreSQL 保存经验与不可覆盖的历史版本；SKILL.md 只是可重建的导出。 */
export class PostgresSkillStore implements SolutionSkillStore {
    readonly pool: Pool;
    private pending?: Promise<void>;
    constructor(databaseUrl?: string) {
        this.pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000,
            statement_timeout: 120000, query_timeout: 125000 });
        this.pool.on("error", () => {});
    }
    initialize(): Promise<void> {
        return this.pending ??= this.transaction(async client => {
            await client.query("SELECT pg_advisory_xact_lock(741280164)"); await client.query(schema);
        }).catch(error => { this.pending = undefined; throw error; });
    }
    private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try { await client.query("BEGIN"); const result = await operation(client); await client.query("COMMIT"); return result; }
        catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
    }
    private async read(query: Pick<PoolClient, "query">, subject: string): Promise<SolutionSkill[]> {
        // 超出审核上限时显式拒绝发布，避免悄悄漏掉旧记录中的重复经验。
        const { rows } = await query.query("SELECT document FROM solution_skills WHERE subject = $1 ORDER BY created_at, id LIMIT 1001", [skillSubject(subject)]);
        if (rows.length > 1000) throw new Error("SKILL_CATALOG_AUDIT_LIMIT");
        return rows.map(({ document }) => { const skill = parseStoredSkill(document); if (skill.subject !== subject) throw new Error("SKILL_SUBJECT_MISMATCH"); return skill; });
    }
    async list(subject: string) { await this.initialize(); return this.read(this.pool, subject); }
    async history(subject: string, skillId: string) {
        await this.initialize();
        const { rows } = await this.pool.query(`SELECT r.document FROM solution_skill_revisions r JOIN solution_skills s ON s.id=r.skill_id
            WHERE s.subject=$1 AND s.id=$2 ORDER BY r.revision`, [skillSubject(subject), skillId]);
        return rows.map(({ document }) => parseStoredSkill(document));
    }
    async withSubjectLock<T>(subject: string, operation: (transaction: SkillTransaction) => Promise<T>, signal?: AbortSignal): Promise<T> {
        await this.initialize(); skillSubject(subject);
        return this.transaction(async client => {
            signal?.throwIfAborted();
            await client.query("SELECT pg_advisory_xact_lock(741280165, hashtext($1))", [subject]);
            signal?.throwIfAborted();
            const result = await operation({ list: () => this.read(client, subject), insert: async skill => {
                signal?.throwIfAborted();
                if (skill.subject !== subject) throw new Error("SKILL_SUBJECT_MISMATCH");
                parseStoredSkill(skill); validateSkillGraph([...(await this.read(client, subject)), skill]);
                await client.query(`INSERT INTO solution_skills(id, subject, fingerprint, question_shape, document, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
                    [skill.id, subject, skill.fingerprint, skill.questionShape, JSON.stringify(skill), skill.createdAt]);
                await client.query("INSERT INTO solution_skill_revisions(skill_id,revision,document,reason) VALUES($1,$2,$3,$4)",
                    [skill.id, skillRevision(skill), JSON.stringify(skill), "新增已审核经验"]);
            }, update: async (skill, expectedRevision, reason) => {
                signal?.throwIfAborted(); parseStoredSkill(skill);
                if (skill.subject !== subject || skillRevision(skill) !== expectedRevision + 1 || !reason.trim() || reason.length > 1000) throw new Error("INVALID_SKILL_UPDATE");
                validateSkillGraph((await this.read(client, subject)).map(existing => existing.id === skill.id ? skill : existing));
                const updated = await client.query(`UPDATE solution_skills SET fingerprint=$3, question_shape=$4, document=$5
                    WHERE id=$1 AND subject=$2 AND COALESCE((document->>'revision')::integer,1)=$6`,
                    [skill.id, subject, skill.fingerprint, skill.questionShape, JSON.stringify(skill), expectedRevision]);
                if (updated.rowCount !== 1) throw new Error("SKILL_REVISION_CONFLICT");
                await client.query("INSERT INTO solution_skill_revisions(skill_id,revision,document,reason) VALUES($1,$2,$3,$4)",
                    [skill.id, skillRevision(skill), JSON.stringify(skill), reason]);
            } });
            signal?.throwIfAborted(); return result;
        });
    }
    async close() { await this.pool.end(); }
}
