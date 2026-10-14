import {spawn} from "node:child_process";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {loadConfig} from "../src/config/env.js";
import {loadCorpus} from "../src/modules/math/corpus.js";
import {MathRag,corpusDigest} from "../src/modules/math/rag.js";
import {createMathProfile} from "../src/modules/math/profile.js";
import {TokenBudget} from "../src/modules/harness/context/tokens.js";
import type {AgentMessage} from "../src/modules/agent/contracts.js";
if(process.argv[2]==="--child"){
    const mode=process.argv[3] as "combined"|"adaptive",config=loadConfig({NODE_ENV:"test",LLM_MAX_INPUT_TOKENS:"8192"});
    const c=await loadCorpus("evals/math/corpus.json"),embedding={model:"local-memory-benchmark-only",dimensions:1,async embed(texts:string[]){return texts.map(()=>[1]);}};
    const rag=new MathRag(c.knowledge,{version:1,corpusHash:corpusDigest(c.knowledge),model:embedding.model,dimensions:1,ids:c.knowledge.map(q=>q.id),vectors:c.knowledge.map(()=>[1])},embedding);
    new TokenBudget(config.context).count("Initialize tokenizer outside measured history processing.");
    const h:AgentMessage[]=[{role:"user",content:"第1题：关键条件x=17。"}];
    for(let i=0;i<250;i++){if(i===80)h.push({role:"user",content:"第1题条件更正：现在x=23，原值作废。"});h.push({role:"user",content:`第${i+2}题是其他练习。`+"讨论另一道题的统计数据、变量和单位。".repeat(14)},{role:"assistant",content:"记录另一道题，不能代替第1题的条件。"});}
    h.push({role:"assistant",content:"第1题错误总结：x还是17。"});
    let peakHeap=0,peakRss=0,modelCalls=0;const sample=()=>{const m=process.memoryUsage();peakHeap=Math.max(peakHeap,m.heapUsed);peakRss=Math.max(peakRss,m.rss);};
    const p=createMathProfile(mode,rag,{async turn(messages){modelCalls++;sample();await new Promise(r=>setTimeout(r,1));return {content:messages[0]?.content.startsWith("Summarize")?"Historical user correction: x=23.":"This is a local resource benchmark, not a math accuracy trial.",toolCalls:[]};}},config.context,{info(){},error(){}},{toolOutputTokens:6000});
    (globalThis as any).gc?.();const before=process.memoryUsage();peakHeap=before.heapUsed;peakRss=before.rss;
    const start=performance.now();await p.harness.run({history:h,question:"请复述之前第1题的最新用户条件，更正优先于错误助手总结。",tools:[rag.tool(p.mode)],metadata:{},onEvent:sample});sample();
    const result={mode,historyMessages:h.length,historyCharacters:h.reduce((s,m)=>s+m.content.length,0),durationMs:performance.now()-start,modelCalls,
        baseHeapMiB:before.heapUsed/1048576,peakHeapMiB:peakHeap/1048576,heapIncreaseMiB:(peakHeap-before.heapUsed)/1048576,peakRssMiB:peakRss/1048576};
    console.log(JSON.stringify(result));
}else{
    const out=resolve(process.argv[2]??`data/evaluations/memory-${Date.now()}`);await mkdir(out,{recursive:true});const rows:any[]=[];
    for(const mode of ["combined","adaptive"]){const text=await new Promise<string>((ok,fail)=>{let output="";const child=spawn(process.execPath,["--expose-gc","--import","tsx","scripts/benchmark-agent-memory.ts","--child",mode],{stdio:["ignore","pipe","pipe"],env:process.env});child.stdout.on("data",d=>output+=String(d));child.stderr.on("data",d=>output+=String(d));child.on("error",fail);child.on("exit",code=>code===0?ok(output):fail(new Error(output.slice(-1000))));});rows.push(JSON.parse(text.trim()));}
    await writeFile(join(out,"memory.json"),JSON.stringify({scope:"Local long-history execution memory benchmark in two fresh Node processes. Real harness/context/tokenizer/RAG code, fixture embeddings and a fixture model; excludes network and provider memory, not a model accuracy or production latency benchmark. Tokenizer initialized and GC run before measuring history processing.",rows},null,2));console.log(JSON.stringify(rows));
}
