import test from "node:test";
import assert from "node:assert/strict";
import {conclusion,conclusions} from "../src/modules/evaluation/math-conclusion.js";
test("math answer correctness does not depend on line wrapping; source-example and conflicting answers are rejected",()=>{
    assert.equal(conclusion("顶点为(34,25)，核对选项。答案：D。D"),"D");
    assert.equal(conclusion("计算正确。最终答案：B。"),"B");
    assert.equal(conclusion("参考例题答案：A，所以选择B"),null);
    assert.equal(conclusion("答案：A\n答案：B"),null);
    assert.equal(conclusion("答案：A\n复核后，答案：B。"),null);
    assert.equal(conclusion("旧答案：A。更正后最终答案：B。"),"B");
    assert.equal(conclusion("答案：BCD"),null);
    assert.equal(conclusion("答案：CC"),"C");
    assert.equal(conclusion("答案：A或B"),null);assert.equal(conclusion("答案：A/B"),null);
    assert.deepEqual(conclusions("### 第1题\n计算完成，答案：A。\n### 第2题\n计算完成，答案：C。",2),["A","C"]);
    assert.deepEqual(conclusions("第一题答案：A\n第二题答案：C",2),["A","C"]);
});
