import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { loadConfig } from "../../config/env.js";
import { GlmEmbeddings, GlmModel } from "../../infrastructure/llm/glm-model.js";
import { mathEmbeddingConfig } from "../../bootstrap/math-chat-agent.js";
import type { AgentMessage } from "../agent/contracts.js";
import type { AgentModel } from "../agent/model.js";
import { MATH_EXPERIMENTS, renderQuestion, type MathCorpus, type MathVariant, type MathQuestion } from "../math/contracts.js";
import { loadCorpus, hash } from "../math/corpus.js";
import { MathRag, type RetrievalMode } from "../math/rag.js";
import { createMathProfile } from "../math/profile.js";
import { splitMathTasks } from "../math/task-tools.js";
import { conclusions } from "./math-conclusion.js";
import { extractMathAnswer, permuteQuestion } from "./math-runner.js";
import { percentile, rate } from "./statistics.js";
import { redact, environmentSecrets } from "../../common/logging/redaction.js";
import { sourceHash } from "./runner.js";

/** 数学优化实验的一个场景，包含历史、期望结论及条件缺失标记。 */
export interface OptimizationCase {id:string;category:string;question:string;history:AgentMessage[];expected:string[];missing?:boolean;}
export function stressCases(c:MathCorpus):OptimizationCase[] {
    const cases:OptimizationCase[]=[];
    for(let i=0;i<10;i++) {
        const a=i+2,b=i+6,na=i+12,nb=i+17;
        const history:AgentMessage[]=[{role:"user",content:`第1题：解方程x²-${a+b}x+${a*b}=0。`},{role:"assistant",content:`根是${-a}和${-b}。` }];
        for(let j=0;j<32;j++)history.push({role:"user",content:`第${j+2}题讨论记录：这是已经结束的面积练习。边长${j+1}，面积${(j+1)**2}。请记住它是另一题。`+"讨论方法和单位，核对条件后再计算。".repeat(8)},{role:"assistant",content:"这道题已经结束，不能将本题数字替代其他题的条件。"});
        history.push({role:"user",content:`第1题条件更正：原来的系数作废，新方程是x²-${na+nb}x+${na*nb}=0。两根都取正数。`});
        cases.push({id:`history-correction-${i}`,category:"long-dialogue",history,question:`请重新求之前第1题的根，使用最新更正的条件，不能沿用助手旧答案。\nA. ${a}和${b}\nB. ${na}和${nb}\nC. ${-na}和${-nb}\nD. ${na+1}和${nb+1}`,expected:["B"]});
    }
    for(let i=0;i<6;i++) {
        const qs=[c.test[i*2]!,c.test[i*2+1]!];
        cases.push({id:`multiple-${i}`,category:"multiple-questions",history:[],question:qs.map((q,j)=>`第${j+1}题：${renderQuestion(q)}`).join("\n")+"\n请分别解答两道题，每题最后输出‘第n题答案：X’。",expected:qs.map(q=>q.answer)});
    }
    for(let i=0;i<4;i++) {
        const q=c.test.filter(q=>q.difficulty==="long-hard")[i]!;
        cases.push({id:`long-input-${i}`,category:"long-input",history:[],question:`以下是学校研究记录，前文只是背景，不提供额外数学条件。${"同学们需要在纸上注明已知条件，单位、变量和最终结论。老师将逐项核查每个子问。".repeat(35)}\n实际题目：${renderQuestion(q)}\n请完成所有子问，答案以实际题目为准。`,expected:[q.answer]});
    }
    for(let i=0;i<3;i++)cases.push({id:`missing-history-${i}`,category:"missing-context",history:[{role:"user",content:"我昨天做了一道几何题，没有提供题干或图片。"}],question:"请计算之前那道几何题的面积。现在没有图和长度条件。",expected:[],missing:true});
    return cases;
}
export function answerVector(text:string,count:number): (string|null)[] {
    return conclusions(text,count);
}
export function retrievalScores(ids:string[],relevant:string[],k:number) {
    if(!relevant.length)return {recall:null,mrr:null,ndcg:null};
    const gold=new Set(relevant),list=[...new Set(ids)].slice(0,k),hits=list.filter(id=>gold.has(id));
    const rank=list.findIndex(id=>gold.has(id));
    const dcg=list.reduce((s,id,i)=>s+(gold.has(id)?1/Math.log2(i+2):0),0);
    const ideal=Array.from({length:Math.min(k,gold.size)},(_,i)=>1/Math.log2(i+2)).reduce((a,b)=>a+b,0);
    return {recall:hits.length/gold.size,mrr:rank<0?0:1/(rank+1),ndcg:dcg/ideal};
}
/** 数学优化实验配置，控制策略对比、重复次数、缓存与检索资源。 */
export interface OptimizationOptions {out:string;suite:"development"|"test"|"stress";variants:MathVariant[];repeats:number;concurrency:number;timeoutMs:number;limit?:number;ragOnly?:boolean;cache?:"cold"|"warm";corpusPath?:string;indexPath?:string;modelFactory?:()=>AgentModel;rag?:MathRag;progress?:(text:string)=>void;}
const pct=(values:number[],p:number)=>values.length?percentile(values,p):null;
const avg=(values:number[])=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
export async function evaluateOptimization(o:OptimizationOptions) {
    if(!["development","test","stress"].includes(o.suite)||!o.variants.length||new Set(o.variants).size!==o.variants.length||o.variants.some(v=>!MATH_EXPERIMENTS.includes(v))||!Number.isInteger(o.repeats)||o.repeats<1||o.repeats>10||!Number.isInteger(o.concurrency)||o.concurrency<1||o.concurrency>4||!Number.isInteger(o.timeoutMs)||o.timeoutMs<100||o.timeoutMs>600000||o.cache!==undefined&&!["cold","warm"].includes(o.cache)||o.limit!==undefined&&(!Number.isInteger(o.limit)||o.limit<1))throw new Error("Invalid optimization options");
    if(!process.env.LLM_API_KEY&&!o.modelFactory)throw new Error("Live optimization requires LLM_API_KEY; no simulated fallback");
    const out=resolve(o.out);try{await stat(out);throw new Error("Output already exists");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    const config=loadConfig({...process.env,LLM_MODEL:process.env.LLM_MODEL??"glm-4.6v",LLM_BASE_URL:process.env.LLM_BASE_URL??"https://open.bigmodel.cn/api/paas/v4"});
    const corpus=await loadCorpus(o.corpusPath??config.math.corpusPath);
    const rag=o.rag??await MathRag.open(corpus.knowledge,o.indexPath??config.math.indexPath,new GlmEmbeddings(mathEmbeddingConfig(config)));
    if(hash(JSON.stringify(rag.questions))!==hash(JSON.stringify(corpus.knowledge)))throw new Error("RAG corpus mismatch");
    const cases:OptimizationCase[]=(o.suite==="stress"?stressCases(corpus):[...corpus[o.suite].map(q=>({id:q.id,category:q.difficulty??"standard",question:renderQuestion(q),history:[],expected:[q.answer]})),...stressCases(corpus)]).slice(0,o.limit);
    await mkdir(out,{recursive:true});await mkdir(join(out,"trials"));
    const manifest={version:2,startedAt:new Date().toISOString(),model:config.llmModel,thinking:config.math.thinking,temperature:0,outputBudget:config.math.thinking==="enabled"?"8192":"2048; long or multiple inputs 4096",...o,modelFactory:undefined,rag:undefined,progress:undefined,
        corpusHash:hash(JSON.stringify(corpus)),sourceHash:await sourceHash(resolve("src")),caseHash:hash(JSON.stringify(cases)),knowledge:corpus.knowledge.length,
        limitations:["Original locally authored parameterized practice set; held-out parameters share template families.","Exact final answer grading does not certify proof quality.","p99 is nearest-rank descriptive; <100 samples is effectively the maximum and statistically unstable.","Memory sampled with sequential variants in one process; Node allocator/RSS is shared across trials and variants, so absolute peaks are descriptive only."]};
    await writeFile(join(out,"manifest.json"),JSON.stringify(manifest,null,2));
    const secrets=environmentSecrets();
    const rows:Record<string,unknown>[]=[];
    // Sequential variants make memory measurements interpretable; case order identical for each.
    for(const variant of o.variants){
        const local=rag.fork(),results:any[]=[],memoryStart=process.memoryUsage();let peakRss=memoryStart.rss,peakHeap=memoryStart.heapUsed;
        const sample=()=>{const m=process.memoryUsage();peakRss=Math.max(peakRss,m.rss);peakHeap=Math.max(peakHeap,m.heapUsed);};const sampler=setInterval(sample,25);
        try{
            let cursor=0;
            const jobs=Array.from({length:o.repeats},(_,r)=>cases.map(c=>({...c,repeat:r+1}))).flat();
            await Promise.all(Array.from({length:o.concurrency},async()=>{while(cursor<jobs.length){const c=jobs[cursor++]!,events:any[]=[];let start=performance.now();
                const scope=AbortSignal.timeout(o.timeoutMs);let answer="",error:string|undefined;
                const event=(name:string,fields:Record<string,unknown>={})=>events.push({name,elapsedMs:performance.now()-start,fields});
                const trialRag=o.cache==="cold"?local.fork():local;
                try{
                    if(o.cache==="warm"){
                        const queries=["batch","adaptive"].includes(variant)?splitMathTasks(c.question):[c.question];
                        await trialRag.searchBatch(queries,variant==="combined"?"hybrid":variant==="lexical"?"lexical":"rerank",scope);
                        start=performance.now(); // Cache priming is recorded by manifest and excluded from warm latency.
                    }
                    const profile=createMathProfile(variant,trialRag,o.modelFactory?.()??new GlmModel(config,config.math.thinking),config.context,{info(){},error(){}},{...config.harness,toolOutputTokens:8000,recovery:{...config.harness.recovery,modelAttemptTimeoutMs:Math.min(60000,o.timeoutMs),modelRetries:1}});
                    const result=await profile.harness.run({history:c.history,question:c.question,tools:[trialRag.tool(profile.mode,event)],metadata:{caseId:c.id,variant},onEvent:event},scope);answer=result.content;
                }catch(e){error=scope.aborted?"timeout":e instanceof Error?e.message:"unknown";}
                const vector=answerVector(answer,c.expected.length),passed=!error&&(c.missing?/缺少|不足|无法确定|无法计算|没有.*条件|提供.*(?:题|图|长度)/.test(answer)&&!/(?:面积|答案)[：:]?\s*\d+/.test(answer):vector.every((a,i)=>a===c.expected[i]));
                const retrievals=events.filter(e=>e.name==="math.retrieval"),modelEvents=events.filter(e=>e.name==="agent.model.completed"),toolStart=events.find(e=>e.name==="agent.tool.started"||e.name==="math.retrieval.started");
                const native=events.some(e=>e.name==="math.native_verified");
                const trial={caseId:c.id,category:c.category,variant,repeat:c.repeat,answer,error,passed,expected:c.expected,extracted:vector,durationMs:performance.now()-start,native,
                    firstToolMs:toolStart?.elapsedMs??null,modelCalls:modelEvents.length,inputTokens:modelEvents.reduce((s,e)=>s+(e.fields.usage?.inputTokens??0),0),outputTokens:modelEvents.reduce((s,e)=>s+(e.fields.usage?.outputTokens??0),0),
                    retrievalMs:events.find(e=>e.name==="math.batch")?.fields.durationMs??retrievals.reduce((s,e)=>s+Number(e.fields.durationMs),0),events};
                results.push(trial);sample();await writeFile(join(out,"trials",`${variant}-${c.id}-${c.repeat}.json`),JSON.stringify(redact(trial,secrets,{maxStringLength:20000,maxCharacters:200000}),null,2));
                o.progress?.(`${variant} ${results.length}/${jobs.length} ${c.id} ${passed?"PASS":"FAIL"} ${(trial.durationMs/1000).toFixed(1)}s${error?" "+error:""}`);
            }}));
            const subgroup=Object.fromEntries([...new Set(results.map(t=>t.category))].map(category=>{const ts=results.filter(t=>t.category===category);return [category,rate(ts.filter(t=>t.passed).length,ts.length)];}));
            const row={variant,total:results.length,accuracy:rate(results.filter(t=>t.passed).length,results.length),subgroups:subgroup,p50Ms:pct(results.map(t=>t.durationMs),.5),p95Ms:pct(results.map(t=>t.durationMs),.95),p99Ms:pct(results.map(t=>t.durationMs),.99),
                firstToolP95Ms:pct(results.map(t=>t.firstToolMs).filter((x):x is number=>x!==null),.95),retrievalP95Ms:pct(results.map(t=>t.retrievalMs),.95),avgModelCalls:avg(results.map(t=>t.modelCalls)),avgInputTokens:avg(results.map(t=>t.inputTokens)),
                peakRssMiB:peakRss/1048576,peakHeapMiB:peakHeap/1048576,rssIncreaseMiB:(peakRss-memoryStart.rss)/1048576,cache:local.cacheStats(),failures:results.filter(t=>!t.passed).map(t=>t.caseId)};
            Object.assign(row,{nativeTrials:results.filter(t=>t.native).length,maxMs:Math.max(...results.map(t=>t.durationMs)),usageMissingTrials:results.filter(t=>!t.native&&!t.events.some((e:any)=>e.name==="agent.model.completed"&&e.fields.usage)).length});
            rows.push(row);await writeFile(join(out,`${variant}.json`),JSON.stringify(row,null,2));
        }finally{clearInterval(sampler);}
    }
    const report={manifest,rows};await writeFile(join(out,"comparison.json"),JSON.stringify(report,null,2));
    const md=`# ${config.llmModel} 初三数学实验\n\n500题知识库，含50道长难题。每变体相同题序和模型配置，失败与超时计入分母。\n\n| 变体 | 正确率 | n | p95秒 | p99秒 | 首工具p95毫秒 | 平均输入token | 峰值heap MiB |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${rows.map((r:any)=>`| ${r.variant} | ${(r.accuracy.value*100).toFixed(1)}% | ${r.total} | ${(r.p95Ms/1000).toFixed(2)} | ${(r.p99Ms/1000).toFixed(2)} | ${r.firstToolP95Ms?.toFixed(1)??"N/A"} | ${r.avgInputTokens.toFixed(0)} | ${r.peakHeapMiB.toFixed(1)} |`).join("\n")}\n\n${manifest.limitations.join("\n\n")}\n\n逐题答案、失败与轨迹在trials目录；RAG召回使用独立rag报告，不以知识点命中冒充相关题召回。\n`;
    await writeFile(join(out,"comparison.md"),md);
    const escape=(s:string)=>s.replace(/[&<>]/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[ch]!));
    await writeFile(join(out,"comparison.html"),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escape(config.llmModel)} 优化对比</title><style>body{font:15px/1.7 system-ui;max-width:1300px;margin:32px auto;padding:20px}pre{white-space:pre-wrap}a{color:#2466bb}</style><h1>${escape(config.llmModel)} 初三数学优化对比</h1><pre>${escape(md)}</pre><a href="comparison.json">完整指标JSON</a></html>`);
    return report;
}

export async function evaluateRag(rag:MathRag,out:string,limit=100) {
    await mkdir(out,{recursive:true});
    // Grader-only exact item IDs. Query includes no ID, answer, solution or topic annotation.
    // These are paraphrase/format robustness diagnostics, not unseen problem-solving accuracy.
    const exactQueries=rag.questions.filter((_,i)=>i%Math.max(1,Math.floor(rag.questions.length/limit))===0).slice(0,limit).map((q,i)=>({id:`retrieval-${i}`,category:"same-item",query:`请查找这道题对应的参考解法：${q.question.replace(/（ ）/g,"？").replace(/求/g,"请计算")}`,relevant:[q.id]}));
    const intents:Record<string,string>={roots:"一元二次方程因式分解后求两个实数根",discriminant:"计算一个具体二次方程的判别式",parameter:"方程含有常数参数，两个实根相等时确定参数",vieta:"已知二次方程的两根，求两根的平方和",vertex:"二次函数顶点式，读取顶点坐标",minimum:"配方求二次函数在实数上的最小值",symmetry:"给定抛物线上一点，求关于对称轴对称的点",intersection:"求抛物线和横坐标轴两交点之间的距离",growth:"两年连续按相同百分比增长的人数",rectangle:"矩形的面积已知，长比宽多一个数，求宽",chord:"圆的半径和圆心到弦的距离已知，求弦长",tangent:"圆外点到圆心的距离与半径已知，求切线段长度",sector:"已知圆心角与半径计算扇形面积",inscribed:"由同一段小弧的圆心角求对应圆周角",similarSide:"两个相似三角形，根据对应边比例求另一条边",similarArea:"相似三角形边长比已知，用平方比例求面积",trig:"已知直角三角形两直角边，求锐角的正弦值",probability:"从红白球袋中连续不放回抽两个球，都抽红球的概率",bridge:"抛物线形桥下的水平车顶净空，左右角的区间求交",profit:"售价影响销量，扣除进货成本后的日利润最大化",moving:"直角三角形两点匀速同时运动，求面积最大的时刻",circleSimilarity:"圆外切线构成直角三角形，再用相似面积比计算放大模型",conditional:"已知第一个人抽到白球，不放回时第二个人抽到红球的条件概率"};
    const methodQueries=Object.entries(intents).filter(([family])=>rag.questions.some(q=>q.family===family)).map(([family,query])=>({id:`method-${family}`,category:"method-relevance",query:`请找一道讲解以下方法的例题：${query}`,relevant:rag.questions.filter(q=>q.family===family).map(q=>q.id)}));
    const queries=[...exactQueries,...methodQueries];
    const rows:any[]=[],details:any[]=[];
    for(const mode of ["dense","hybrid","lexical","rerank"] as RetrievalMode[]){const local=rag.fork(),trials:any[]=[];
        for(const q of queries){const r=await local.search(q.query,mode,AbortSignal.timeout(30000));const ids=r.candidateIds??r.hits.map(h=>h.question.id),a=retrievalScores(ids,q.relevant,3),b=retrievalScores(ids,q.relevant,10);
            trials.push({id:q.id,category:q.category,relevant:q.relevant,ids,recallAt3:a.recall,recallAt10:b.recall,mrrAt10:b.mrr,ndcgAt10:b.ndcg,hitAt3:Number(ids.slice(0,3).some(id=>q.relevant.includes(id))),precisionAt3:ids.slice(0,3).filter(id=>q.relevant.includes(id)).length/3,durationMs:r.durationMs,stages:r.stages});}
        const groups=Object.fromEntries(["same-item","method-relevance"].map(category=>{const group=trials.filter(t=>t.category===category);return [category,{n:group.length,recallAt3:avg(group.map(t=>t.recallAt3)),recallAt10:avg(group.map(t=>t.recallAt10)),hitAt3:avg(group.map(t=>t.hitAt3)),precisionAt3:avg(group.map(t=>t.precisionAt3)),mrrAt10:avg(group.map(t=>t.mrrAt10)),ndcgAt10:avg(group.map(t=>t.ndcgAt10))}];}));
        const row={mode,n:trials.length,groups,recallAt3:avg(trials.map(t=>t.recallAt3)),recallAt10:avg(trials.map(t=>t.recallAt10)),mrrAt10:avg(trials.map(t=>t.mrrAt10)),ndcgAt10:avg(trials.map(t=>t.ndcgAt10)),p95Ms:pct(trials.map(t=>t.durationMs),.95),p99Ms:pct(trials.map(t=>t.durationMs),.99),cache:local.cacheStats()};
        rows.push(row);details.push({mode,trials});
    }
    const report={scope:`${exactQueries.length} exact-item paraphrases plus ${methodQueries.length} independent method intent queries. Method gold sets include ALL items in the annotated template family; hence Recall@3 is capped at 3/goldCount. Top3 is actual evidence, top10 includes diagnostic candidates. No IDs, gold answers, solutions or family labels sent as queries.`,rows,details};
    await writeFile(join(out,"rag.json"),JSON.stringify(report,null,2));return report;
}
