import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { englishChoice } from "../src/modules/english/agent.js";
import { englishHash } from "../src/modules/english/corpus.js";
import { summarizeEnglishJobs, type EnglishEvaluationJob } from "../src/modules/evaluation/english-runner.js";
const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Provide an existing English experiment directory");
const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
if (manifest.subject !== "english" || !Array.isArray(manifest.variants)) throw new Error("Not an English experiment");
const files = (await readdir(join(directory, "jobs"))).filter(f => f.endsWith(".json"));
if (files.length !== manifest.jobCount) throw new Error("Experiment is incomplete; finish it before rescoring");
const jobs: EnglishEvaluationJob[] = [];
let changed = 0;
for (const file of files) {
    const job = JSON.parse(await readFile(join(directory, "jobs", file), "utf8"));
    for (const q of job.answers) {
        let actual: string | null = null;
        try { actual = englishChoice(job.answer, q.number) ?? null; } catch { /* Missing visible answer stays incorrect. */ }
        const passed = !job.error && actual === q.expected;
        if (passed !== q.passed) changed++;
        q.actual = actual; q.passed = passed;
    }
    jobs.push(job);
}
const rows = summarizeEnglishJobs(jobs, manifest.variants);
const report = { manifest: { ...manifest, rescoredAt: new Date().toISOString(), gradingSourceHash: englishHash(await readFile("src/modules/english/agent.ts", "utf8")),
    gradingChange: "Accept explicit unique answer labels after sentence boundaries and markdown; original outputs and references unchanged.", changed }, rows };
await writeFile(join(directory, "comparison-format-v2.json"), JSON.stringify(report, null, 2), { flag: "wx" });
await writeFile(join(directory, "comparison-format-v2.md"), `# 英语原始回答重新判分\n\n仅修正明确结论的换行/加粗识别；原始回答和参考答案保留。受影响题数：${changed}。\n\n|策略|正确/总题数|阅读|语法|完形|留出test|失败请求|\n|---|---:|---:|---:|---:|---:|---:|\n` + rows.map(r =>
    `|${r.variant}|${r.accuracy?.successes}/${r.accuracy?.total}|${r.byKind.reading?.successes}/${r.byKind.reading?.total}|${r.byKind.grammar?.successes}/${r.byKind.grammar?.total}|${r.byKind.cloze?.successes}/${r.byKind.cloze?.total}|${r.bySplit.test?.successes}/${r.bySplit.test?.total}|${r.failures}|`).join("\n"), { flag: "wx" });
console.log(JSON.stringify({ changed, rows }));
