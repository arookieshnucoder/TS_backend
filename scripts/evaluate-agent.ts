import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDataset } from "../src/modules/evaluation/dataset.js";
import { evaluate, digest, sourceHash, type EvaluationOptions } from "../src/modules/evaluation/runner.js";
import { writeReport } from "../src/modules/evaluation/report.js";
import type { EvalReport } from "../src/modules/evaluation/contracts.js";

const args = process.argv.slice(2), values = new Map<string, string>();
const allowed = new Set(["mode", "profile", "variant", "repeats", "seed", "out", "dataset", "baseline", "timeout-ms", "min-pass-rate", "max-regression", "input-usd-per-million", "output-usd-per-million"]);
try {
    if (args.includes("--help")) {
        console.log("npm run eval -- --mode offline|live --repeats 5 --out data/evaluations/<new-run> [--profile standard|no-recovery] [--variant normal|omit-tools|wrong-answer] [--baseline report.json] [--min-pass-rate 0.95] [--max-regression 0.02]\nEach output directory must be new. Live requires LLM_API_KEY; no model/fixture fallback. See docs/AGENT_EVALUATION.md.");
    } else {
        for (let i = 0; i < args.length; i += 2) {
            const key = args[i]?.replace(/^--/, ""), value = args[i + 1];
            if (!args[i]?.startsWith("--") || !key || !allowed.has(key) || !value || value.startsWith("--") || values.has(key)) throw new Error("Invalid or duplicate CLI option");
            values.set(key, value);
        }
        const choice = (key: string, fallback: string, options: string[]) => { const value = values.get(key) ?? fallback; if (!options.includes(value)) throw new Error(`Invalid --${key}`); return value; };
        const number = (key: string, fallback: number, min: number, max: number, integer = false) => {
            const value = values.has(key) ? Number(values.get(key)) : fallback;
            if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Invalid --${key}`); return value;
        };
        const dataset = parseDataset(JSON.parse(await readFile(resolve(values.get("dataset") ?? "evals/agent-v1.json"), "utf8")));
        const mode = choice("mode", "offline", ["offline", "live"]);
        if (values.has("input-usd-per-million") !== values.has("output-usd-per-million")) throw new Error("Both token prices are required");
        const out = resolve(values.get("out") ?? `data/evaluations/${mode}-${Date.now()}`);
        for (const name of ["report.json", "report.md", "report.html"]) {
            try { await stat(resolve(out, name)); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
            throw new Error("Output already contains a report; use a new --out directory");
        }
        const options: EvaluationOptions = { mode: mode as EvaluationOptions["mode"], profile: choice("profile", "standard", ["standard", "no-recovery"]) as EvaluationOptions["profile"],
            variant: choice("variant", "normal", ["normal", "omit-tools", "wrong-answer"]) as EvaluationOptions["variant"], repeats: number("repeats", 5, 1, 100, true), seed: number("seed", 20261012, 0, 4294967295, true),
            directory: resolve("data/evaluations/fixtures"), timeoutMs: number("timeout-ms", mode === "live" ? 120000 : 10000, 5, 600000, true),
            minPassRate: number("min-pass-rate", .95, 0, 1), maxRegression: number("max-regression", .02, 0, 1),
            ...(values.has("baseline") ? { baseline: JSON.parse(await readFile(resolve(values.get("baseline")!), "utf8")) as EvalReport } : {}),
            ...(values.has("input-usd-per-million") ? { inputUsdPerMillion: number("input-usd-per-million", 0, 0, 100000), outputUsdPerMillion: number("output-usd-per-million", 0, 0, 100000) } : {}),
            progress(done, total, trial) { if (done % 10 === 0 || done === total || !trial.grade.passed) console.log(`${done}/${total} ${trial.caseId} ${trial.grade.passed ? "PASS" : "FAIL"} ${trial.grade.failures.join(",")}`); },
        };
        const report = await evaluate(dataset, options, { datasetHash: digest(JSON.stringify(dataset)), graderHash: digest((await Promise.all(["graders", "statistics", "dataset"].map(name => readFile(`src/modules/evaluation/${name}.ts`, "utf8")))).map(s => s.replace(/\r\n/g, "\n")).join("\0")),
            systemHash: digest((await Promise.all([sourceHash(resolve("src")), ...["scripts/evaluate-agent.ts", "evals/fixtures/mcp-server.mjs", "package-lock.json"].map(path => readFile(path, "utf8"))])).map(s => s.replace(/\r\n/g, "\n")).join("\0")) });
        await writeReport(report, out);
        console.log(`${report.summary.passRate.successes}/${report.summary.passRate.total} passed; gate=${report.gate.passed}; ${out}`);
        if (!report.gate.passed) process.exitCode = 1;
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : "Evaluation failed"); process.exitCode = 2;
}
