import {mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {rate,percentile} from "../src/modules/evaluation/statistics.js";
const paths=["data/evaluations/glm46v-adaptive-final-v5","data/evaluations/glm46v-adaptive-final-v6"],reports=await Promise.all(paths.map(async p=>JSON.parse(await readFile(join(p,"comparison.json"),"utf8"))));
if(new Set(reports.map(r=>r.manifest.caseHash+":"+r.manifest.corpusHash+":"+r.manifest.model)).size!==1)throw new Error("Validation rounds have incompatible cases/data/model");
const trials=(await Promise.all(paths.map(async p=>Promise.all((await readdir(join(p,"trials"))).filter(f=>f.endsWith(".json")).map(async f=>JSON.parse(await readFile(join(p,"trials",f),"utf8"))))))).flat();
const out="data/evaluations/glm46v-final-validation";await mkdir(out,{recursive:true});const report={scope:"Same 100 fixed regression cases, repeated in two final validation rounds. 200 total trials; all retained. The launchers differ (tsx CLI versus node --import tsx), so heap peaks remain separated. No unseen-generalization or production-SLA claim.",rounds:reports.map((r,i)=>({path:paths[i],row:r.rows[0],manifest:r.manifest})),
    pooled:{accuracy:rate(trials.filter(t=>t.passed).length,trials.length),p50Ms:percentile(trials.map(t=>t.durationMs),.5),p95Ms:percentile(trials.map(t=>t.durationMs),.95),p99Ms:percentile(trials.map(t=>t.durationMs),.99),maxMs:Math.max(...trials.map(t=>t.durationMs)),nativeTrials:trials.filter(t=>t.native).length,uniqueCases:new Set(trials.map(t=>t.caseId)).size}};
await writeFile(join(out,"validation.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report.pooled));
