import assert from 'node:assert/strict';
import test from 'node:test';
import { describeData, subtractionStructures, deterministicChecks, equilateralAreaEnvelope, similarTrianglesInSecondQuadrant } from '../src/modules/math/checks.js';
test('statistics verifies duplicate-aware removal, median, modes and no-mode data', () => {
    assert.deepEqual(describeData([4, 2, 2, 3, 1]), { sorted: [1, 2, 2, 3, 4], median: 2, modes: [2], maxFrequency: 2 });
    assert.equal(describeData([1, 2, 5, 6]).median, 3.5);
    assert.deepEqual(describeData([1, 2, 3]).modes, []);
    const checks = deterministicChecks('数据为1,2,2,3,4，去掉两个数后中位数和众数如何变化？\nA.1,4\nB.2,2')!;
    const removals = checks.removals as { choice: string; modesUnchanged: boolean }[];
    assert.equal(removals[0]!.modesUnchanged, true); assert.equal(removals[1]!.modesUnchanged, false);
});
test('symbolic subtraction enumeration checks all parenthesizations and invariants', () => {
    const three = subtractionStructures(['a', 'b', 'c']);
    assert.equal(three.count, 2); assert.deepEqual(three.coefficients, [[1, -1, 1], [1, -1, -1]]);
    assert.equal(three.originalReachable, true); assert.equal(three.negativeOriginalReachable, false);
    assert.equal(subtractionStructures(['a', 'b', 'c', 'd']).count, 4);
    assert.throws(() => subtractionStructures(['a', 'a', 'b']), /Unsupported/);
    assert.ok(deterministicChecks('给a-b-c加括号进行加算操作')?.subtraction);
    assert.equal(deterministicChecks('写一个故事'), undefined);
});
test('equilateral area envelope agrees with independent coordinate areas and rejects wrong applicability', () => {
    const check = equilateralAreaEnvelope(4, 3), h = 2 * Math.sqrt(3);
    const a = [0, h], b = [-2, 0], c = [2, 0], p = [0, -h];
    const area = (x: number[], y: number[], z: number[]) => Math.abs((y[0]!-x[0]!)*(z[1]!-x[1]!) - (y[1]!-x[1]!)*(z[0]!-x[0]!))/2;
    assert.ok(Math.abs((area(p,a,b)+area(p,b,c)+area(p,c,a))/area(a,b,c)-3)<1e-10);
    assert.ok(Math.abs(check.minimumDistance-Math.hypot(p[0]!,p[1]!-h/3))<1e-10);
    assert.throws(() => equilateralAreaEnvelope(4, 1), /Unsupported/);
    assert.equal(deterministicChecks('边长为4的等边三角形中心O，P在三角形外，面积S_1+S_2+S_3=3S_0')?.equilateralArea !== undefined, true);
});
test('similarity enumeration excludes axes and validates side ratios independently', () => {
    const r = similarTrianglesInSecondQuadrant([0,3],[6,0]); assert.equal(r.count,4);
    const reference = [3,6,Math.sqrt(45)].sort((a,b)=>a-b);
    for (const [x,y] of r.points) {
        assert.ok(x<0 && y>0);
        const sides = [3,Math.hypot(x,y),Math.hypot(x,y-3)].sort((a,b)=>a-b);
        assert.ok(Math.abs(sides[1]!/sides[0]!-reference[1]!/reference[0]!)<1e-8);
        assert.ok(Math.abs(sides[2]!/sides[0]!-reference[2]!/reference[0]!)<1e-8);
    }
    assert.equal(similarTrianglesInSecondQuadrant([6,0],[0,3]).count,0);
});
