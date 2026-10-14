import {spawn} from "node:child_process";
import {mkdir,readFile,stat,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {MATH_EXPERIMENTS} from "../src/modules/math/contracts.js";
const args=process.argv.slice(2),opts=new Map<string,string>();
for(let i=0;i<args.length;i+=2){const k=args[i]?.replace(/^--/,""),v=args[i+1];if(!k||!v||!["out","suite","concurrency","cache","repeats"].includes(k)||opts.has(k))throw new Error("Invalid study options");opts.set(k,v);}
const out=resolve(opts.get("out")??`data/evaluations/study-${Date.now()}`);
try{await stat(out);throw new Error("Output already exists");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
await mkdir(out,{recursive:true});
const rows:any[]=[];const manifests:any[]=[];
for(const variant of MATH_EXPERIMENTS){const childOut=join(out,variant);
    await new Promise<void>((ok,fail)=>{const child=spawn(process.execPath,["--import","tsx","scripts/evaluate-math-optimization.ts","--suite",opts.get("suite")??"test","--out",childOut,"--variants",variant,"--concurrency",opts.get("concurrency")??"3","--repeats",opts.get("repeats")??"1","--cache",opts.get("cache")??"cold"],{stdio:"inherit",env:process.env});child.on("error",fail);child.on("exit",code=>code===0?ok():fail(new Error(`${variant} exited ${code}`)));});
    const result=JSON.parse(await readFile(join(childOut,"comparison.json"),"utf8"));rows.push(...result.rows);manifests.push(result.manifest);
}
if(new Set(manifests.map(m=>m.caseHash+":"+m.sourceHash+":"+m.corpusHash+":"+m.model)).size!==1)throw new Error("Study implementations or cases changed during execution; comparisons invalid");
const report={scope:"Six isolated Node processes, one per variant, identical frozen code, data, provider, model and case order. Includes 100 test cases per variant: 77 held-out parameter questions and 23 synthetic stress cases. Process peaks include Node runtime and tokenizer. Training families overlap held-out parameters; no unseen-template generalization claim.",rows,manifests};
await writeFile(join(out,"comparison.json"),JSON.stringify(report,null,2));
const md=`# GLM-4.6V 最终对比\n\n${report.scope}\n\n|版本|正确/总数|准确率|p95秒|p99秒|首工具p95毫秒|平均输入token|峰值heap MiB|峰值RSS MiB|\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows.map(r=>`|${r.variant}|${r.accuracy.successes}/${r.total}|${(100*r.accuracy.value).toFixed(1)}%|${(r.p95Ms/1000).toFixed(2)}|${(r.p99Ms/1000).toFixed(2)}|${r.firstToolP95Ms?.toFixed(1)??"N/A"}|${r.avgInputTokens.toFixed(0)}|${r.peakHeapMiB.toFixed(1)}|${r.peakRssMiB.toFixed(1)}|`).join("\n")}\n\n每个版本的分组准确率、Wilson区间、失败ID与逐题轨迹见对应目录。p99是有限样本描述性指标；最终答案正确不代表所有推导正确。\n`;
await writeFile(join(out,"comparison.md"),md);
await writeFile(join(out,"comparison.html"),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>GLM-4.6V 最终对比</title><style>body{font:16px/1.7 system-ui;max-width:1200px;margin:30px auto;padding:20px}table{border-collapse:collapse;width:100%}td,th{padding:12px;border-bottom:1px solid #ddd;text-align:left}a{color:#2466bb}</style><h1>GLM-4.6V 初三数学优化</h1><p>500题，50道长难题；独立进程比较现有架构和五个变体。</p><table><tr><th>版本</th><th>准确率</th><th>p95秒</th><th>p99秒</th><th>峰值heap MiB</th></tr>${rows.map(r=>`<tr><td><a href="${r.variant}/comparison.html">${r.variant}</a></td><td>${(100*r.accuracy.value).toFixed(1)}%</td><td>${(r.p95Ms/1000).toFixed(2)}</td><td>${(r.p99Ms/1000).toFixed(2)}</td><td>${r.peakHeapMiB.toFixed(1)}</td></tr>`).join("")}</table><p>${report.scope}</p><p><a href="comparison.json">完整JSON</a> · <a href="comparison.md">Markdown</a></p></html>`);
console.log(JSON.stringify(rows));
