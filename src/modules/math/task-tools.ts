import { defineReadOnlyTool, stringParameter } from "../harness/define-tool.js";
import { deterministicChecks } from "./checks.js";
import { arithmeticChecks, calculate } from "./arithmetic.js";
import { ToolInputError } from "../harness/tool-contracts.js";

/** Split only explicit independent question boundaries. Subparts (1)/(2) share constraints. */
export function splitMathTasks(text: string): string[] {
    const parts=text.split(/\n(?=(?:第\s*(?:\d+|[一二三四五六七八九十]+)\s*题|题\s*(?:\d+|[一二三四五六七八九十]+)\s*[：:]|Q\d+\s*[：:]))/i).map(t=>t.trim()).filter(Boolean);
    if(parts.length>8)throw new Error("At most eight independent questions per request; split this batch");
    return parts;
}
export function analyzeMath(text: string) {
    const constraints=text.split(/[。；\n]/).filter(s=>/不放回|放回|非负|大于|小于|范围|定义域|不为零|更正|改为|同时|停止|边界|对应|不存在|不正确/.test(s)).map(s=>s.trim()).slice(0,20);
    // Restricted parser, no eval/code execution. Supports literal numeric quadratic equations only.
    const m=text.match(/(?<![a-z\d.+-])(-?(?:\d+(?:\.\d+)?)?)x(?:²|\^2)\s*([+-]\d+(?:\.\d+)?)x\s*([+-]\d+(?:\.\d+)?)\s*=\s*0/);
    let quadratic:Record<string,unknown>|undefined;
    if(m){const a=m[1]===""?1:m[1]==="-"?-1:Number(m[1]),b=Number(m[2]),c=Number(m[3]),precision=Math.max(...m.slice(1,4).map(v=>v?.split(".")[1]?.length??0));
        if(a!==0&&precision<=6&&[a,b,c].every(n=>Number.isFinite(n)&&Math.abs(n)<=1e6)){const scale=10**precision,[aa,bb,cc]=[a,b,c].map(n=>BigInt(Math.round(n*scale))),exact=bb!*bb!-4n*aa!*cc!,d=Number(exact)/(scale*scale);
            quadratic={coefficients:[a,b,c],discriminant:d,realRoots:d<0?[]:[(-b-Math.sqrt(d))/(2*a),(-b+Math.sqrt(d))/(2*a)],rootSum:-b/a,rootProduct:c/a,method:"literal quadratic formula; confirm equation and domain before use"};}}
    const roof=text.match(/y=-\(x-(\d+(?:\.\d+)?)\)(?:²|\^2)\+(\d+(?:\.\d+)?)/),width=text.match(/车宽(\d+(?:\.\d+)?)米/),height=text.match(/车高(\d+(?:\.\d+)?)米/);
    let clearance:Record<string,unknown>|undefined;
    if(roof&&width&&height&&/车顶.*水平/.test(text)&&!/车顶.*不.*水平/.test(text)) {
        const h=Number(roof[1]),k=Number(roof[2]),w=Number(width[1]),y=Number(height[1]);
        if([h,k,w,y].every(Number.isFinite)&&h<=1e6&&k<=1e12&&w<=1e6&&k>=y&&w>0){const radius=Math.sqrt(k-y),margin=radius-w/2;clearance={squaredBound:k-y,squareRoot:radius,halfWidth:w/2,
            centerInterval:margin<0?[]:[h-margin,h+margin],method:"For y=-(x-h)^2+k and a horizontal car roof of width w, intersect |c±w/2-h|≤sqrt(k-height). Verify all assumptions."};}
    }
    return {tasks:splitMathTasks(text).map((q,i)=>({number:i+1,characters:q.length,preview:q.slice(0,180)})),constraints,checks:deterministicChecks(text),quadratic,clearance,arithmetic:arithmeticChecks(text),
        notice:"只检查明确支持的算式；未返回的检查未执行。每个子问仍需独立推导，不能沿用例题数字或答案。"};
}
export function mathAnalyzeTool() {return defineReadOnlyTool({name:"math_analyze",description:"拆分显式多题边界、保留长题条件，并对字面数字二次方程和支持题型执行确定性检查；无代码执行。",
    parameters:{query:stringParameter(12000)},execute:async({query},signal)=>{signal?.throwIfAborted();return JSON.stringify(analyzeMath(query));}});}
export function mathCalculateTool(){return defineReadOnlyTool({name:"math_calculate",description:"计算明确的数值算式。支持+ - * / ^、括号、sqrt、abs和pi；不支持变量、代码或属性访问。用于独立核对乘积、平方根、分母和符号。",
    parameters:{expression:stringParameter(256)},execute:async({expression},signal)=>{signal?.throwIfAborted();try{return JSON.stringify({expression,value:calculate(expression),method:"restricted arithmetic parser"});}catch{throw new ToolInputError("Invalid or unsupported arithmetic expression or real domain");}}});}
