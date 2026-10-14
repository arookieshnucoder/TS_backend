import { evaluateOptimization, evaluateRag } from "../src/modules/evaluation/math-optimization.js";
import { MATH_EXPERIMENTS, type MathVariant } from "../src/modules/math/contracts.js";
import { loadConfig } from "../src/config/env.js";
import { loadCorpus } from "../src/modules/math/corpus.js";
import { MathRag } from "../src/modules/math/rag.js";
import { GlmEmbeddings } from "../src/infrastructure/llm/glm-model.js";
import { mathEmbeddingConfig } from "../src/bootstrap/math-chat-agent.js";
const args=process.argv.slice(2),options=new Map<string,string>();
try{
    if(args.includes("--help")){console.log("--suite development|test|stress --out NEW_DIR --variants combined,lexical,rerank,memory,batch,adaptive --concurrency 1..4 --repeats 1..10 --cache cold|warm --limit N --rag-only true");}
    else{
        for(let i=0;i<args.length;i+=2){const key=args[i]?.replace(/^--/,""),value=args[i+1];if(!key||!value||!["suite","out","variants","concurrency","repeats","timeout-ms","cache","limit","rag-only"].includes(key)||options.has(key))throw new Error("Invalid options");options.set(key,value);}
        const config=loadConfig(),corpus=await loadCorpus(config.math.corpusPath),rag=await MathRag.open(corpus.knowledge,config.math.indexPath,new GlmEmbeddings(mathEmbeddingConfig(config)));
        const out=options.get("out")??`data/evaluations/math-v2-${Date.now()}`;
        if(options.get("rag-only")==="true")console.log(JSON.stringify((await evaluateRag(rag,out,Number(options.get("limit")??100))).rows));
        else {const result=await evaluateOptimization({out,suite:(options.get("suite")??"development") as "development"|"test"|"stress",variants:(options.get("variants")?.split(",")??MATH_EXPERIMENTS) as MathVariant[],
            concurrency:Number(options.get("concurrency")??2),repeats:Number(options.get("repeats")??1),timeoutMs:Number(options.get("timeout-ms")??120000),cache:(options.get("cache")??"cold") as "cold"|"warm",limit:options.has("limit")?Number(options.get("limit")):undefined,rag,progress:console.log});console.log(JSON.stringify(result.rows));}
    }
}catch(e){console.error(e instanceof Error?e.message:"Evaluation failed");process.exitCode=2;}
