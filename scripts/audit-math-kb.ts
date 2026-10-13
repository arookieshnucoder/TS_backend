import { mkdir, writeFile } from 'node:fs/promises';
import { loadCorpus } from '../src/modules/math/corpus.js';
import { MathRag } from '../src/modules/math/rag.js';
import { renderQuestion } from '../src/modules/math/contracts.js';
import { GlmEmbeddings } from '../src/infrastructure/llm/glm-model.js';
import { percentile } from '../src/modules/evaluation/statistics.js';
const corpus = await loadCorpus('evals/math/corpus.json');
const rag = await MathRag.open(corpus.knowledge,'data/math/index.json',new GlmEmbeddings({llmApiKey:process.env.LLM_API_KEY,llmModel:'glm-4.7',llmBaseUrl:'https://open.bigmodel.cn/api/paas/v4',llmTimeoutMs:120000}));
const rows = [];
for(const q of corpus.knowledge) {
    const query=renderQuestion(q), dense=await rag.search(query,'dense'), hybrid=await rag.search(query,'hybrid');
    rows.push({id:q.id, denseIds:dense.hits.map(h=>h.question.id),hybridIds:hybrid.hits.map(h=>h.question.id),
        denseRecallAt3:dense.hits.some(h=>h.question.id===q.id),hybridRecallAt3:hybrid.hits.some(h=>h.question.id===q.id),
        denseMs:dense.durationMs,hybridMs:hybrid.durationMs,hasSolution:!!q.solution});
    if(rows.length%20===0)console.log(`Knowledge retrieval ${rows.length}/100`);
}
const report={scope:'Known-question retrieval audit only, not held-out solving accuracy',questions:rows.length,
    allHaveSolutions:rows.every(r=>r.hasSolution),denseRecallAt3:rows.filter(r=>r.denseRecallAt3).length/rows.length,
    hybridRecallAt3:rows.filter(r=>r.hybridRecallAt3).length/rows.length,
    denseP50Ms:percentile(rows.map(r=>r.denseMs),.5),hybridP50Ms:percentile(rows.map(r=>r.hybridMs),.5),rows};
await mkdir('data/evaluations/math-kb-audit',{recursive:true});
await writeFile('data/evaluations/math-kb-audit/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,rows:undefined}));
