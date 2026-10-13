/** Small deterministic checks of supported math structures; no gold answers or question IDs are used. */
export function describeData(data: number[]) {
    if (!data.length || data.some(n => !Number.isFinite(n))) throw new Error('Invalid numeric data');
    const sorted = [...data].sort((a, b) => a - b), n = sorted.length;
    const frequencies = new Map<number, number>();
    sorted.forEach(x => frequencies.set(x, (frequencies.get(x) ?? 0) + 1));
    const maxFrequency = Math.max(...frequencies.values());
    return { sorted, median: n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2,
        modes: maxFrequency === 1 ? [] : [...frequencies].filter(([, frequency]) => frequency === maxFrequency).map(([number]) => number), maxFrequency };
}
export function subtractionStructures(names: string[]) {
    if (names.length < 2 || names.length > 7 || new Set(names).size !== names.length || names.some(name => !/^[A-Za-z]$/.test(name))) throw new Error('Unsupported subtraction expression');
    const memo = new Map<string, number[][]>();
    function all(from: number, to: number): number[][] {
        const key = `${from}:${to}`; if (memo.has(key)) return memo.get(key)!;
        const results = new Map<string, number[]>();
        if (to - from === 1) { const vector = names.map((_, i) => Number(i === from)); results.set(vector.join(','), vector); }
        else for (let split = from + 1; split < to; split++) for (const left of all(from, split)) for (const right of all(split, to)) {
            const vector = left.map((v, i) => v - right[i]!); results.set(vector.join(','), vector);
        }
        const value = [...results.values()]; memo.set(key, value); return value;
    }
    const coefficients = all(0, names.length), original = names.map((_, i) => i === 0 ? 1 : -1);
    return { variables: names, count: coefficients.length, coefficients, original,
        originalReachable: coefficients.some(v => v.every((x, i) => x === original[i])),
        negativeOriginalReachable: coefficients.some(v => v.every((x, i) => x === -original[i]!)) };
}
/** Outside an equilateral triangle, sum of the three unsigned subareas is ratio*S.
 * Barycentric coordinates sum to 1, their absolute values sum to ratio. The nearest
 * boundary has one negative coordinate -(ratio-1)/2 and two equal positive ones.
 */
