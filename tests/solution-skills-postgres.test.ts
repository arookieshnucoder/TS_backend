import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { PostgresSkillStore } from "../src/infrastructure/persistence/postgres/postgres-skill.store.js";
import { methodFingerprint, questionShape, renderSkill } from "../src/modules/harness/skills/document.js";
import type { SolutionSkill } from "../src/modules/harness/skills/contracts.js";

test("real PostgreSQL skill transactions serialize across processes, roll back and survive restart", { skip: !process.env.SKILLS_TEST_DATABASE_URL }, async () => {
    const connectionString = process.env.SKILLS_TEST_DATABASE_URL!;
    const admin = new Pool({ connectionString });
    const schema = `skills_test_${randomBytes(8).toString("hex")}`;
    const url = new URL(connectionString); url.searchParams.set("options", `-c search_path=${schema}`);
    let stores: PostgresSkillStore[] = [];
    const candidate = (name = "quadratic-factoring"): SolutionSkill => {
        const method = { name, description: "一元二次方程通过因式分解转化为一次方程并检验全部根。", applicability: ["可在所需数域因式分解的一元二次方程"],
            steps: ["移项整理为零等式", "利用零乘积法则求解两个一次因式"], checks: ["代回原方程检验所有根"], exclusions: ["不可因式分解时改用求根公式"], keywords: ["二次方程", "因式分解"] };
        const skill: SolutionSkill = { ...method, id: randomUUID(), subject: "math", fingerprint: methodFingerprint(method), questionShape: questionShape("解方程x²-7x+12=0"),
            sourceHash: "a".repeat(64), answerHash: "b".repeat(64), markdown: "", createdAt: new Date().toISOString() };
        skill.markdown = renderSkill(skill); return skill;
    };
    try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        stores = [new PostgresSkillStore(url.toString()), new PostgresSkillStore(url.toString())];
        await Promise.all(stores.map(store => store.initialize()));
        const decisions = await Promise.all(Array.from({ length: 6 }, (_, i) => stores[i % 2]!.withSubjectLock("math", async tx => {
            const existing = await tx.list(); if (existing.length) return "reused";
            await tx.insert(candidate()); return "created";
        })));
        assert.equal(decisions.filter(value => value === "created").length, 1);
        assert.equal((await stores[0]!.list("math")).length, 1); assert.equal((await stores[1]!.list("english")).length, 0);
        await assert.rejects(stores[0]!.withSubjectLock("math", async tx => { await tx.insert(candidate("same-method-new-name")); } ), { code: "23505" });
        await assert.rejects(stores[0]!.withSubjectLock("english", async tx => { await tx.insert(candidate()); }), /SUBJECT_MISMATCH/);
        const abort = new AbortController();
        await assert.rejects(stores[0]!.withSubjectLock("english", async tx => {
            const skill = { ...candidate(), subject: "english" }; skill.markdown = renderSkill(skill);
            await tx.insert(skill); abort.abort();
        }, abort.signal), { name: "AbortError" });
        assert.deepEqual(await stores[0]!.list("english"), []);
        const original = (await stores[0]!.list("math"))[0]!;
        const revised = { ...original, revision: 2, updatedAt: new Date().toISOString(), checks: [...original.checks, "含参数时检查降次情况"] };
        revised.markdown = renderSkill(revised);
        await stores[0]!.withSubjectLock("math", tx => tx.update(revised, 1, "补充条件核对"));
        await assert.rejects(stores[1]!.withSubjectLock("math", tx => tx.update(revised, 1, "并发旧版本写入")), /REVISION_CONFLICT/);
        assert.equal((await stores[0]!.history("math", original.id)).length, 2);
        assert.deepEqual((await stores[0]!.history("english", original.id)), []);
        const badReference = { ...revised, revision: 3, componentIds: [randomUUID()] }; badReference.markdown = renderSkill(badReference);
        await assert.rejects(stores[0]!.withSubjectLock("math", tx => tx.update(badReference, 2, "不能引用不存在的子经验")), /COMPONENT_REFERENCE/);
        assert.equal((await stores[0]!.history("math", original.id)).length, 2);
        const saved = (await stores[0]!.list("math"))[0]!;
        // 相同题形可以因适用边界不同而拥有不同经验，不能由换数指纹强行去重。
        const boundary = { ...candidate("quadratic-domain-check"), applicability: ["先判断二次方程在实数域中是否存在根"],
            steps: ["确认二次项系数非零", "计算判别式并判断实根存在性"], exclusions: ["二次项系数为零时先按一次方程分类"] };
        boundary.fingerprint = methodFingerprint(boundary); boundary.markdown = renderSkill(boundary);
        await stores[0]!.withSubjectLock("math", tx => tx.insert(boundary));
        assert.equal((await stores[0]!.list("math")).length, 2);
        await Promise.all(stores.map(store => store.close())); stores = [new PostgresSkillStore(url.toString())];
        assert.deepEqual((await stores[0]!.list("math"))[0], saved);
        assert.deepEqual((await stores[0]!.history("math", original.id))[0], original);
    } finally {
        await Promise.all(stores.map(store => store.close()));
        if (!/^skills_test_[a-f0-9]{16}$/.test(schema)) throw new Error("Invalid owned test schema");
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
    }
});
