import assert from "node:assert/strict";
import {once} from "node:events";
import {mkdir,mkdtemp,readFile,readdir} from "node:fs/promises";
import {join} from "node:path";
import type {AddressInfo} from "node:net";
import {createApp} from "../src/app.js";
import {loadConfig} from "../src/config/env.js";
import {answerVector} from "../src/modules/evaluation/math-optimization.js";
if(!process.env.LLM_API_KEY)throw new Error("LLM_API_KEY required");
await mkdir("data/smoke",{recursive:true});const root=await mkdtemp("data/smoke/optimized-");
const variant=process.env.MATH_AGENT_VARIANT??"adaptive";
for(const mode of [variant,"general"]){
    const config=loadConfig({...process.env,NODE_ENV:"test",MATH_AGENT_VARIANT:mode,LLM_MODEL:"glm-4.6v",LLM_BASE_URL:"https://open.bigmodel.cn/api/paas/v4",AGENT_WORKSPACE_ENABLED:"false",SESSION_DATA_DIR:join(root,mode,"sessions"),MATH_SUBMISSIONS_PATH:join(root,mode,"submissions"),AGENT_MODEL_ATTEMPT_TIMEOUT_MS:"60000",AGENT_TOOL_TIMEOUT_MS:"30000"});
    const server=createApp(config).listen(0,"127.0.0.1");await once(server,"listening");
    try{const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const post=async(path:string,body:unknown)=>{const r=await fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});assert.equal(r.status,path==="/api/chat/sessions"?201:200);return (await r.json()).data;};
        const session=await post("/api/chat/sessions",{title:"虚构数学冒烟测试"});
        if(mode==="general"){
            const s=await post(`/api/chat/sessions/${session.id}/messages`,{content:"请调用math_calculate工具计算71*70，用中文回答并说明结果来自工具。"});assert.match(s.messages.at(-1).content,/4970/);
            console.log("LIVE PASS general: GLM-4.6V tool calling, calculator, HTTP persistence");
        }else{
            const s=await post(`/api/chat/sessions/${session.id}/messages`,{content:"第1题：解方程 x²-5x+6=0。\nA. 0和5\nB. -2和-3\nC. 2和3\nD. 1和6\n第2题：圆半径5，圆心到弦距离3，求弦长。\nA. 8\nB. 4\nC. 10\nD. 6\n请分别给出第n题答案。"});assert.deepEqual(answerVector(s.messages.at(-1).content,2),["C","A"]);
            const open=await post(`/api/chat/sessions/${session.id}/messages`,{content:"求函数 y=x²-4x+1 的最小值。这是非选择题，请给出实际数值并检验。"});assert.match(open.messages.at(-1).content,/-3/);assert.doesNotMatch(open.messages.at(-1).content,/答案[：:]\s*[A-D](?:\s|$)/);
            const files=await readdir(config.math.submissionsPath);assert.equal(files.length,2);
            for(const f of files){const r=JSON.parse(await readFile(join(config.math.submissionsPath,f),"utf8"));assert.equal(r.vector,null);assert.equal(r.embeddingStatus,"retrieval_owned");assert.equal(r.status,"solved_unverified");assert.equal(r.trusted,false);}
            console.log(`LIVE PASS ${mode}: multiple questions, open answer, no duplicate submission embedding, saved untrusted submissions`);
        }
    }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
