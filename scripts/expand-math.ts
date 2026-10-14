import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { grade9Corpus } from "../src/modules/math/grade9-bank.js";
await mkdir("evals/math",{recursive:true});
try { await access("evals/math/corpus-legacy100.json"); } catch {
    try { const old=await readFile("evals/math/corpus.json","utf8"); if(JSON.parse(old).knowledge.length===100) await writeFile("evals/math/corpus-legacy100.json",old,{flag:"wx"}); } catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
}
const c=grade9Corpus();
await writeFile("evals/math/corpus.json",JSON.stringify(c,null,2));
console.log(JSON.stringify({knowledge:c.knowledge.length,longHard:c.knowledge.filter(q=>q.difficulty==="long-hard").length,development:c.development.length,test:c.test.length,families:new Set(c.knowledge.map(q=>q.family)).size}));
