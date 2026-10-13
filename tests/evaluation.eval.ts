import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { parseDataset } from "../src/modules/evaluation/dataset.js";
import { grade } from "../src/modules/evaluation/graders.js";
import { rate, reliability, percentile, compare } from "../src/modules/evaluation/statistics.js";
import { evaluate, digest, type EvaluationOptions } from "../src/modules/evaluation/runner.js";
import { html, writeReport } from "../src/modules/evaluation/report.js";
import { loadConfig } from "../src/config/env.js";
import type { EvalDataset } from "../src/modules/evaluation/contracts.js";

// Manual evaluation-platform tests. Local evals/ assets are intentionally outside backend CI.
const fixtureHashes = { datasetHash: "test-dataset", graderHash: "test-grader", systemHash: "test-system" };
const config = loadConfig({ NODE_ENV: "test", AGENT_WORKSPACE_ENABLED: "false", AGENT_TRACE_ENABLED: "false" });
async function dataset() { return parseDataset(JSON.parse(await readFile("evals/agent-v1.json", "utf8"))); }
async function options(overrides: Partial<EvaluationOptions> = {}): Promise<EvaluationOptions> {
    return { mode: "offline", profile: "standard", variant: "normal", repeats: 1, seed: 7,
        directory: await mkdtemp(join(tmpdir(), "agent-eval-")), timeoutMs: 10000, minPassRate: 1, maxRegression: 0, config, ...overrides };
}

test("statistical metrics use finite-sample reliability, Wilson intervals and nearest-rank latency", () => {
    const result = reliability(4, 2, 2); assert.ok(Math.abs(result.passAtK - 5 / 6) < 1e-12); assert.ok(Math.abs(result.passPowerK - 1 / 6) < 1e-12);
    assert.deepEqual(reliability(4, 4, 3), { passAtK: 1, passPowerK: 1 });
    assert.deepEqual(reliability(4, 0, 3), { passAtK: 0, passPowerK: 0 });
    const all = rate(10, 10); assert.ok(all.wilson95[0] < 1); assert.ok(all.wilson95[0] > .7);
    assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), .95), 19);
    assert.throws(() => reliability(3, 2, 4)); assert.throws(() => rate(2, 0));
});

test("dataset validation rejects duplicate IDs, unknown fields and broken patterns", async () => {
    const d = await dataset();
    assert.throws(() => parseDataset({ ...d, cases: [d.cases[0], d.cases[0]] }));
    assert.throws(() => parseDataset({ ...d, extra: true }));
    assert.throws(() => parseDataset({ ...d, cases: [{ ...d.cases[0], expect: { outcome: "success", facts: ["("] } }] }));
});

test("grader rejects an apparently correct answer without required tools or observed evidence", async () => {
    const c = (await dataset()).cases.find(c => c.id === "tool-lookup")!;
    const result = grade(c, "success", "R7 note:release", [], {});
    assert.equal(result.passed, false); assert.ok(result.failures.includes("missing_required_tools")); assert.ok(result.failures.includes("missing_observed_evidence"));
    assert.equal(result.argumentValidity, null);
});

test("all 25 production-harness controls pass repeatedly with independent state and accurate trace metrics", async () => {
    const d = await dataset(); const report = await evaluate(d, await options({ repeats: 2 }), fixtureHashes);
    assert.equal(report.trials.length, 50); assert.equal(report.summary.passRate.value, 1); assert.equal(report.gate.passed, true);
    assert.equal(report.cases.length, 25);
    const correction = report.trials.filter(t => t.caseId === "invalid-arguments-correction");
    assert.ok(correction.every(t => t.grade.argumentValidity === .5 && t.metrics.toolAttempts === 1));
    const backup = report.trials.find(t => t.caseId === "explicit-backup-preserves-evidence")!;
    assert.equal(backup.metrics.toolCalls, 1); assert.equal(backup.metrics.fallbacks, 1); assert.equal(backup.metrics.modelAttempts, 5);
    assert.equal(report.summary.averages.reportedInputTokens, null); assert.equal(report.summary.averages.costUsd, null);
    assert.ok(report.trials.filter(t => t.caseId === "mcp-protocol").every(t => t.events.some(e => e.name === "mcp.discovery.completed")));
    const malicious = report.trials.find(t => t.caseId === "injection-in-tool-output")!;
    assert.doesNotMatch(JSON.stringify(malicious), /EVAL_CANARY_SECRET/);
});

test("negative controls and disabling recovery create detectable, attributable regressions", async () => {
    const full = await dataset(); const d: EvalDataset = { ...full, cases: full.cases.filter(c => ["tool-lookup", "model-transient-retry", "idempotent-tool-retry", "injection-in-tool-output"].includes(c.id)) };
    const base = await evaluate(d, await options(), fixtureHashes);
    for (const variant of ["omit-tools", "wrong-answer"] as const) {
        const mutated = await evaluate(d, await options({ variant, baseline: base }), fixtureHashes);
        assert.equal(mutated.gate.passed, false); assert.ok(mutated.comparison!.regressions.length > 0);
        assert.ok(mutated.summary.passRate.value < base.summary.passRate.value);
    }
    const strict = await evaluate(d, await options({ profile: "no-recovery", baseline: base }), fixtureHashes);
    assert.equal(strict.gate.passed, false); assert.ok(strict.comparison!.regressions.includes("model-transient-retry"));
    assert.throws(() => compare({ ...base, provenance: { ...base.provenance, mode: "live" } }, base), /Incompatible/);
    assert.throws(() => compare({ ...base, provenance: { ...base.provenance, graderHash: "changed" } }, base), /Incompatible/);
    let completed = 0;
    await assert.rejects(evaluate(d, await options({ baseline: base, progress() { completed++; } }), { ...fixtureHashes, graderHash: "changed" }), /Incompatible/);
    assert.equal(completed, 0, "Reject incompatible baselines before running any trials");
});

