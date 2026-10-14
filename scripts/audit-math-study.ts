import {readFile,readdir,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {percentile} from "../src/modules/evaluation/statistics.js";
import {loadCorpus} from "../src/modules/math/corpus.js";
const root=resolve(process.argv[2]??"data/evaluations/glm46v-final-v3"),report=JSON.parse(await readFile(join(root,"comparison.json"),"utf8"));
const audits:any[]=[];
for(const row of report.rows){const folder=join(root,row.variant,"trials"),trials=await Promise.all((await readdir(folder)).filter(f=>f.endsWith(".json")).map(async f=>JSON.parse(await readFile(join(folder,f),"utf8"))));
    if(trials.length!==row.total||trials.filter(t=>t.passed).length!==row.accuracy.successes)throw new Error(`Count mismatch: ${row.variant}`);
    const wall=trials.map(t=>{const batch=t.events.find((e:any)=>e.name==="math.batch");return batch?Number(batch.fields.durationMs):t.events.filter((e:any)=>e.name==="math.retrieval").reduce((s:number,e:any)=>s+Number(e.fields.durationMs),0);});
    const retrievals=trials.flatMap(t=>t.events.filter((e:any)=>e.name==="math.retrieval")),fields=["bm25Ms","embeddingMs","rerankMs"];
    const stages=Object.fromEntries(fields.map(key=>{const values=retrievals.map((e:any)=>e.fields.stages?.[key]).filter((v:any)=>typeof v==="number");return [key,{n:values.length,p95Ms:values.length?percentile(values,.95):null,p99Ms:values.length?percentile(values,.99):null}];}));
    audits.push({variant:row.variant,trialCount:trials.length,p95Reproduced:percentile(trials.map(t=>t.durationMs),.95)===row.p95Ms,p99Reproduced:percentile(trials.map(t=>t.durationMs),.99)===row.p99Ms,
        retrievalWallP95Ms:percentile(wall,.95),retrievalWallP99Ms:percentile(wall,.99),stages,
        note:"Batch wall time includes the batched embedding request. Individual search stage timers start after this request and measure scoring only; do not substitute their sum for batch wall time."});
}
const corpus=await loadCorpus("evals/math/corpus.json");
await writeFile(join(root,"audit.json"),JSON.stringify({knowledge:corpus.knowledge.length,longHard:corpus.knowledge.filter(q=>q.difficulty==="long-hard").length,allManifestHashesEqual:new Set(report.manifests.map((m:any)=>m.sourceHash+":"+m.caseHash+":"+m.corpusHash+":"+m.model)).size===1,audits},null,2));
console.log(JSON.stringify(audits));
