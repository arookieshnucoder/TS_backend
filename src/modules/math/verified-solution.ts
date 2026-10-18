import { deterministicChecks, describeData, subtractionStructures, equilateralAreaEnvelope, similarTrianglesInSecondQuadrant, midpointAxisPath } from './checks.js';
import { normalizeMath } from './normalize.js';
/** 根据当前题目条件由程序计算的结果，明确记录计算方法及来源。 */
export interface VerifiedMathSolution { method: string; answer: string; content: string; source: 'computed_from_current_question'; }
/** A bounded arithmetic parser for numeric choices. No eval, JS execution or golden answers. */
export function numericOption(input: string): number | undefined {
    const text=normalizeMath(input);if(text.length>512)return undefined;
    let index=0,depth=0;
    const space=()=>{while(/\s/.test(text[index]??'')&&index<text.length)index++;};
    function group():number {space();const open=text[index++];if(open!=='{'&&open!=='(')throw new Error('group');const value=expression();space();if(text[index++]!==(open==='{'?'}':')'))throw new Error('close');return value;}
    function atom():number {
        if(++depth>32)throw new Error('depth');space();let value:number;
        if(text[index]==='{'||text[index]==='(')value=group();
        else if(text.startsWith('\\frac',index)){index+=5;const numerator=group(),denominator=group();if(!denominator)throw new Error('zero');value=numerator/denominator;}
        else if(text.startsWith('\\sqrt',index)||text[index]==='√'){index+=text[index]==='√'?1:5;value=Math.sqrt(atom());}
        else if(text.startsWith('\\pi',index)||text[index]==='π'){index+=text[index]==='π'?1:3;value=Math.PI;}
        else {const number=text.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);if(!number)throw new Error('number');index+=number[0].length;value=Number(number[0]);}
        depth--;if(!Number.isFinite(value))throw new Error('finite');return value;
    }
    function power():number {let value=atom();space();if(text[index]==='^'){index++;value=value**unary();}return value;}
    function unary():number {space();if(text[index]==='+'||text[index]==='-'){const sign=text[index++];return(sign==='-'?-1:1)*unary();}return power();}
    const startsAtom=()=>/[\d.({√π]/.test(text[index]??'')||text.startsWith('\\sqrt',index)||text.startsWith('\\frac',index)||text.startsWith('\\pi',index);
    function term():number {let value=unary();for(;;){space();if(text[index]==='*'||text[index]==='×'){index++;value*=unary();}else if(text.startsWith('\\times',index)){index+=6;value*=unary();}
        else if(text[index]==='/'){index++;const d=unary();if(!d)throw new Error('zero');value/=d;}else if(startsAtom())value*=unary();else return value;}}
    function expression():number {let value=term();for(;;){space();if(text[index]==='+'){index++;value+=term();}else if(text[index]==='-'){index++;value-=term();}else return value;}}
    try{const value=expression();space();return index===text.length&&Number.isFinite(value)?value:undefined;}catch{return undefined;}
}
export function verifiedSolution(query:string):VerifiedMathSolution|undefined {
    const choices=[...query.matchAll(/(?:^|\n)([A-D])[.．]\s*([^\n]+)/g)];
    if(choices.length!==4||new Set(choices.map(c=>c[1])).size!==4)return undefined;
    let checks:Record<string,unknown>|undefined;try{checks=deterministicChecks(query);}catch{return undefined;}if(!checks)return undefined;
    const stem=query.split(/\nA[.．]/)[0]!.replace(/\$/g,'').replace(/[{}\s]/g,'');
    const select=(target:number)=>{const matches=choices.filter(c=>{const n=numericOption(c[2]!);return n!==undefined&&Math.abs(n-target)<1e-8*Math.max(1,Math.abs(target));});return matches.length===1?matches[0]![1]:undefined;};
    let choice:string|undefined,method='',steps:string[]=[];
    if(checks.similarity&&/三角形个数|三角形的个数/.test(stem)) {
        const c=checks.similarity as ReturnType<typeof similarTrianglesInSecondQuadrant>;choice=select(c.count);method='相似三角形六种对应的距离核验';
        steps=[`A(${c.a.join(',')})，B(${c.b.join(',')})，O(0,0)。以固定边AO分别对应参考三角形的三条边，枚举其余两边的两种对应。`,
            `分别求PA、PO对应距离圆的交点，只保留x<0且y>0的点并去重：${c.points.map(p=>`(${p.map(n=>Number(n.toFixed(6))).join(',')})`).join('、')}。`,
            `这些点代回均满足三边成比例，得到${c.count}个相似三角形；坐标轴上的点不属于第二象限。`];
    } else if(checks.equilateralArea&&/OP.*最小值/.test(stem)) {
        const c=checks.equilateralArea as ReturnType<typeof equilateralAreaEnvelope>;choice=select(c.minimumDistance);method='等边三角形外部面积约束';
        const coefficient=c.side/2;
        steps=[`等边三角形的高h=${coefficient}√3，中心到边的距离为h/3。设三块面积之和为kS₀，这里k=${c.ratio}。`,
            `P在一条边外侧时，外侧面积为(k-1)S₀/2，故P到该边的垂距为(k-1)h/2；OP至少为h/3+(k-1)h/2。`,
            `沿该边中点的外法线可取等号；越过两条边的情形下最小距离为(3k+1)h/6，更大。因此最小值为(3k-1)h/6=${c.minimumDistanceAsSqrt3.replace('*sqrt(3)','√3')}。`];
    } else if(checks.midpointPath&&/Q.*运动路径.*长/.test(stem)) {
        const c=checks.midpointPath as ReturnType<typeof midpointAxisPath>;choice=select(c.length);method='坐标轴中点轨迹';
        steps=[`设M(0,m)、N(n,0)，m≥0。由OM+ON=${c.total}，得m+|n|=${c.total}。`,
            `中点Q(x,y)=(n/2,m/2)，故|x|+y=${c.total/2}且y≥0。因此-${c.total/2}≤x≤${c.total/2}，两侧都是有限线段。`,
            `轨迹顶点为${c.vertices.map(p=>`(${p.join(',')})`).join('、')}，两段长度各为${c.total/2}√2，总长${c.total}√2。`];
    } else if(checks.removals&&/去掉.*中位数.*众数.*保持不变/.test(stem)) {
        const rows=checks.removals as {choice:string;removed:number[];medianUnchanged:boolean;modesUnchanged:boolean;sorted:number[];median:number;modes:number[]}[];
        const valid=rows.filter(r=>r.medianUnchanged&&r.modesUnchanged);if(valid.length===1){choice=valid[0]!.choice;method='统计量与重复值删除核验';
            const c=checks.statistics as ReturnType<typeof describeData>&{data:number[]},r=valid[0]!;
            steps=[`原数据排序为${c.sorted.join('、')}，中位数${c.median}，众数${c.modes.join('、')}。`,
                `按每个选项逐一删除指定的两次观测值，再排序和计数。只有删除${r.removed.join('和')}后，两项统计量均不变。`,
                `剩余数据${r.sorted.join('、')}，中位数${r.median}，众数${r.modes.join('、')}。出现频次全为1时无众数，不能误认为众数保持不变。`];}
    } else if(checks.subtraction&&/至少存在一种.*运算结果与原多项式相等/.test(stem)&&/不存在任何.*运算结果与原多项式之和为0/.test(stem)) {
        const claim=stem.match(/共有(\d+)种不同运算结果/);
        if(claim){const c=checks.subtraction as ReturnType<typeof subtractionStructures>;
            const truths=[c.originalReachable,!c.negativeOriginalReachable,c.count===Number(claim[1])];choice=select(truths.filter(Boolean).length);method='连减式括号组合穷举';
            steps=[`枚举所有减法括号树并合并相同的系数向量，得到${c.count}种不同结果。首项${c.variables[0]}的系数始终为+1。`,
                `①原式${c.originalReachable?'可':'不可'}由逐步左结合括号得到；②任意结果与原式相加，首项系数为2，不能恒等于0，所以“不存在”的表述正确。`,
                `③题目声称${claim[1]}种，实际为${c.count}种，该表述${truths[2]?'正确':'错误'}。共有${truths.filter(Boolean).length}个正确结论。`];}
    }
    if(!choice)return undefined;
    return{method,answer:choice,source:'computed_from_current_question',content:`${steps.map((s,i)=>`${i+1}. ${s}`).join('\n')}\n\n答案：${choice}`};
}
