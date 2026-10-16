import { evaluateReading } from "../src/modules/evaluation/reading-runner.js";
import { READING_VARIANTS, type ReadingVariant } from "../src/modules/reading/contracts.js";
const args = process.argv.slice(2), values = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1];
    if (!["--out", "--corpus", "--split", "--variants", "--limit", "--concurrency", "--input-tokens", "--context-tokens"].includes(key) || !value || values.has(key)) throw new Error("Invalid reading evaluation arguments");
    values.set(key, value);
}
if (!values.has("--out")) throw new Error("Provide --out NEW_DIRECTORY");
await evaluateReading({ out: values.get("--out")!, split: (values.get("--split") ?? "test") as "development" | "test",
    corpusPath: values.get("--corpus"),
    variants: (values.get("--variants")?.split(",") ?? [...READING_VARIANTS]) as ReadingVariant[], limit: Number(values.get("--limit") ?? 40),
    concurrency: Number(values.get("--concurrency") ?? 3), maxInputTokens: Number(values.get("--input-tokens") ?? 8192), contextTokens: Number(values.get("--context-tokens") ?? 1400) });
