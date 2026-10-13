import { writeFile } from "node:fs/promises";
import { loadCorpus } from "../src/modules/math/corpus.js";
import { renderQuestion } from "../src/modules/math/contracts.js";
import { GlmModel } from "../src/infrastructure/llm/glm-model.js";
const corpus = await loadCorpus("evals/math/corpus.json");
const model = new GlmModel({ llmApiKey: process.env.LLM_API_KEY, llmModel: "glm-4.7", llmBaseUrl: process.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4", llmTimeoutMs: 120000 });
// Only knowledge examples are enriched. Development/test answers never enter the vector database.
for (let i = 0; i < corpus.knowledge.length; i += 5) {
    const batch = corpus.knowledge.slice(i, i + 5).filter(q => !q.solution);
    if (!batch.length) continue;
    const result = await model.turn([{ role: "system", content: "你是初中数学教研教师。为给出的例题写严谨的独立解析，包含关键计算、解法、易错点。核对提供的参考答案，若有歧义直接说明。只返回JSON数组，每项{id,solution}；solution不超过220字。不改题目条件。" },
        { role: "user", content: JSON.stringify(batch.map(q => ({ id: q.id, question: renderQuestion(q), referenceAnswer: q.answer }))) }], [], undefined, 4096);
    const parsed = JSON.parse(result.content.replace(/^```(?:json)?\s*|\s*```$/g, "")) as { id: string; solution: string }[];
    if (!Array.isArray(parsed) || parsed.length !== batch.length || new Set(parsed.map(p => p.id)).size !== batch.length) throw new Error("Invalid enrichment output");
    for (const item of parsed) {
        const q = batch.find(q => q.id === item.id);
        if (!q || typeof item.solution !== "string" || item.solution.length < 15 || item.solution.length > 1200) throw new Error("Invalid solution card");
        q.solution = item.solution; q.solutionOrigin = "glm-4.7";
    }
    await writeFile("evals/math/corpus.json", JSON.stringify(corpus, null, 2));
    console.log(`Solutions ${Math.min(i + 5, corpus.knowledge.length)}/${corpus.knowledge.length}`);
}
// Reviewed corrections to wording in generated explanations; original questions and gold choices stay intact.
const reviewed: Record<string, string> = {
    "008": "正方体有6个面，平面截面每条边对应一个面，故非退化截面至多6条边，不可能是七边形。球的非退化平面截面是圆；棱柱截面是多边形；平行圆锥底面的截面可为圆。按初中截面约定选A。",
    "022": "设两班男生分别为x、y人，x+y=30。(1)班女生38-x人，比(2)班男生多38-x-y=8人，故选A。这个结论来自两班人数及男生总人数，无须额外假设男生分布。",
    "030": "分式的分母含字母；常数π不作未知字母处理。六个式子中，(x+3)/x、(a+b)/(a-b)、(x-y)/m的分母含字母，共3个，选B。其余分母2、π、4均为常数。",
    "035": "A：√2与√5不是同类二次根式，不能合并成√7。B：2√2×2√3=4√6。C：3√2-√2=2√2。D：√27÷√3=√9=3，正确，选D。注意乘法要同时计算系数与根号内的数。",
    "042": "掷均匀硬币可能出现正面，①正确。抽普通扑克牌的点数可能是3，也可能不是3，抽到3是随机事件，不能说一定为3，②错误。只有①正确，选A。注意随机事件不等于不可能事件。",
    "063": "合并同类项只相加减系数，字母及指数不变。A应为4x；B的x²和x³不是同类项；C：-4b+b=(-4+1)b=-3b，正确；D两项不是同类项。选C。",
    "069": "反比例函数y=6/x满足xy=6>0，x与y同号，所以图象位于第一、第三象限。本题对应选项B。相似题选项顺序可能不同，应比较选项内容而非复制字母。",
    "071": "x²-x=x(x-1)=0，得到x=0或x=1。本题有两个不同的实根，选项A、B均漏根，D符号错误，选C。切勿直接除以x而遗漏x=0；一般一元二次方程也可能没有实根。",
    "082": "平行要求两条直线没有公共点。P在直线OA外时，过P有且仅有一条平行于直线OA的直线；P在直线OA上时，没有这样的平行线。故有一条或不存在，选D。分类时应看直线OA，而非仅看射线OA。",
    "085": "0.25=1/4，因此0.25^2013×4^2015=4^(2015-2013)=4²=16，选C。注意同底数幂相乘指数相加、相除指数相减。",
    "120": "A项已有分母c，隐含c≠0，两边同乘c得a=b。B项c可能为0，不能除以c；C项平方相等仅得a=±b；D项应得x=-18。选A。等式两边同乘同一个数仍相等，但同除时除数不能为0。",
    "128": "相反数为原数的负值：-(-3/7)=3/7，选A。倒数为-7/3，不能与相反数混淆。",
};
for (const q of corpus.knowledge) if (reviewed[q.id.slice(-3)]) q.solution = reviewed[q.id.slice(-3)]!;
await writeFile("evals/math/corpus.json", JSON.stringify(corpus, null, 2));
