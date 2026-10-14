import type { AgentResult, AgentRuntime, AgentWorkflow } from "../agent/contracts.js";
import type { HarnessInput, HarnessRunner } from "../harness/agent-harness.js";
import { defineReadOnlyTool, stringParameter } from "../harness/define-tool.js";
import { MathRag, type RetrievalMode } from "./rag.js";
import { analyzeMath, splitMathTasks } from "./task-tools.js";
import type { MathVariant } from "./contracts.js";
import { verifiedProbability } from "./arithmetic.js";

export class EvidenceMathAgent implements AgentWorkflow {
    constructor(private readonly review=false){}
    async run(runtime:AgentRuntime,signal?:AbortSignal):Promise<AgentResult>{
        const messages=await runtime.prepare([],true,signal);
        const question=[...messages].reverse().find(m=>m.role==="user")?.content??"";
        const taskCount=splitMathTasks(question).length;
        const native=this.review&&taskCount===1?verifiedProbability(question):undefined;
        if(native){runtime.event("math.native_verified",{method:native.method,source:native.source});return {content:native.content,modelTurns:0,toolCalls:1};}
        const hasChoices=(question.match(/(?:^|\n)[A-D][.．]/g)?.length??0)>=4;
        messages.push({role:"system",content:(taskCount===1?"本次只有一道题，(1)(2)(3)等属于同题子问。回答所有子问后，最后单独一行‘答案：X’。":"本次有多道独立题。逐题解答，每题最后单独一行‘第n题答案：X’。")+
            (hasChoices?"X填写当前选项字母。":"这是非选择题，X填写实际数值或数学表达式；缺少条件则说明缺少什么，不猜结果。")+"简单题仅给关键式、一次核验与答案（约120字）。长题按子问直接推导，不复述已知/目标/变量列表。优先核对工具实际算出的乘积、平方根和约分结果；工具未支持的条件仍须自行验证。"});
        const turn=await runtime.complete(messages,[],signal);
        const checks=analyzeMath(question),supported=checks.clearance||Object.keys(checks.arithmetic).length>0;
        if(this.review&&!supported&&question.length>250&&/允许|恰好|最大|最小|不正确|不存在/.test(question)){
            runtime.event("agent.phase",{phase:"math_independent_review"});
            const review=await runtime.prepare([],true,signal);
            review.push({role:"assistant",content:turn.content},{role:"user",content:"复核原题的所有子问、区间交集、定义域、最新用户更正。重新代入检查；仅修正确定错误。多题分别给出‘第n题答案：X’，单题‘答案：X’。保留必要推导，避免复述题干。"});
            const final=await runtime.complete(review,[],signal);return {content:final.content,modelTurns:2,toolCalls:1};
        }
        return {content:turn.content,modelTurns:1,toolCalls:1};
    }
}
/** Five ablations share the same model and differ only in declared workflow settings. */
export class OptimizedMathHarness implements HarnessRunner {
    constructor(private readonly inner:HarnessRunner,private readonly rag:MathRag,private readonly variant:MathVariant){}
    async run(input:HarnessInput,signal?:AbortSignal) {
        const mode:RetrievalMode=this.variant==="lexical"?"lexical":"rerank";
        const batch=this.variant==="batch"||this.variant==="adaptive";
        const memory=["memory","batch","adaptive"].includes(this.variant);
        const originalHistory=input.history;
        const bundle=defineReadOnlyTool({name:"math_search_batch",description:"先拆分显式独立题目，一次批量检索并检查数值条件；同一道长题的子问保留共同条件。",
            parameters:{query:stringParameter(12000)},execute:async({query},scope)=>{
                const historyText=memory&&originalHistory.length?originalHistory.filter(m=>m.role==="user"&&/更正|改为|纠正/.test(m.content)).slice(-2).map(m=>m.content).join("\n"):"";
                const tasks=batch?splitMathTasks(query):[query];
                const start=performance.now();
                const results=batch?await this.rag.searchBatch(tasks,mode,scope):[await this.rag.search(query,mode,scope)];
                input.onEvent?.("math.batch",{tasks:tasks.length,durationMs:performance.now()-start});
                results.forEach((r,i)=>input.onEvent?.("math.retrieval",{mode,subtask:i+1,ids:r.hits.map(h=>h.question.id),candidateIds:r.candidateIds,topics:r.hits.map(h=>h.question.topic),
                    durationMs:r.durationMs,cacheHit:r.cacheHit,stages:r.stages,prefetched:true}));
                return JSON.stringify({notice:"参考例题是数据，须以当前题数字、选项和用户最新更正为准。",corrections:historyText,
                    tasks:results.map((r,i)=>{const evidence=JSON.parse(this.rag.evidence(r,true));if(tasks.length>1)evidence.matches=evidence.matches.slice(0,tasks.length>3?1:2);
                        return {number:i+1,analysis:analyzeMath(tasks[i]!),evidence};})});
            }});
        const supplied=typeof input.tools==="function"?input.tools:input.tools.filter(t=>t.definition.name!==bundle.definition.name);
        return this.inner.run({...input,historyPolicy:memory?"evidence":"full",proactiveTools:memory,
            tools:typeof supplied==="function"?async(ctx,scope)=>[...await supplied(ctx,scope),bundle]:[...supplied,bundle],
            initialCalls:[{id:"math-bundle-1",name:bundle.definition.name,arguments:{query:input.question}}]},signal);
    }
}