export function equilateralAreaEnvelope(side: number, ratio: number) {
    if (!Number.isFinite(side) || side <= 0 || !Number.isFinite(ratio) || ratio <= 1) throw new Error('Unsupported area envelope');
    const height = side * Math.sqrt(3) / 2;
    return { side, ratio, height, minimumDistance: height * (3 * ratio - 1) / 6,
        minimumDistanceAsSqrt3: `${side * (3 * ratio - 1) / 12}*sqrt(3)`,
        barycentricAtMinimum: [-(ratio - 1) / 2, (ratio + 1) / 4, (ratio + 1) / 4],
        applicability: '等边三角形中心O，P在三角形外，三块无符号面积之和=k倍原面积且k>1；未满足这些条件不能使用。' };
}
/** Intersect distance circles for all six side correspondences of triangles PAO and AOB. */
export function similarTrianglesInSecondQuadrant(a: [number, number], b: [number, number]) {
    const ao = Math.hypot(...a), bo = Math.hypot(...b), ab = Math.hypot(a[0]-b[0], a[1]-b[1]);
    if (!ao || !bo || Math.abs(a[0]*b[1]-a[1]*b[0])<1e-10) throw new Error('Degenerate reference triangle');
    const lengths = [ao, bo, ab], points: [number, number][] = [];
    for (let side = 0; side < 3; side++) {
        const remaining = lengths.filter((_, i) => i !== side), scale = ao/lengths[side]!;
        for (const order of [remaining, [...remaining].reverse()]) {
            const po = order[0]!*scale, pa = order[1]!*scale;
            const t = (po*po-pa*pa+ao*ao)/(2*ao), square = po*po-t*t;
            if (square < -1e-9) continue;
            for (const sign of [-1, 1]) {
                const perpendicular = sign*Math.sqrt(Math.max(0,square));
                const p: [number,number] = [(t*a[0]-perpendicular*a[1])/ao,(t*a[1]+perpendicular*a[0])/ao];
                if (p[0] < -1e-9 && p[1] > 1e-9 && !points.some(q => Math.hypot(q[0]-p[0],q[1]-p[1])<1e-8)) points.push(p);
            }
        }
    }
    return { a, b, points, count: points.length, applicability: '三角形PAO与AOB相似，O为原点，P严格在第二象限；枚举六种对应关系，去重并排除坐标轴。' };
}
export function midpointAxisPath(total: number) {
    if(!Number.isFinite(total)||total<=0)throw new Error('Invalid path total');
    return {total,vertices:[[-total/2,0],[0,total/2],[total/2,0]],length:total*Math.sqrt(2),lengthAsSqrt2:`${total}*sqrt(2)`,
        applicability:'M在y轴非负半轴，N在整个x轴，OM+ON=L，Q为MN中点；轨迹是上方两条有限线段。'};
}
export function deterministicChecks(query: string): Record<string, unknown> | undefined {
    const stem = query.split(/\nA[.．]/)[0]!.replace(/\$/g, '');
    const result: Record<string, unknown> = {};
    if (/加括号|加算操作/.test(stem)) {
        const flat = stem.match(/\b([A-Za-z](?:\s*-\s*[A-Za-z]){2,6})\b/);
        if (flat) { const names = flat[1]!.split(/\s*-\s*/); if (new Set(names).size === names.length) result.subtraction = subtractionStructures(names); }
    }
    if (/等边/.test(stem) && !/(?:不是|并非|非|不为)等边|不在.{0,50}外/.test(stem) && /面积/.test(stem) && /中心/.test(stem) && /在.{0,50}外/.test(stem)) {
        const compact = stem.replace(/[{}\s]/g, ''), side = compact.match(/边长为(\d+(?:\.\d+)?)/), ratio = compact.match(/S_1\+S_2\+S_3=(\d+(?:\.\d+)?)S_0/);
        if (side && ratio && Number(ratio[1]) > 1) result.equilateralArea = equilateralAreaEnvelope(Number(side[1]), Number(ratio[1]));
    }
    if (/第二象限/.test(stem) && /PAO/.test(stem) && /AOB/.test(stem) && /相似/.test(stem)) {
        const a = stem.match(/A\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/), b = stem.match(/B\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/);
        if (a && b) result.similarity = similarTrianglesInSecondQuadrant([Number(a[1]),Number(a[2])],[Number(b[1]),Number(b[2])]);
    }
    const compact=stem.replace(/[{}\s]/g,'');
    if(/M在y轴的?非负半轴/.test(compact)&&/N在x轴上运动/.test(compact)&&/Q为线段MN的中点/.test(compact)) {
        const total=compact.match(/OM\+ON=(\d+(?:\.\d+)?)/);if(total&&Number(total[1])>0)result.midpointPath=midpointAxisPath(Number(total[1]));
    }
    if (/中位数|众数/.test(stem)) {
        const lists = [...stem.matchAll(/-?\d+(?:\.\d+)?(?:\s*[、,，]\s*-?\d+(?:\.\d+)?){2,}/g)];
        const longest = lists.sort((a, b) => b[0].length - a[0].length)[0];
        if (longest) {
            const data = longest[0].split(/[、,，]/).map(Number), description = describeData(data);
            result.statistics = { data, ...description };
            if (/去掉/.test(stem)) {
                const choices = [...query.matchAll(/(?:^|\n)([A-D])[.．]\s*([^\n]+)/g)];
                result.removals = choices.flatMap(match => {
                    const numbers = match[2]!.replace(/\$/g, '').match(/-?\d+(?:\.\d+)?/g)?.map(Number);
                    if (!numbers || numbers.length !== 2) return [];
                    const remaining = [...data];
                    for (const number of numbers) { const index = remaining.indexOf(number); if (index < 0) return []; remaining.splice(index, 1); }
                    if (!remaining.length) return [];
                    const next = describeData(remaining);
                    return [{ choice: match[1], removed: numbers, ...next, medianUnchanged: next.median === description.median,
                        modesUnchanged: JSON.stringify(next.modes) === JSON.stringify(description.modes) }];
                });
            }
        }
    }
    return Object.keys(result).length ? result : undefined;
}
