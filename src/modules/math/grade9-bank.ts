import { hash, validateCorpus } from "./corpus.js";
import type { MathCorpus, MathQuestion } from "./contracts.js";

type Item = { question: string; correct: string; wrong: string[]; solution: string; skills: string[] };
const n = (x: number) => Number(x.toFixed(6)).toString();
const fraction = (a: number, b: number): string => { const gcd = (x: number, y: number): number => y ? gcd(y, x % y) : x; const d = gcd(a, b); return `${a / d}/${b / d}`; };

const standard: Record<string, (t: number) => Item> = {
    roots(t) { const a=t+1,b=t+4; return {question:`解一元二次方程 x²-${a+b}x+${a*b}=0，根是（ ）`,correct:`${a}和${b}`,wrong:[`${-a}和${-b}`,`${a}和${-b}`,`${a+1}和${b}`],solution:`因式分解为(x-${a})(x-${b})=0，分别代回检验。`,skills:["quadratic-equation","factorization"]}; },
    discriminant(t) { const b=2*(t+1),c=(t+1)**2+t; return {question:`方程 x²-${b}x+${c}=0 的判别式是多少？`,correct:`${b*b-4*c}`,wrong:[`${b*b+4*c}`,`${4*c-b*b}`,`${b*b-4*c-4}`],solution:`Δ=b²-4ac=${b*b-4*c}。`,skills:["quadratic-equation","discriminant"]}; },
    parameter(t) { const b=2*t+4; return {question:`关于x的方程 x²-${b}x+m=0 有两个相等的实数根，m等于多少？`,correct:`${b*b/4}`,wrong:[`${b*b}`,`${b*b/4+1}`,`${-b*b/4}`],solution:`重根要求Δ=${b*b}-4m=0，m=${b*b/4}。`,skills:["quadratic-equation","discriminant"]}; },
    vieta(t) {const s=t+5,p=t+2;return {question:`方程x²-${s}x+${p}=0的两根为α、β，求α²+β²。`,correct:`${s*s-2*p}`,wrong:[`${s*s+2*p}`,`${s*s-p}`,`${2*p}`],solution:`α+β=${s}，αβ=${p}，平方和=(α+β)²-2αβ。`,skills:["quadratic-equation","vieta"]};},
    vertex(t) {const h=t+1,k=t-8;return {question:`抛物线 y=2(x-${h})²+(${k}) 的顶点坐标是（ ）`,correct:`(${h},${k})`,wrong:[`(${-h},${k})`,`(${h},${-k+1})`,`(${h},${k+2})`],solution:`顶点式y=a(x-h)²+k，顶点(h,k)。`,skills:["quadratic-function","vertex"]};},
    minimum(t) {const h=t+2,k=t+3;return {question:`函数 y=x²-${2*h}x+${h*h+k} 在全体实数上的最小值为多少？`,correct:`${k}`,wrong:[`${h*h+k}`,`${-k}`,`${k+1}`],solution:`配方y=(x-${h})²+${k}，平方非负，x=${h}时达到最小值。`,skills:["quadratic-function","vertex"]};},
    symmetry(t) {const h=t+2,x=t-3;return {question:`点(${x},7)在抛物线y=(x-${h})²+c上，它关于对称轴对称的点的横坐标是多少？`,correct:`${2*h-x}`,wrong:[`${-x}`,`${h-x}`,`${2*h-x+1}`],solution:`对称轴x=${h}，两横坐标和为${2*h}。`,skills:["quadratic-function","symmetry"]};},
    intersection(t) {const a=t+1,b=t+3;return {question:`抛物线y=(x-${a})(x-${b})与x轴两交点间的距离是多少？`,correct:`${b-a}`,wrong:[`${a+b}`,`${a*b}`,`${b-a+1}`],solution:`令y=0得横坐标${a}和${b}，距离取差的绝对值。`,skills:["quadratic-function","quadratic-equation"]};},
    growth(t) {const base=100*(t+1);return {question:`某社团去年有${base}人，连续两年每年人数增长10%。两年后人数为多少？`,correct:`${n(base*1.21)}`,wrong:[`${n(base*1.2)}`,`${n(base*1.1)}`,`${n(base*1.01)}`],solution:`连续两次乘1.1，${base}×1.1²=${n(base*1.21)}。`,skills:["quadratic-equation","growth"]};},
    rectangle(t) {const a=t+2,b=t+7;return {question:`矩形面积为${a*b}，长比宽多5。矩形的宽是多少？`,correct:`${a}`,wrong:[`${b}`,`${a+1}`,`${-b}`],solution:`设宽x>0，x(x+5)=${a*b}，根为${a}与${-b}，舍负根。`,skills:["quadratic-equation","domain"]};},
    chord(t) {const s=t+1;return {question:`圆半径为${5*s}，圆心到一条弦的距离为${3*s}。求弦长。`,correct:`${8*s}`,wrong:[`${4*s}`,`${10*s}`,`${6*s}`],solution:`垂径定理与勾股定理，半弦长√(r²-d²)=${4*s}。`,skills:["circle","chord","pythagoras"]};},
    tangent(t) {const s=t+1;return {question:`点P到圆心O距离${5*s}，圆半径${3*s}，从P作切线PT。求PT长。`,correct:`${4*s}`,wrong:[`${2*s}`,`${8*s}`,`${3*s}`],solution:`半径OT垂直PT，PT²=OP²-OT²。`,skills:["circle","tangent","pythagoras"]};},
    sector(t) {const r=t+3;return {question:`半径${r}、圆心角90°的扇形面积是（ ）`,correct:`${r*r}π/4`,wrong:[`${r*r}π/2`,`${r}π/4`,`${r*r}π`],solution:`扇形面积=90/360×πr²。`,skills:["circle","sector"]};},
    inscribed(t) {const a=40+2*t;return {question:`圆上弧AB所对圆心角为${a}°（小于180°），圆周角APB所对的是这段小弧AB，求∠APB。`,correct:`${a/2}°`,wrong:[`${a}°`,`${a/2+1}°`,`${180-a/2}°`],solution:`同弧所对的圆周角是圆心角的一半。`,skills:["circle","inscribed-angle"]};},
    similarSide(t) {const s=t+2;return {question:`△ABC∽△DEF，对应顺序如题，AB=3，DE=6，BC=${s}。求EF。`,correct:`${2*s}`,wrong:[`${s/2}`,`${2*s+1}`,`${3*s}`],solution:`相似比DE/AB=2，EF=2BC。`,skills:["similarity","ratio"]};},
    similarArea(t) {const s=t+1;return {question:`两个相似三角形的对应边长比为1:3，较小三角形面积为${s}。较大三角形面积是多少？`,correct:`${9*s}`,wrong:[`${3*s}`,`${6*s}`,`${s/9}`],solution:`面积比是边长比的平方，即1:9。`,skills:["similarity","area"]};},
    trig(t) {const s=t+2;return {question:`在Rt△ABC中，∠C=90°，AC=${4*s}，BC=${3*s}。求sin A。`,correct:"3/5",wrong:["4/5","3/4","4/3"],solution:`AB=${5*s}，sin A=BC/AB=3/5。`,skills:["trigonometry","pythagoras"]};},
    probability(t) {const r=t+2,b=t+3;return {question:`袋中有${r}个红球和${b}个白球，大小相同，随机不放回连续取2球。两球都是红球的概率是（ ）`,correct:fraction(r*(r-1),(r+b)*(r+b-1)),wrong:[fraction(r*r,(r+b)**2),fraction(r,r+b),fraction(r*(r-1),(r+b)**2)],solution:`无放回：${r}/${r+b}×${r-1}/${r+b-1}。`,skills:["probability","without-replacement"]};},
};
const long: Record<string, (t: number) => Item> = {
    bridge(t) {const h=t+4,k=h*h;return {question:`某公园要设计一座抛物线形景观桥。桥的两端位于同一水平地面，以左端为原点，水平向右为x轴，竖直向上为y轴，长度单位为米。桥面曲线为y=-(x-${h})²+${k}，只考虑桥两端之间的部分。一辆观光车在水平路面行驶，车顶始终保持水平，车宽2米、车高${k-4}米，车身关于竖直中心线对称。为避免把中心处高度误当作整车净空，请分别完成：(1)求桥的跨度与最高点；(2)设车的中心线横坐标为c，写出车顶左右角的坐标；(3)车顶及两侧恰好不碰桥（允许等号接触边界），求c所有允许值。选择第三问正确结果。`,correct:`${h-1}≤c≤${h+1}`,wrong:[`${h-2}≤c≤${h+2}`,`${h-3}≤c≤${h+3}`,`${h}≤c≤${h+2}`],solution:`跨度2h=${2*h}，最高点(${h},${k})。左右角(c±1,${k-4})。均满足(c±1-h)²≤4，两个区间取交集为[${h-1},${h+1}]。`,skills:["quadratic-function","interval","domain"]};},
    profit(t) {const cost=10+t,base=40+2*t,supply=100+t;return {question:`一家校园商店出售纪念册，进货价每本${cost}元。调查发现，当售价为${base}元时每天销量为${supply}本；售价每提高1元，日销量减少1本，降价时同样按这个线性规律增加。设售价p元，利润为销售收入减进货成本，不考虑其他费用。商店要求售价不少于进货价，销量非负。(1)写出销量q与p的关系及p的定义域；(2)写出日利润W的二次函数；(3)用配方求最大利润对应的售价，并检查该售价符合约束；(4)如果只看收入而忽略成本，会得到不同售价，请解释为何第三问要以利润函数为准。选择第三问的最优售价。`,correct:n((supply+base+cost)/2),wrong:[n((supply+base)/2),`${base}`,n((supply+base-cost)/2)],solution:`q=${supply+base}-p，${cost}≤p≤${supply+base}；W=(p-${cost})(${supply+base}-p)，对称轴p=${n((supply+base+cost)/2)}，位于定义域内。`,skills:["quadratic-function","optimization","domain"]};},
    moving(t) {const s=t+2;return {question:`在直角三角形ABC中，∠A=90°，AB=${6*s}厘米、AC=${8*s}厘米。点P从A沿AB向B匀速运动，速度为每秒${s}厘米；点Q同时从C沿CA向A匀速运动，速度为每秒${2*s}厘米。两点到达各自终点即停止，本题只研究它们均未超出线段的时段，边界时刻可以取到。连接PQ，以AP、AQ为两条直角边构成△APQ。(1)确定共同运动时间范围；(2)用t表示AP、AQ和△APQ的面积；(3)求面积最大时t的值；(4)验证该时刻是否位于第一问范围，并说明两端面积情况。选择第三问的时间（秒）。`,correct:"2",wrong:["3","4","1"],solution:`0≤t≤4，AP=${s}t，AQ=${s}(8-2t)，S=${s*s}(4t-t²)，顶点t=2；两端S=0。`,skills:["quadratic-function","moving-geometry","domain"]};},
    circleSimilarity(t) {const s=t+1;return {question:`一个圆形花坛的圆心为O，半径为${3*s}米。花坛外点P满足OP=${5*s}米，分别作切线PA、PB，A、B是切点。另有一个与直角三角形OAP相似的模型三角形，模型中与OA对应的边长为${6*s}米，顶点对应关系已经明确，模型按相同比例放大而不旋转改变对应关系。(1)说明OA与PA的位置关系；(2)求PA及△OAP的面积；(3)求模型相似比；(4)求模型的面积。解题时须区分边长比例与面积比例，并核对使用的斜边是OP。选择第四问模型面积。`,correct:`${24*s*s}`,wrong:[`${12*s*s}`,`${6*s*s}`,`${48*s*s}`],solution:`OA⊥PA，PA=${4*s}，原面积=${6*s*s}，边长比2，面积比4，模型面积=${24*s*s}。`,skills:["circle","tangent","similarity","area"]};},
    conditional(t) {const r=t+3,b=t+2;return {question:`学校举行摸球实验，袋中有${r}个红球、${b}个白球，每个球除颜色外完全相同。甲先随机取出一个球，不放回，乙随后随机取一个球，两次抽取按有序结果计算。为了比较两种实验，老师还设置另一组有放回实验，但下面的问题只针对第一组不放回实验。(1)求甲乙都取到红球的概率；(2)求两人颜色不同的概率；(3)已知甲取到白球，求乙取到红球的概率；(4)解释第三问为何不能继续使用抽取前总球数作分母。选择第三问结果，并在步骤中明确条件概率使用的是已知甲取白球后的袋中状态。`,correct:fraction(r,r+b-1),wrong:[fraction(r,r+b),fraction(r-1,r+b-1),fraction(r*b,(r+b)*(r+b-1))],solution:`两红=${fraction(r*(r-1),(r+b)*(r+b-1))}，异色=${fraction(2*r*b,(r+b)*(r+b-1))}。已取白球，红球仍${r}个、总数${r+b-1}，条件概率=${fraction(r,r+b-1)}。`,skills:["probability","without-replacement","conditional"]};},
};
function question(family: string, t: number, split: string, item: Item, hard: boolean): MathQuestion {
    const id=`g9-${split}-${family}-${t.toString().padStart(2,"0")}`, shift=t%4;
    const choices=[item.correct,...item.wrong];
    if(new Set(choices).size!==4) throw new Error(`Duplicate options: ${id}`);
    const options=[...choices.slice(shift),...choices.slice(0,shift)];
    return {id,question:item.question,options,answer:"ABCD"[(4-shift)%4]!,topic:item.skills[0]!,grade:9,family,
        difficulty:hard?"long-hard":"standard",skills:item.skills,solution:item.solution,solutionOrigin:"authored-formula",
        source:{kind:"authored",url:`urn:tspj:grade9:${id}`,dataset:"TSpj authored grade9 v2 (parameterized, formula checked)",row:t,sha256:hash(JSON.stringify(item))}};
}
/** Original locally authored practice items; never represented as sourced examination questions. */
export function grade9Corpus(): MathCorpus {
    const knowledge: MathQuestion[]=[],development: MathQuestion[]=[],test: MathQuestion[]=[];
    for(const [family,make] of Object.entries(standard)) for(let t=1;t<=25;t++) knowledge.push(question(family,t,"kb",make(t),false));
    for(const [family,make] of Object.entries(long)) for(let t=1;t<=10;t++) knowledge.push(question(family,t,"kb",make(t),true));
    // Held-out parameters, NOT unseen template families. Report this limitation explicitly.
    for(let t=31;t<=35;t++) for(const [family,make] of Object.entries(standard)) {
        const q=question(family,t,"eval",make(t),false); (t===31?development:test).push(q);
    }
    for(let t=31;t<=32;t++) for(const [family,make] of Object.entries(long)) {
        const q=question(family,t,"eval",make(t),true); (t===31?development:test).push(q);
    }
    return validateCorpus({version:1,id:"tspj-grade9-500-v2",knowledge,development,test,excluded:[]});
}
