import assert from 'node:assert/strict';
import test from 'node:test';
import { numericOption, verifiedSolution } from '../src/modules/math/verified-solution.js';
import { midpointAxisPath } from '../src/modules/math/checks.js';
import { createMathProfile } from '../src/modules/math/profile.js';
import { loadConfig } from '../src/config/env.js';
import { MathRag,corpusDigest } from '../src/modules/math/rag.js';
import { hash } from '../src/modules/math/corpus.js';
test('bounded arithmetic parses roots, fractions, powers and pi without executing input',()=>{
    assert.ok(Math.abs(numericOption(String.raw`\frac{{5\sqrt{3}}}{2}`)!-5*Math.sqrt(3)/2)<1e-10);
    assert.ok(Math.abs(numericOption(String.raw`8\sqrt{2}`)!-8*Math.sqrt(2))<1e-10);
    assert.equal(numericOption('-2^2'),-4);assert.equal(numericOption('(-2)^2'),4);
    assert.equal(numericOption('1/0'),undefined);assert.equal(numericOption('alert(1)'),undefined);assert.equal(numericOption('a^2'),undefined);
    assert.equal(numericOption(String.raw`4\pi`),4*Math.PI);
});
test('proved solutions use current choice order and fresh numerical values',()=>{
    const q='在第二象限找点P，A(0,3)，B(6,0)，使PAO和AOB相似的三角形个数为：\nA.4\nB.3\nC.2\nD.5';
    assert.equal(verifiedSolution(q)?.answer,'A');
    const geometric=String.raw`边长为4的等边三角形中心O，P在三角形外，面积S_1+S_2+S_3=3S_0，求OP长的最小值。`+'\nA.'+String.raw`\frac{4\sqrt3}{3}`+'\nB.'+String.raw`\frac{8\sqrt3}{3}`+'\nC.'+String.raw`\frac{10\sqrt3}{3}`+'\nD.'+String.raw`4\sqrt3`;
    assert.equal(verifiedSolution(geometric)?.answer,'B');
    const path='点M在y轴的非负半轴上运动，点N在x轴上运动，OM+ON=10，点Q为线段MN的中点，求Q运动路径的长。\nA.10\nB.20\nC.5\nD.'+String.raw`10\sqrt2`;
    assert.equal(verifiedSolution(path)?.answer,'D');
    const p=midpointAxisPath(10);assert.equal(p.vertices.length,3);
    assert.ok(Math.abs(p.length-(Math.hypot(5,5)+Math.hypot(5,-5)))<1e-10);
});
test('statistics and logical claims are calculated, ambiguous or unsupported questions stay with the model',()=>{
    const stats='数据1,2,2,3,4，去掉两数后中位数、众数保持不变。\nA.1,4\nB.2,2\nC.1,2\nD.2,4';
    assert.equal(verifiedSolution(stats)?.answer,'A');
    const brackets='多项式a-b-c-d，加括号进行加算操作。至少存在一种，使其运算结果与原多项式相等；不存在任何，使其运算结果与原多项式之和为0；共有8种不同运算结果。求正确的个数。\nA.0\nB.1\nC.2\nD.3';
    assert.equal(verifiedSolution(brackets)?.answer,'C');
    assert.equal(verifiedSolution('求y=x^2最小值'),undefined);
    assert.equal(verifiedSolution(stats.replace('D.2,4','D.3,4')),undefined);
});
test('combined uses a proved result without an LLM call and logs that route rather than inventing model usage',async()=>{
    const questions=[{id:'fixture',question:'求中位数',options:['1','2','3','4'],answer:'B',topic:'statistics',source:{url:'https://example.com',dataset:'test-only',row:1,sha256:hash('fixture')}}];
    const embeddings={model:'test-only',dimensions:2,async embed(texts:string[]){return texts.map(()=>[1,0]);}};
    const rag=new MathRag(questions,{version:1,corpusHash:corpusDigest(questions),model:'test-only',dimensions:2,ids:['fixture'],vectors:[[1,0]]},embeddings);
    const config=loadConfig({NODE_ENV:'test'});let calls=0;const events:string[]=[];
    const profile=createMathProfile('combined',rag,{async turn(){calls++;throw new Error('Must not call model for a complete proof');}},config.context,{info(){},error(){}});
    const result=await profile.harness.run({question:'数据1,2,2,3,4，去掉两数后中位数、众数保持不变。\nA.1,4\nB.2,2\nC.1,2\nD.2,4',history:[],tools:[rag.tool(profile.mode)],metadata:{},onEvent(n){events.push(n);}});
    assert.equal(calls,0);assert.equal(result.modelTurns,0);assert.match(result.content,/答案：A/);assert.ok(events.includes('math.native_verified'));
});
