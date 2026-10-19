import { Pool, type PoolClient } from "pg";
import { AppError } from "../../common/errors/app-error.js";
import { graphIssues, graphStructureIssues, type WorkflowRecord, type WorkflowSnapshot, type WorkflowVersion } from "./definition.js";

const schema = `
CREATE TABLE IF NOT EXISTS workflow_definitions (
 id VARCHAR(100) PRIMARY KEY, title VARCHAR(100) NOT NULL, description TEXT NOT NULL,
 subject VARCHAR(16) NOT NULL CHECK(subject IN ('math','chinese','english','general')),
 revision INTEGER NOT NULL CHECK(revision > 0), graph JSONB NOT NULL,
 published_revision INTEGER, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by VARCHAR(100) NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_versions (
 workflow_id VARCHAR(100) NOT NULL REFERENCES workflow_definitions(id), revision INTEGER NOT NULL,
 snapshot JSONB NOT NULL, published_at TIMESTAMPTZ NOT NULL DEFAULT now(), published_by VARCHAR(100) NOT NULL,
 PRIMARY KEY(workflow_id,revision)
);`;
function decode(row: Record<string, any>): WorkflowRecord {
    return { id: row.id, title: row.title, description: row.description, subject: row.subject, revision: row.revision,
        graph: row.graph, publishedRevision: row.published_revision, updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by };
}
const snapshot = ({ id, title, description, subject, revision, graph }: WorkflowSnapshot): WorkflowSnapshot => ({ id, title, description, subject, revision, graph });
const notFound = () => new AppError(404, "WORKFLOW_NOT_FOUND", "工作流或发布版本不存在。");
export function assertDefinition(value: unknown): asserts value is Omit<WorkflowSnapshot, "id" | "revision"> {
    const v = value as Record<string, unknown> | null;
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["title", "description", "subject", "graph"].includes(k)) ||
        typeof v.title !== "string" || !v.title.trim() || v.title.length > 100 || typeof v.description !== "string" || v.description.length > 3000 || !["math", "chinese", "english", "general"].includes(String(v.subject))) throw new AppError(400, "WORKFLOW_INVALID", "工作流标题、说明或分类无效。");
    const issues = graphStructureIssues(v.graph);
    if (issues.length) throw new AppError(400, "WORKFLOW_INVALID_GRAPH", issues[0]!.message);
}

