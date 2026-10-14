import test from "node:test";
import assert from "node:assert/strict";
import {calculate,reducedFraction,arithmeticChecks,verifiedProbability} from "../src/modules/math/arithmetic.js";
test("restricted calculator respects precedence, powers and real domain",()=>{
    assert.equal(calculate("71*70"),4970);assert.equal(calculate("sqrt(4)"),2);assert.equal(calculate("-2^2"),-4);assert.equal(calculate("2^-2"),.25);assert.equal(calculate("2^3^2"),512);
    assert.equal(calculate("3*(5+2)/7"),3);for(const s of ["1/0","sqrt(-1)","0^0","process.exit()","Math.sqrt(4)","1;alert(2)","x+1"])assert.throws(()=>calculate(s));
});
test("probability arithmetic preserves exact rational products and does not guess the experiment",()=>{
    assert.deepEqual(reducedFraction(1190,4970),{numerator:1190,denominator:4970,exact:"17/71",decimal:1190/4970});
    const r=arithmeticChecks("袋中有35个红球和36个白球，随机不放回取2球。") as any;assert.equal(r.ballProbabilities.withoutReplacementTwoRed.exact,"17/71");assert.equal(r.ballProbabilities.withReplacementTwoRed.exact,"1225/5041");
    assert.deepEqual(arithmeticChecks("概率问题没有给出数量"),{});
    assert.equal((arithmeticChecks("矩形面积为280，长比宽多6。") as any).rectangle.width,14);
    const text="袋中有35个红球和36个白球，大小相同，随机不放回连续取2球。两球都是红球的概率是多少？\nA. 1225/5041\nB. 35/71\nC. 1190/5041\nD. 17/71";
    assert.match(verifiedProbability(text)!.content,/答案：D/);assert.equal(verifiedProbability(text.replace("两球都是红球的概率","两球不都是红球的概率")),undefined);
    assert.equal(verifiedProbability(text.replace("D. 17/71","D. 1/2")),undefined);
    assert.equal(verifiedProbability(text.replace("大小相同，","")),undefined);
    assert.equal(verifiedProbability(text.replace("大小相同，","大小相同，但红球权重不同，")),undefined);
    assert.equal(verifiedProbability(text.replace("不放回","不放回和有放回两种实验")),undefined);
    const profit=arithmeticChecks("进货价每本20元。售价为40元时每天销量为100本，售价每提高1元，日销量减少1本。") as any;assert.equal(profit.profit.optimalPrice,80);assert.equal(profit.profit.maximumProfit,3600);
    const moving=arithmeticChecks("∠A=90°，AB=12厘米、AC=16厘米。P从A沿AB运动，每秒2厘米，Q同时从C沿CA运动，每秒4厘米。") as any;assert.equal(moving.movingArea.maxTime,2);assert.deepEqual(moving.movingArea.timeDomain,[0,4]);
});
