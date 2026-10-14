/** Restricted arithmetic parser: no eval, Function, property access, or executable input. */
export function calculate(expression:string):number {
    if(!expression.trim()||expression.length>256)throw new Error("Invalid arithmetic expression");
    const text=expression.replace(/\s+/g,"");let pos=0,nodes=0,depth=0;
    const finite=(x:number)=>{if(!Number.isFinite(x))throw new Error("Arithmetic outside finite real domain");return x;};
    function primary():number {
        if(++nodes>100||++depth>24)throw new Error("Arithmetic complexity limit");
        let result:number;
        if(text[pos]==="("){pos++;result=sum();if(text[pos++]!==")")throw new Error("Unclosed parenthesis");}
        else {const num=text.slice(pos).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);if(num){pos+=num[0].length;result=Number(num[0]);}
            else {const name=text.slice(pos).match(/^[a-z]+/i)?.[0]?.toLowerCase();if(!name)throw new Error("Expected a number");pos+=name.length;
                if(name==="pi")result=Math.PI;
                else {if(!["sqrt","abs"].includes(name)||text[pos++]!=="(")throw new Error("Unsupported arithmetic function");const x=sum();if(text[pos++]!==")")throw new Error("Unclosed function");result=name==="sqrt"?Math.sqrt(x):Math.abs(x);}
            }}
        depth--;return finite(result);
    }
    function power():number {const x=primary();if(text[pos]==="^"){pos++;const y=unary();if(x===0&&y<=0)throw new Error("Undefined zero power");return finite(x**y);}return x;}
    function unary():number {if(text[pos]==="+"||text[pos]==="-"){const negative=text[pos++]==="-";return (negative?-1:1)*unary();}return power();}
    function product():number {let x=unary();while(text[pos]==="*"||text[pos]==="/"){const op=text[pos++],y=unary();if(op==="/"&&y===0)throw new Error("Division by zero");x=finite(op==="*"?x*y:x/y);}return x;}
    function sum():number {let x=product();while(text[pos]==="+"||text[pos]==="-"){const op=text[pos++],y=product();x=finite(op==="+"?x+y:x-y);}return x;}
    const value=sum();if(pos!==text.length)throw new Error("Unsupported arithmetic syntax");return finite(value);
}
export function reducedFraction(numerator:number,denominator:number) {
    if(!Number.isSafeInteger(numerator)||!Number.isSafeInteger(denominator)||denominator===0)throw new Error("Unsupported rational arithmetic");
    const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a,d=gcd(Math.abs(numerator),Math.abs(denominator)),sign=denominator<0?-1:1;
    return {numerator:numerator,denominator,exact:denominator/d===1?String(sign*numerator/d):`${sign*numerator/d}/${Math.abs(denominator)/d}`,decimal:numerator/denominator};
}
/** All formulas derived from literal inputs, no corpus lookup or answer letters. */
export function arithmeticChecks(text:string):Record<string,unknown> {
    const result:Record<string,unknown>={};
    const balls=text.match(/(?:袋中|袋子中).*?有(\d+)个红球[、，,和]+(\d+)个白球/);
    if(balls){const red=Number(balls[1]),white=Number(balls[2]),total=red+white;
        if(total>1&&red>0&&white>0&&total<=1000000){result.ballProbabilities={counts:{red,white,total},
            withoutReplacementTwoRed:reducedFraction(red*(red-1),total*(total-1)),withReplacementTwoRed:reducedFraction(red*red,total*total),
            withoutReplacementDifferentColors:reducedFraction(2*red*white,total*(total-1)),redAfterWhite:reducedFraction(red,total-1),
            applicability:"Uniform random identical balls; two draws. Select the formula for the stated experiment and subquestion. These are separate events, not interchangeable answers."};}
    }
    const rectangle=text.match(/矩形面积为(\d+(?:\.\d+)?)/),difference=text.match(/长比宽多(\d+(?:\.\d+)?)/);
    if(rectangle&&difference&&!/不是矩形|并非矩形/.test(text)){const area=Number(rectangle[1]),d=Number(difference[1]);if(area>0&&area<=1e12&&d>=0&&d<=1e6)result.rectangle={area,difference:d,width:(-d+Math.sqrt(d*d+4*area))/2,method:"x(x+d)=area, width x>0"};}
    const growth=text.match(/去年有(\d+)人.*?连续两年.*?增长(\d+(?:\.\d+)?)%/);
    if(growth){const base=Number(growth[1]),r=Number(growth[2])/100;if(base<=1e12&&r<=100)result.growth={base,rate:r,periods:2,result:Number((base*(1+r)**2).toPrecision(12)),method:"compound growth, base*(1+rate)^periods"};}
    const cost=text.match(/进货价每本(\d+(?:\.\d+)?)元/),basePrice=text.match(/售价为(\d+(?:\.\d+)?)元时每天销量为(\d+)本/);
    if(cost&&basePrice&&/每提高1元.*?减少1本/.test(text)) {const c=Number(cost[1]),p=Number(basePrice[1]),q=Number(basePrice[2]),axis=(p+q+c)/2;
        if([c,p,q].every(x=>Number.isFinite(x)&&x>=0&&x<=1e6)&&c<=p+q)result.profit={cost:c,referencePrice:p,referenceSales:q,priceDomain:[c,p+q],optimalPrice:axis,maximumProfit:(axis-c)*(p+q-axis),method:"sales=p0+q0-price; profit=(price-cost)*sales; check axis lies in price domain"};}
    const legs=text.match(/AB=(\d+(?:\.\d+)?)厘米、AC=(\d+(?:\.\d+)?)厘米/),speeds=text.match(/P从A沿AB.*?每秒(\d+(?:\.\d+)?)厘米.*?Q同时从C沿CA.*?每秒(\d+(?:\.\d+)?)厘米/);
    if(legs&&speeds&&/∠A=90/.test(text)){const ab=Number(legs[1]),ac=Number(legs[2]),v=Number(speeds[1]),u=Number(speeds[2]);
        if([ab,ac,v,u].every(x=>Number.isFinite(x)&&x>0&&x<=1e6)){const end=Math.min(ab/v,ac/u),t=Math.min(end,ac/(2*u));result.movingArea={timeDomain:[0,end],areaCoefficients:[-v*u/2,v*ac/2,0],maxTime:t,maxArea:v*t*(ac-u*t)/2,endpointAreas:[0,v*end*(ac-u*end)/2],method:"AP=v*t, AQ=AC-u*t, S=AP*AQ/2; restrict to both line segments"};}}
    const radius=text.match(/半径(?:为)?(\d+(?:\.\d+)?)(?:米|，)/),distance=text.match(/OP=(\d+(?:\.\d+)?)米/),modelSide=text.match(/与OA对应的边长为(\d+(?:\.\d+)?)米/);
    if(radius&&distance&&modelSide&&/切线PA/.test(text)&&/模型.*相似/.test(text)){const r=Number(radius[1]),d=Number(distance[1]),side=Number(modelSide[1]);
        if(r>0&&d>r&&side>0&&[r,d,side].every(x=>x<=1e6)){const tangent=Math.sqrt(d*d-r*r),area=r*tangent/2,ratio=side/r;result.tangentSimilarity={radius:r,centerDistance:d,tangent,originalArea:area,sideRatio:ratio,modelArea:area*ratio*ratio,method:"radius is perpendicular to tangent; use Pythagoras; area scales by side ratio squared"};}}
    return result;
}

