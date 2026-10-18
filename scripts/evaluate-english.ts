import { evaluateEnglish } from "../src/modules/evaluation/english-runner.js";
import type { EnglishVariant } from "../src/modules/english/contracts.js";
import type { EnglishWorkflow } from "../src/modules/english/response.js";
const args = process.argv.slice(2), values = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--out", "--corpus", "--split", "--variants", "--limit", "--concurrency", "--input-tokens", "--context-tokens", "--thinking", "--workflow"].includes(key) || !value || values.has(key)) throw new Error("Invalid English evaluation arguments");
    values.set(key, value);
}
if (!values.has("--out")) throw new Error("Provide --out NEW_DIRECTORY");
const report = await evaluateEnglish({ out: values.get("--out")!, corpusPath: values.get("--corpus"), split: (values.get("--split") ?? "test") as "test",
    variants: (values.get("--variants")?.split(",") ?? ["adaptive"]) as EnglishVariant[], limit: Number(values.get("--limit") ?? 500),
    concurrency: Number(values.get("--concurrency") ?? 3), maxInputTokens: Number(values.get("--input-tokens") ?? 8192), contextTokens: Number(values.get("--context-tokens") ?? 1800),
    thinking: (values.get("--thinking") ?? "disabled") as "disabled", workflow: (values.get("--workflow") ?? "grounded") as EnglishWorkflow });
console.log(JSON.stringify({ result: report.rows }));
