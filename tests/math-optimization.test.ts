import test from "node:test";
import assert from "node:assert/strict";
import { grade9Corpus } from "../src/modules/math/grade9-bank.js";
import { historyEvidence } from "../src/modules/harness/history-evidence.js";
import { analyzeMath, splitMathTasks } from "../src/modules/math/task-tools.js";
import { MATH_EXPERIMENTS } from "../src/modules/math/contracts.js";
import { createMathProfile } from "../src/modules/math/profile.js";
import { fixture } from "./math-fixtures.js";
import { loadConfig } from "../src/config/env.js";
import { AgentHarness } from "../src/modules/harness/agent-harness.js";
import { AskAgent } from "../src/modules/agent/ask-agent.js";
import { defineReadOnlyTool } from "../src/modules/harness/define-tool.js";
import { answerVector, retrievalScores, stressCases } from "../src/modules/evaluation/math-optimization.js";
import type { AgentMessage } from "../src/modules/agent/contracts.js";
const logger={info(){},error(){}};

test("grade9 has 500 attributed unique questions, exactly 50 long hard, and no split overlap",()=>{
    const c=grade9Corpus();assert.equal(c.knowledge.length,500);assert.equal(c.knowledge.filter(q=>q.difficulty==="long-hard").length,50);
    assert.equal(new Set(c.knowledge.map(q=>q.family)).size,23);assert.ok(c.knowledge.every(q=>q.grade===9&&q.source.kind==="authored"&&new Set(q.options).size===4));
    assert.ok(c.knowledge.filter(q=>q.difficulty==="long-hard").every(q=>q.question.length>200&&q.question.includes("(3)")));
    const stems=new Set(c.knowledge.map(q=>q.question));assert.ok([...c.development,...c.test].every(q=>!stems.has(q.question)));
    assert.equal(c.test.length+stressCases(c).length,100);
});
test("quadratic references independently satisfy the original equation for all parameter values",()=>{
    const c=grade9Corpus();for(const q of [...c.knowledge,...c.test].filter(q=>q.family==="roots")){
        const m=q.question.match(/x²-(\d+)x\+(\d+)=0/)!;const roots=q.options["ABCD".indexOf(q.answer)]!.split("和").map(Number);
        assert.equal(roots.length,2);for(const x of roots)assert.equal(x*x-Number(m[1])*x+Number(m[2]),0);
    }
});
test("history evidence retrieves old condition and latest correction without rewriting source",()=>{
    const h:AgentMessage[]=[{role:"user",content:"第1题：x²-3x+2=0"},{role:"assistant",content:"错误旧答案：-1和-2"},...Array.from({length:100},(_,i)=>({role:"user" as const,content:`其他题${i}讨论面积，不属于第1题。`})),{role:"user",content:"第1题条件更正，改为x²-7x+12=0"}];
    const saved=structuredClone(h),r=historyEvidence(h,"求之前第1题最新更正后的根",600);
    assert.match(r.messages.map(m=>m.content).join("\n"),/x²-3x\+2=0/);assert.match(r.messages.at(-1)!.content,/x²-7x\+12=0/);assert.deepEqual(h,saved);assert.ok(r.omitted>0);
    assert.match(historyEvidence(h,"求之前第一题最新更正后的根",600).messages.map(m=>m.content).join("\n"),/x²-7x\+12=0/);
});
test("explicit multiple questions split; dependent subparts remain together; oversized batches reject",()=>{
    assert.equal(splitMathTasks("第1题：求根\n第2题：求面积").length,2);
    assert.equal(splitMathTasks("第一题：求根\n第二题：求面积").length,2);
    assert.equal(splitMathTasks("一题：(1)求根\n(2)求面积").length,1);
    assert.throws(()=>splitMathTasks(Array.from({length:9},(_,i)=>`第${i+1}题：计算`).join("\n")),/eight/);
    const r=analyzeMath("解方程 x²-7x+12=0，且x>0");assert.deepEqual(r.quadratic?.realRoots,[3,4]);assert.equal(analyzeMath("x²-3x+1=2").quadratic,undefined);
    const negative=analyzeMath("解方程 -x²+4x-3=0").quadratic!;assert.deepEqual(negative.coefficients,[-1,4,-3]);for(const x of negative.realRoots as number[])assert.equal(-x*x+4*x-3,0);
    assert.equal(analyzeMath("10-x²+4x-3=0").quadratic,undefined);
    assert.equal(analyzeMath("x²-0.2x+0.01=0").quadratic?.discriminant,0);
    const roof=analyzeMath("y=-(x-35)²+1225，车宽2米、车高1221米，车顶保持水平");assert.deepEqual(roof.clearance?.centerInterval,[34,36]);
});
test("batch retrieval deduplicates embeddings and lexical mode requires none; caches respect byte budget",async()=>{
    const f=fixture();await f.rag.searchBatch(["求圆面积","求中位数","求圆面积"],"rerank");assert.equal(f.calls(),1);
    await f.rag.searchBatch(["求圆面积","求中位数"],"rerank");assert.equal(f.calls(),1);
    await f.rag.search("求二次函数","lexical");assert.equal(f.calls(),1);
    for(let i=0;i<180;i++)await f.rag.search(`求圆面积${i}`,"lexical");const stats=f.rag.cacheStats();assert.ok(stats.entries<=128&&stats.bytes<=stats.budgetBytes);
});
test("five variants call evidence tools before a model that never requests tools",async()=>{
    for(const variant of MATH_EXPERIMENTS.filter(v=>v!=="combined")){
        const f=fixture(),events:string[]=[];let content="";
        const model={async turn(messages:AgentMessage[]){events.push("model");content=messages.map(m=>m.content).join("\n");return {content:"计算正确。\n答案：B",toolCalls:[]};}};
        const config=loadConfig({NODE_ENV:"test"}),p=createMathProfile(variant,f.rag,model,config.context,logger);
        await p.harness.run({history:[],question:"计算数据的中位数",tools:[f.rag.tool(p.mode)],metadata:{},onEvent(name){events.push(name);}});
        assert.ok(events.indexOf("agent.tool.started")<events.indexOf("model"));assert.match(content,/statistics/);
    }
});
test("generic harness takes verbatim evidence proactively instead of summarizing away an old constraint",async()=>{
    const config=loadConfig({NODE_ENV:"test",LLM_MAX_INPUT_TOKENS:"4096"}),history:AgentMessage[]=[{role:"user",content:"第1题：关键条件是x=17，不能替换。"},...Array.from({length:60},()=>({role:"user" as const,content:"其他练习，与第1题无关。".repeat(40)}))];
    let prompt="",turns=0;const harness=new AgentHarness({async turn(messages){turns++;prompt=messages.map(m=>m.content).join("\n");return {content:"x=17",toolCalls:[]};}},new AskAgent(),{system:"依据用户原始条件回答。",final:"完成。"},config.context,logger);
    await harness.run({history,question:"请复述之前第1题关键条件",tools:[],metadata:{}});assert.equal(turns,1);assert.match(prompt,/x=17/);assert.ok(prompt.length<10000);
});
test("math history evidence is not duplicated into a constrained context or sent through another summary",async()=>{
    const f=fixture(),config=loadConfig({NODE_ENV:"test",LLM_MAX_INPUT_TOKENS:"8192"}),h:AgentMessage[]=[{role:"user",content:"第1题：x²-8x+12=0"}];
    for(let i=0;i<48;i++){if(i===12)h.push({role:"user",content:"第1题条件更正：改为x²-31x+234=0"});h.push({role:"user",content:`第${i+2}题讨论统计，和第1题无关。`.repeat(18)},{role:"assistant",content:"这是另外一道题。"});}
    h.push({role:"assistant",content:"第1题错误总结：根还是2和6。"});let calls=0,prompt="";
    const p=createMathProfile("memory",f.rag,{async turn(messages){calls++;assert.ok(!messages[0]?.content.startsWith("Summarize the following"));prompt=messages.map(m=>m.content).join("\n");return {content:"两根13和18。\n答案：B",toolCalls:[]};}},config.context,logger);
    await p.harness.run({history:h,question:"请解之前第1题，使用用户中途的更正，助手总结可能错误。\nA. 2和6\nB. 13和18\nC. -13和-18\nD. 14和19",tools:[f.rag.tool(p.mode)],metadata:{}});
    assert.equal(calls,1);assert.match(prompt,/x²-31x\+234=0/);
});
test("independent read-only tool calls run together and preserve output order",async()=>{
    let active=0,peak=0;const tool=(name:string)=>defineReadOnlyTool({name,description:name,parameters:{},execute:async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,20));active--;return name;}});
    const config=loadConfig({NODE_ENV:"test"});let turns=0;
    const harness=new AgentHarness({async turn(){return ++turns===1?{content:"",toolCalls:[{id:"a",name:"first",arguments:{}},{id:"b",name:"second",arguments:{}}]}:{content:"完成",toolCalls:[]};}},new AskAgent(),{system:"使用工具",final:"完成"},config.context,logger);
    await harness.run({history:[],question:"研究",tools:[tool("first"),tool("second")],metadata:{}});assert.equal(peak,2);
});
test("multi-answer grader rejects missing or conflicting conclusions and retrieval metrics use actual IDs",()=>{
    assert.deepEqual(answerVector("第1题答案：A\n第2题答案：C",2),["A","C"]);assert.deepEqual(answerVector("第1题答案：A\n第1题答案：B\n第2题答案：C",2),[null,"C"]);
    assert.deepEqual(answerVector("### 第1题\n计算\n**答案**：A\n### 第2题\n计算\n答案：C",2),["A","C"]);
    assert.deepEqual(answerVector("答案：A\n答案：B\n第4题答案：A",1),[null]);
    const r=retrievalScores(["wrong","q2","q1"],["q1","q2"],3);assert.equal(r.recall,1);assert.equal(r.mrr,.5);assert.ok(r.ndcg!<1);assert.equal(retrievalScores(["same-topic"],["q1"],3).recall,0);
});
