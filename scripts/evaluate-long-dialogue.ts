import {mkdir,readFile,stat,writeFile} from "node:fs/promises";
import {resolve,join} from "node:path";
import {loadConfig} from "../src/config/env.js";
import {loadCorpus} from "../src/modules/math/corpus.js";
import {GlmEmbeddings,GlmModel} from "../src/infrastructure/llm/glm-model.js";
import {mathEmbeddingConfig} from "../src/bootstrap/math-chat-agent.js";
import {MathRag} from "../src/modules/math/rag.js";
import {createMathProfile} from "../src/modules/math/profile.js";
import {MATH_EXPERIMENTS,type MathVariant} from "../src/modules/math/contracts.js";
import {answerVector} from "../src/modules/evaluation/math-optimization.js";
import {percentile,rate} from "../src/modules/evaluation/statistics.js";
import type {AgentMessage} from "../src/modules/agent/contracts.js";
const out=resolve(process.argv[2]??`data/evaluations/long-dialogue-${Date.now()}`);
const variants=process.argv[3]?.split(",") as MathVariant[]|undefined;
if(variants?.some(v=>!MATH_EXPERIMENTS.includes(v)))throw new Error("Invalid long-dialogue variant");
try{await stat(out);throw new Error("Output already exists");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
const config=loadConfig({...process.env,LLM_MODEL:"glm-4.6v",LLM_BASE_URL:process.env.LLM_BASE_URL??"https://open.bigmodel.cn/api/paas/v4",LLM_MAX_INPUT_TOKENS:"8192"});
const corpus=await loadCorpus(config.math.corpusPath),rag=await MathRag.open(corpus.knowledge,config.math.indexPath,new GlmEmbeddings(mathEmbeddingConfig(config)));
await mkdir(out,{recursive:true});const rows:any[]=[],trials:any[]=[];
for(const variant of variants??MATH_EXPERIMENTS){const group:any[]=[];
    for(let i=0;i<8;i++){
        const a=i+2,b=i+6,x=i+13,y=i+18,history:AgentMessage[]=[{role:"user",content:`第1题：解x²-${a+b}x+${a*b}=0。`},{role:"assistant",content:`旧答案为${a}和${b}。`}];
        for(let j=0;j<48;j++){
            if(j===12)history.push({role:"user",content:`第1题条件更正：旧方程作废。现在为x²-${x+y}x+${x*y}=0，请以后使用这个新方程。`});
            history.push({role:"user",content:`第${j+2}题是无关的统计练习记录，数组为${j+1},${j+2},${j+3}。`+"下面讨论其他题的解法与思路，不能把本题条件搬到第1题。".repeat(10)},{role:"assistant",content:"本题是独立练习，应分别检查数据、单位和定义域。"});
        }
        history.push({role:"assistant",content:`第1题总结：答案还是${a}和${b}。`});
        const question=`请解之前第1题，注意用户在中途更新过条件，助手最后的总结可能错误。\nA. ${a}和${b}\nB. ${x}和${y}\nC. ${-x}和${-y}\nD. ${x+1}和${y+1}`;
        const events:any[]=[],start=performance.now(),p=createMathProfile(variant,rag.fork(),new GlmModel(config,"disabled"),config.context,{info(){},error(){}},{...config.harness,toolOutputTokens:6000,recovery:{...config.harness.recovery,modelAttemptTimeoutMs:60000,modelRetries:1}});
        let answer="",error:string|undefined;
        try{answer=(await p.harness.run({question,history,tools:[rag.tool(p.mode)],metadata:{variant,caseId:`middle-correction-${i}`},onEvent(name,fields){events.push({name,elapsedMs:performance.now()-start,fields});}},AbortSignal.timeout(120000))).content;}catch(e){error=e instanceof Error?e.message:"unknown";}
        const t={variant,id:`middle-correction-${i}`,passed:!error&&answerVector(answer,1)[0]==="B",answer,error,durationMs:performance.now()-start,historyCharacters:history.reduce((s,m)=>s+m.content.length,0),inputTokens:events.filter(e=>e.name==="agent.model.completed").reduce((s,e)=>s+(e.fields.usage?.inputTokens??0),0),compressions:events.filter(e=>e.name==="context.compressed").length,events};
        group.push(t);trials.push(t);await writeFile(join(out,`${variant}-${i}.json`),JSON.stringify(t,null,2));console.log(`${variant} ${i+1}/8 ${t.passed?"PASS":"FAIL"} ${(t.durationMs/1000).toFixed(1)}s`);
    }
    rows.push({variant,accuracy:rate(group.filter(t=>t.passed).length,group.length),p95Ms:percentile(group.map(t=>t.durationMs),.95),p99Ms:percentile(group.map(t=>t.durationMs),.99),avgInputTokens:group.reduce((s,t)=>s+t.inputTokens,0)/group.length,compressions:group.reduce((s,t)=>s+t.compressions,0)});
}
await writeFile(join(out,"comparison.json"),JSON.stringify({scope:"48 synthetic long-dialogue trials. User correction in the middle, misleading stale assistant recap at the end, 8192-token context budget. p99 on eight samples is descriptive maximum. Same source runtime as main study; no real user conversation data sent.",rows},null,2));console.log(JSON.stringify(rows));
