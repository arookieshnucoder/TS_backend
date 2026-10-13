import { evaluateMath } from "../src/modules/evaluation/math-runner.js";
import { MATH_VARIANTS } from "../src/modules/math/contracts.js";
const args = process.argv.slice(2), options = new Map<string, string>();
try {
    if (args.includes("--help")) { console.log("npm run eval:math -- --split development|test --out data/evaluations/math-<new> --repeats 1 --concurrency 2 --thinking disabled [--variants baseline,agent,harness,combined]"); }
    else {
        for (let i = 0; i < args.length; i += 2) { const key = args[i]?.replace(/^--/, ""), value = args[i + 1];
            if (!args[i]?.startsWith("--") || !key || !["split", "out", "repeats", "seed", "concurrency", "timeout-ms", "thinking", "variants"].includes(key) || !value || value.startsWith("--") || options.has(key)) throw new Error("Invalid CLI options"); options.set(key, value); }
        const result = await evaluateMath({ split: (options.get("split") ?? "development") as "development" | "test", out: options.get("out") ?? `data/evaluations/math-${Date.now()}`,
            repeats: Number(options.get("repeats") ?? 1), seed: Number(options.get("seed") ?? 20261013), concurrency: Number(options.get("concurrency") ?? 2), timeoutMs: Number(options.get("timeout-ms") ?? 120000),
            variants: (options.get("variants")?.split(",") ?? MATH_VARIANTS) as typeof MATH_VARIANTS, thinking: (options.get("thinking") ?? "disabled") as "enabled" | "disabled",
            progress(done, total, variant, trial) { console.log(`${done}/${total} ${variant} ${trial.caseId} ${trial.grade.passed ? "PASS" : "FAIL"} ${(trial.metrics.durationMs / 1000).toFixed(1)}s ${trial.grade.failures.join(",")}`); } });
        console.log(JSON.stringify(result.rows));
        if (!result.allRunsCompleted || result.rows.some(r => r.total === 0)) process.exitCode = 1;
    }
} catch (error) { console.error(error instanceof Error ? error.message : "Math evaluation failed"); process.exitCode = 2; }