/** PostgreSQL is the only definition/version store. Revision checks never silently overwrite. */
export class WorkflowStore {
    readonly pool: Pool;
    private initialization?: Promise<void>;
    constructor(databaseUrl: string | undefined, private readonly seeds: WorkflowSnapshot[]) {
        this.pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, query_timeout: 10000, statement_timeout: 10000 });
        this.pool.on("error", () => {});
    }
    private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try { await client.query("BEGIN"); const result = await operation(client); await client.query("COMMIT"); return result; }
        catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
    }
    initialize(): Promise<void> {
        return this.initialization ??= this.transaction(async client => {
            await client.query("SELECT pg_advisory_xact_lock(741280165)"); await client.query(schema);
            for (const seed of this.seeds) {
                const inserted = await client.query(`INSERT INTO workflow_definitions(id,title,description,subject,revision,graph,published_revision,updated_by)
                    VALUES($1,$2,$3,$4,1,$5,1,'system') ON CONFLICT(id) DO NOTHING RETURNING id`, [seed.id, seed.title, seed.description, seed.subject, seed.graph]);
                if (inserted.rowCount) await client.query("INSERT INTO workflow_versions(workflow_id,revision,snapshot,published_by) VALUES($1,1,$2,'system')", [seed.id, snapshot(seed)]);
                else if (seed.graph.nodes.some(node => node.type === "loop")) {
                    // Upgrade only untouched, published system templates. User drafts and
                    // every historical run/version keep their original graph.
                    const result = await client.query("SELECT * FROM workflow_definitions WHERE id=$1 FOR UPDATE", [seed.id]);
                    const old = decode(result.rows[0]);
                    if (old.updatedBy === "system" && old.publishedRevision === old.revision && !old.graph.nodes.some(node => node.type === "loop")) {
                        const upgraded = { ...seed, revision: old.revision + 1 };
                        await client.query("UPDATE workflow_definitions SET title=$2,description=$3,graph=$4,revision=$5,published_revision=$5,updated_at=now() WHERE id=$1", [seed.id, seed.title, seed.description, seed.graph, upgraded.revision]);
                        await client.query("INSERT INTO workflow_versions(workflow_id,revision,snapshot,published_by) VALUES($1,$2,$3,'system')", [seed.id, upgraded.revision, snapshot(upgraded)]);
                    }
                }
            }
        }).catch(error => { this.initialization = undefined; throw error; });
    }
    async list() {
        await this.initialize();
        const { rows } = await this.pool.query("SELECT id,title,description,subject,revision,published_revision,updated_at,updated_by FROM workflow_definitions ORDER BY id");
        return rows.map(row => { const { graph: _graph, ...value } = decode(row); return value; });
    }
    async get(id: string): Promise<WorkflowRecord> {
        await this.initialize(); const { rows } = await this.pool.query("SELECT * FROM workflow_definitions WHERE id=$1", [id]);
        if (!rows[0]) throw notFound(); return decode(rows[0]);
    }
    async create(id: string, input: unknown, actor: string) {
        assertDefinition(input); await this.initialize();
        const { rows } = await this.pool.query("INSERT INTO workflow_definitions(id,title,description,subject,revision,graph,updated_by) VALUES($1,$2,$3,$4,1,$5,$6) RETURNING *", [id, input.title.trim(), input.description, input.subject, input.graph, actor]);
        return decode(rows[0]);
    }
    async save(id: string, input: unknown, revision: number, actor: string) {
        assertDefinition(input); await this.initialize();
        const { rows } = await this.pool.query(`UPDATE workflow_definitions SET title=$2,description=$3,subject=$4,graph=$5,revision=revision+1,updated_by=$6,updated_at=now() WHERE id=$1 AND revision=$7 RETURNING *`, [id, input.title.trim(), input.description, input.subject, input.graph, actor, revision]);
        if (!rows[0]) { await this.get(id); throw new AppError(409, "WORKFLOW_CONFLICT", "该流程已被其他管理员修改，请重新载入后合并修改。"); }
        return decode(rows[0]);
    }
    async publish(id: string, revision: number, actor: string) {
        await this.initialize();
        return this.transaction(async client => {
            const { rows } = await client.query("SELECT * FROM workflow_definitions WHERE id=$1 FOR UPDATE", [id]);
            if (!rows[0]) throw notFound(); const value = decode(rows[0]);
            if (value.revision !== revision) throw new AppError(409, "WORKFLOW_CONFLICT", "该流程已经更新，请重新载入后发布。");
            const issues = graphIssues(value.graph);
            if (issues.length) throw new AppError(400, "WORKFLOW_INCOMPLETE", issues.map(i => i.message).join(" ").slice(0, 2000));
            await client.query("INSERT INTO workflow_versions(workflow_id,revision,snapshot,published_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [id, revision, snapshot(value), actor]);
            const result = await client.query("UPDATE workflow_definitions SET published_revision=$2 WHERE id=$1 RETURNING *", [id, revision]);
            return decode(result.rows[0]);
        });
    }
    async versions(id: string) {
        await this.get(id);
        const { rows } = await this.pool.query("SELECT revision,published_at,published_by,snapshot->>'title' AS title FROM workflow_versions WHERE workflow_id=$1 ORDER BY revision DESC LIMIT 100", [id]);
        return rows.map(row => ({ revision: row.revision, title: row.title, publishedAt: new Date(row.published_at).toISOString(), publishedBy: row.published_by }));
    }
    async version(id: string, revision?: number): Promise<WorkflowVersion> {
        await this.initialize();
        const { rows } = await this.pool.query(`SELECT v.* FROM workflow_versions v JOIN workflow_definitions d ON d.id=v.workflow_id
            WHERE v.workflow_id=$1 AND v.revision=COALESCE($2::integer,d.published_revision)`, [id, revision ?? null]);
        if (!rows[0]) throw notFound(); const row = rows[0];
        return { ...row.snapshot, publishedAt: new Date(row.published_at).toISOString(), publishedBy: row.published_by };
    }
    async close() { await this.pool.end(); }
}
