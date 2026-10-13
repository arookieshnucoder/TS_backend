import { readFile, writeFile, mkdir } from "node:fs/promises";
import { hash, validateCorpus } from "../src/modules/math/corpus.js";
import type { MathQuestion, MathCorpus } from "../src/modules/math/contracts.js";
const path = "data/math/sources/mathbench/mathbench_v1/middle/single_choice_cn.jsonl";
const raw = await readFile(path, "utf8");
const rows = raw.trim().split(/\r?\n/).map(line => JSON.parse(line));
const excluded = [{ row: 3, reason: "对称轴名称丢失" }, { row: 26, reason: "扩大倍数丢失" }, { row: 27, reason: "参数a的非零条件丢失，选项歧义" },
    { row: 56, reason: "求值参数名称丢失" }, { row: 62, reason: "题干6323.6与选项6303.6不一致" }, { row: 96, reason: "对称轴名称丢失" }];
const development = new Set([2, 19, 33, 46, 51, 59, 80, 97, 105, 114, 139, 143]);
const test = new Set([6, 18, 23, 28, 31, 32, 37, 41, 49, 53, 55, 60, 61, 68, 74, 75, 78, 79, 84, 87, 88, 91, 93, 100, 108, 113, 127, 134, 142, 149]);
const sourceUrl = "https://github.com/open-compass/MathBench/files/15384594/mathbench_v1.zip";
const corpus: MathCorpus = { version: 1, id: "mathbench-cn-middle-text-v1", knowledge: [], development: [], test: [], excluded };
rows.forEach((q, i) => {
    const row = i + 1; if (excluded.some(e => e.row === row)) return;
    const item: MathQuestion = { id: `mb-cn-middle-${String(row).padStart(3, "0")}`, question: q.question, options: q.options, answer: q.answer, topic: q.topic,
        source: { url: sourceUrl, dataset: "MathBench v0.1.0 / middle/single_choice_cn.jsonl", row, sha256: hash(raw) } };
    if (row === 61) {
        item.textAudit = { originalQuestion: item.question, evidenceUrl: "https://www.gcyls.cn/file/upload/202405/31/170932371.pdf", page: 15,
            reason: "原题图中A在y轴、B在x轴；纯文字发行版缺少这项点名条件。核对原图后补为文字条件，参考选项保持不变。" };
        item.question = item.question.replace("和x、y轴交于A、B两点", "和x、y轴交于A、B两点（图示A在y轴，即A(0,2)；B在x轴，即B(4,0)）");
    }
    if (test.has(row)) corpus.test.push(item); else if (development.has(row)) corpus.development.push(item); else if (corpus.knowledge.length < 100) corpus.knowledge.push(item);
});
validateCorpus(corpus);
await mkdir("evals/math", { recursive: true });
await writeFile("evals/math/corpus.json", JSON.stringify(corpus, null, 2));
console.log(`knowledge=${corpus.knowledge.length}, development=${corpus.development.length}, test=${corpus.test.length}, excluded=${excluded.length}`);