/** Complete native route only for an unambiguous two-red-ball event with explicit counts. */
export function verifiedProbability(text:string) {
    const stem=text.split(/\nA[.．]/)[0]!;
    if(stem.length>300||!/两球都是红球的概率/.test(stem)||!/(?:连续|取).*?2球/.test(stem)||!/随机/.test(stem)||!/大小相同|完全相同|等可能/.test(stem)||/不正确|不是|并非随机|非随机|不等可能|权重|不均匀|概率不同|指定|\([1-9]\)|第[2-9]题|已知甲/.test(stem))return undefined;
    const checks=arithmeticChecks(stem),p=checks.ballProbabilities as {counts:{red:number;white:number;total:number};withoutReplacementTwoRed:ReturnType<typeof reducedFraction>;withReplacementTwoRed:ReturnType<typeof reducedFraction>}|undefined;
    if(!p)return undefined;const noReplacement=/不放回/.test(stem),withReplacement=/有放回/.test(stem);if(noReplacement===withReplacement)return undefined;
    const probability=noReplacement?p.withoutReplacementTwoRed:p.withReplacementTwoRed;
    const options=[...text.matchAll(/(?:^|\n)([A-D])[.．]\s*([^\n]+)/g)];
    let final=probability.exact;
    if(options.length){if(options.length!==4)return undefined;const matches=options.filter(m=>{const f=m[2]!.trim().match(/^(\d+)(?:\/(\d+))?$/);if(!f)return false;return BigInt(f[1]!)*BigInt(probability.denominator)===BigInt(probability.numerator)*BigInt(f[2]??"1");});if(matches.length!==1)return undefined;final=matches[0]![1]!;}
    const {red,total}=p.counts;return {content:`${noReplacement?"不放回":"有放回"}抽取：第一次取红球的概率为${red}/${total}，第二次为${noReplacement?red-1:red}/${noReplacement?total-1:total}。\n相乘得到 ${probability.numerator}/${probability.denominator}=${probability.exact}，以整数分数约分核验。\n答案：${final}`,method:"exact-rational-two-draw-probability",source:"literal user counts; no corpus answer lookup"};
}
