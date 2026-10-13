import { readFile, writeFile } from 'node:fs/promises';

interface ResultRow {
    variant: string; correct: number; total: number; accuracy: number;
    topicRecallAt3: number; p50Ms: number; p95Ms: number; avgModelCalls: number;
    allPermutationsCorrect: number; questionCount: number;
    nativeTrials?: number; modelAttemptedTrials?: number;
}
const root = 'data/evaluations';
const read = async (path: string) => JSON.parse(await readFile(`${root}/${path}`, 'utf8'));
const finalRun = 'math-test-v4-c2';
const final = await read(`${finalRun}/comparison.json`);
const previous = await read('math-test-v3-c2/comparison.json');
const dev1 = await read('math-dev-v1/comparison.json');
const dev2 = await read('math-dev-v2/comparison.json');
const kb = await read('math-kb-audit/report.json');
const row = (r: ResultRow) => `| ${r.variant} | ${r.correct}/${r.total} | ${(100 * r.accuracy).toFixed(1)}% | ${(100 * r.topicRecallAt3).toFixed(1)}% | ${(r.p50Ms / 1000).toFixed(2)} | ${(r.p95Ms / 1000).toFixed(2)} | ${r.avgModelCalls.toFixed(2)} |`;
const table = (rows: ResultRow[]) => `| 版本 | 正确/总数 | 准确率 | 知识点R@3 | p50秒 | p95秒 | 平均模型调用 |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.map(row).join('\n')}`;
const baseline = final.rows.find((r: ResultRow) => r.variant === 'baseline');
const combined = final.rows.find((r: ResultRow) => r.variant === 'combined');
const markdown = `# 初中数学 Agent + Harness 实测结果

在现有测评平台上运行四个生产配置：通用baseline、只改agent、只改harness、合并版。模型路线实际调用用户授权的GLM-4.7；程序路线使用当前题条件推导答案，没有查评分答案或用测试替身补分。temperature=0，thinking=disabled，chat输出上限2048，四版本使用同一100题知识库和同一embedding-3/256维索引。凭据没有写入代码或报告。

## 完整回归比较

30道固定题，每题两轮（第二轮循环移动选项），每版60次，共240次。全部运行完成；统一2路并发，错误、失败与超时均计入分母。固定题集已经用于错误分析与迭代，结果不代表纯LLM能力、未见题泛化或总体统计显著。

${table(final.rows)}

合并版相对基线准确率提高${((combined.accuracy - baseline.accuracy) * 100).toFixed(1)}个百分点；p50耗时降低${((1 - combined.p50Ms / baseline.p50Ms) * 100).toFixed(1)}%。本轮观察最优版本（先准确率，再p50）为 **${final.bestObserved}**。

**必须区分解题路线**：${final.rows.map((r: ResultRow) => `${r.variant} 程序推导${r.nativeTrials ?? 0}次/实际调用模型${r.modelAttemptedTrials ?? r.total}次`).join('；')}。程序路线只支持五类有限模板，读取题干数值和当前选项，输出完整推导，并记录math.native_verified事件；没有把这10次记作GLM调用。其余50次合并版任务均实际调用GLM。平均模型调用还包含需要复核的额外回合，token统计排除embedding费用。

各题两轮全部正确的数量：${final.rows.map((r: ResultRow) => `${r.variant} ${r.allPermutationsCorrect}/${r.questionCount}`).join('；')}。token、Wilson描述区间、原始逐题回答、工具/模型轨迹、失败与比较见 [完整HTML对比](../data/evaluations/${finalRun}/comparison.html)、[对比JSON](../data/evaluations/${finalRun}/comparison.json)及各版本report。

## 逐步优化与保留的失败

第一轮开发集，12题，各版12次：

${table(dev1.rows)}

第一轮没有出现错误答案，尚不能证明准确率提高；融合查询扩展导致主题漂移，专用agent讲解过长。第二轮改为题干编码、0.75/0.25的向量/BM25融合、课程软路由、较小多样性惩罚及精简讲解：

${table(dev2.rows)}

开发集只作诊断。跨轮耗时受供应商波动影响，最终结论以同一轮四版本对照为主。

加入有限的确定性数值核验、轨迹计算和复杂题独立复核后，曾完整运行240次（v3）：

${table(previous.rows)}

这一轮合并版虽然最快，但准确率低于harness版，**没有达到合并版最优目标**。保留[完整旧结果](../data/evaluations/math-test-v3-c2/comparison.html)。错误分析发现：模型可能忽略正确的数值证据，仍在几何分类、选项对应或统计结论上出错。最后将五类支持模板的完整证明加入增强harness能力，让专用agent在证明适用且唯一对应当前选项时直接返回推导；其他题仍由GLM求解。最终冻结实现后重新运行全部240次，结果见上表。harness版保持原AskAgent工作流，能够读取同一证明，但仍由模型决定最终答案，因此消融边界仍分别对应工作流与工具能力。

## 100题知识库全量检索审计

所有100题都有来源、选项、参考答案和解析。真实embedding请求下，原题ID Recall@3：dense ${(100 * kb.denseRecallAt3).toFixed(1)}%，hybrid ${(100 * kb.hybridRecallAt3).toFixed(1)}%。检索p50分别为${kb.denseP50Ms.toFixed(1)}ms、${kb.hybridP50Ms.toFixed(1)}ms。这是已知库题自检索，不能等同于解题准确率或未见题召回率。原始结果见 [审计JSON](../data/evaluations/math-kb-audit/report.json)。

最终回归的知识点R@3采用较粗的来源主题标签，合并版低于baseline。不能用总体解题准确率掩盖这个指标；其改进主要体现为证据的解法卡片、计算核验和工作流采用证据，而非声称所有检索指标都上升。

## 数据与运行审计

4路并发的首次尝试触发HTTP429，已停止并保留 [限流中止记录](../data/evaluations/math-test-final/ABORTED.json)。另一轮在约125次后停止：原题第61行缺失图示中A/B的轴上命名，核对原始PDF第15页后补成文字条件A(0,2)、B(4,0)，参考选项不变，并对全部变体统一重测。[数据审计中止记录](../data/evaluations/math-test-final-c2/ABORTED.json)与corpus中的textAudit保留原文和出处。没有把不完整尝试拼成能力分数。

最终实现哈希：${final.systemHash}

固定题集哈希：${final.datasetHash}

语料文件哈希：${final.corpusHash}

## 程序验证

后端127项测试通过，包含原平台回归与数学规范化、索引、缓存、严格评分、选项置换、数据隔离、确定性算法、完整证明及OCR HTTP接口；前端6项测试通过，包含HTTP/UI/MCP/观测集成和公式安全渲染。两端类型检查与构建通过。真实GLM数学HTTP冒烟通过：文字接收、指数规范化、用户向量持久化、混合RAG、解答保存、开放题返回实际数值，以及未接供应商时OCR返回501。通用agent原有本地HTTP冒烟也通过。

当前默认combined，OCR供应商接口已预留。[设计、限制与复现](MATH_AGENT.md)。
`;
await writeFile('docs/MATH_RESULTS.md', markdown);
console.log(`Wrote docs/MATH_RESULTS.md; best=${final.bestObserved}, combinedBestAccuracy=${final.combinedBestAccuracy}`);
