import {mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {loadCorpus} from "../src/modules/math/corpus.js";
import {retrievalScores} from "../src/modules/evaluation/math-optimization.js";
const roots=process.argv.slice(2);if(!roots.length)throw new Error("Provide study directory paths");
const corpus=await loadCorpus("evals/math/corpus.json"),questions=new Map(corpus.test.map(q=>[q.id,q])),rows:any[]=[],details:any[]=[];
for(const rootArg of roots){const root=resolve(rootArg),report=JSON.parse(await readFile(join(root,"comparison.json"),"utf8"));
    for(const row of report.rows){const folder=root.endsWith("final-v4")?join(root,row.variant,"trials"):join(root,"trials");const trials=await Promise.all((await readdir(folder)).filter(f=>f.endsWith(".json")).map(async f=>JSON.parse(await readFile(join(folder,f),"utf8"))));
        const samples=trials.flatMap(t=>{const q=questions.get(t.caseId);if(!q)return [];const gold=corpus.knowledge.filter(k=>k.family===q.family).map(k=>k.id),r=t.events.find((e:any)=>e.name==="math.retrieval");if(!r)return [{id:q.id,recallAt3:0,recallAt10:0,hitAt3:0,precisionAt3:0,mrrAt10:0}];
            const ids=r.fields.candidateIds??r.fields.ids,a=retrievalScores(ids,gold,3),b=r.fields.candidateIds?retrievalScores(ids,gold,10):undefined;return [{id:q.id,goldCount:gold.length,ids,recallAt3:a.recall,recallAt10:b?.recall??null,hitAt3:Number(ids.slice(0,3).some((id:string)=>gold.includes(id))),precisionAt3:ids.slice(0,3).filter((id:string)=>gold.includes(id)).length/3,mrrAt10:b?.mrr??null,ndcgAt10:b?.ndcg??null}];});
        const mean=(key:string)=>{const values=samples.map(t=>(t as any)[key]).filter((v:any)=>typeof v==="number");return values.length?values.reduce((a:number,b:number)=>a+b,0)/values.length:null;};rows.push({study:rootArg,variant:row.variant,n:samples.length,top10Observed:samples.filter(t=>t.recallAt10!==null).length,recallAt3:mean("recallAt3"),recallAt10:mean("recallAt10"),hitAt3:mean("hitAt3"),precisionAt3:mean("precisionAt3"),mrrAt10:mean("mrrAt10"),ndcgAt10:mean("ndcgAt10")});details.push({study:rootArg,variant:row.variant,samples});
    }
}
const out="data/evaluations/glm46v-rag-heldout-final";await mkdir(out,{recursive:true});await writeFile(join(out,"rag-heldout.json"),JSON.stringify({scope:"Offline audit of actual retrieval events for 77 held-out-parameter regression questions. Relevant set is all KB items in the authored template family. This is a same-method annotation proxy, not independent human semantic grading. Recall@3/10 denominator is whole relevant set, so maximum depends on goldCount. No additional model or embedding requests.",rows,details},null,2));console.log(JSON.stringify(rows));