test("programmatic evaluation rejects invalid thresholds, prices and modes before execution", async () => {
    const d = await dataset();
    for (const invalid of [{ minPassRate: NaN }, { maxRegression: -1 }, { inputUsdPerMillion: 2 }, { inputUsdPerMillion: -1, outputUsdPerMillion: 1 }, { mode: "unsupported" }] as Partial<EvaluationOptions>[]) {
        await assert.rejects(evaluate(d, await options(invalid), fixtureHashes), /Invalid evaluation options/);
    }
});

test("one critical boundary failure cannot be averaged away by an otherwise passing cohort", async () => {
    const d = await dataset();
    const c = d.cases.find(c => c.id === "injection-in-tool-output")!;
    c.script[c.script.length - 1] = { content: "R999" };
    const report = await evaluate(d, await options({ minPassRate: .95 }), fixtureHashes);
    assert.equal(report.summary.passRate.value, .96);
    assert.deepEqual(report.gate.reasons, ["critical_contract_failed"]);
    assert.equal(report.gate.passed, false);
});

test("live mode requires credentials and never substitutes a scripted backup", async () => {
    const d = await dataset(); const opts = await options({ mode: "live" });
    await assert.rejects(evaluate(d, opts, fixtureHashes), /LLM_API_KEY/);
    const backup = { ...d, cases: [{ ...d.cases.find(c => !!c.backupScript)!, modes: ["live" as const] }] };
    await assert.rejects(evaluate(backup, { ...opts, modelFactory: () => ({ async turn() { assert.fail("Must reject before calls"); } }) }, fixtureHashes), /scripted backup/);
});

test("real LangChain usage is measured separately from estimates and priced only with explicit rates", async () => {
    const upstream = createServer(async (req, res) => {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
        res.setHeader("Content-Type", "application/json");
        if (JSON.parse(Buffer.concat(chunks).toString()).model === "primary") { res.statusCode = 503; res.end('{"error":{"message":"temporary"}}'); return; }
        res.end(JSON.stringify({ id: "usage", object: "chat.completion", created: 1, model: "fixture", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "42" } }],
            usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }));
    }).listen(0, "127.0.0.1"); await once(upstream, "listening");
    try {
        const full = await dataset(), d = { ...full, cases: [full.cases[0]!] };
        const liveConfig = loadConfig({ NODE_ENV: "test", LLM_API_KEY: "fixture-private-key", LLM_MODEL: "fixture", LLM_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` });
        const report = await evaluate(d, await options({ mode: "live", config: liveConfig, inputUsdPerMillion: 2, outputUsdPerMillion: 3 }), fixtureHashes);
        assert.equal(report.trials[0]!.metrics.reportedInputTokens, 12); assert.equal(report.trials[0]!.metrics.reportedOutputTokens, 2);
        assert.ok(Math.abs(report.trials[0]!.metrics.costUsd! - .00003) < 1e-12);
        assert.doesNotMatch(JSON.stringify(report), /fixture-private-key/);
        const backupConfig = { ...liveConfig, llmModel: "primary", llmFallback: { model: "fixture", baseUrl: liveConfig.llmBaseUrl, apiKey: liveConfig.llmApiKey },
            harness: { ...liveConfig.harness, recovery: { ...liveConfig.harness.recovery, baseDelayMs: 1, maxDelayMs: 2 } } };
        const backedUp = await evaluate(d, await options({ mode: "live", config: backupConfig }), fixtureHashes);
        assert.equal(backedUp.gate.passed, true); assert.equal(backedUp.trials[0]!.metrics.fallbacks, 1);
        assert.equal(backedUp.provenance.fallbackModel, "fixture");
    } finally { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

test("artifacts escape injected HTML, preserve raw JSON and never overwrite an existing report", async () => {
    const full = await dataset(), report = await evaluate({ ...full, cases: [full.cases[0]!] }, await options(), fixtureHashes);
    report.trials[0]!.answer = '</script><script>alert("injected")</script>';
    const page = html(report); assert.doesNotMatch(page, /<script>alert/); assert.match(page, /\\u003c\/script>/);
    const out = await mkdtemp(join(tmpdir(), "eval-report-")); await writeReport(report, out);
    assert.equal(JSON.parse(await readFile(join(out, "report.json"), "utf8")).trials[0].answer, report.trials[0]!.answer);
    await assert.rejects(writeReport(report, out), { code: "EEXIST" });
});

test("CLI rejects bad options and missing live credentials with a nonzero exit and no fabricated report", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "eval-cli-")), "live");
    const run = (args: string[]) => new Promise<{ code: number; output: string }>(done => execFile(process.execPath, ["--import", "tsx", "scripts/evaluate-agent.ts", ...args],
        { cwd: resolve("."), env: { ...process.env, LLM_API_KEY: "" }, windowsHide: true }, (error, stdout, stderr) => done({ code: typeof error?.code === "number" ? error.code : 0, output: stdout + stderr })));
    assert.equal((await run(["--repeats", "0"])).code, 2);
    const live = await run(["--mode", "live", "--out", out]); assert.equal(live.code, 2); assert.match(live.output, /LLM_API_KEY/);
    await assert.rejects(stat(join(out, "report.json")), { code: "ENOENT" });
    const occupied = await mkdtemp(join(tmpdir(), "eval-occupied-")); await writeFile(join(occupied, "report.json"), "preserve-me");
    const repeated = await run(["--mode", "live", "--out", occupied]); assert.equal(repeated.code, 2); assert.match(repeated.output, /already contains a report/);
    assert.equal(await readFile(join(occupied, "report.json"), "utf8"), "preserve-me");
});
