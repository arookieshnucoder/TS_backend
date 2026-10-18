# 英语工作流优化与实测（2026-10-17）

使用 `glm-4.5-air`、`ENGLISH_WORKFLOW=grounded`、`ENGLISH_THINKING=disabled`。英语独立语义复核保持 `not_configured`，不调用 GLM-4.7，不转到其他学科。

## 完整500题回归

|集合或题型|本轮正确数|准确率|
|---|---:|---:|
|完整回归|484/500|96.8%|
|练习库部分|289/300|96.33%|
|开发集|98/100|98%|
|原测试集回归|97/100|97%|
|阅读|285/300|95%|
|语法|100/100|100%|
|完形|99/100|99%|

与原始输出经同一明确结论格式规则重判的基线相比，完整500题从467/500（93.4%）提高到484/500（96.8%），原测试集从86/100提高到97/100。完整集合含练习与开发题，不能把96.8%当成独立测试分数；原测试集已用于多轮回归，另用下述未使用的纯阅读确认集检验。

118个文章任务，445次完成模型调用、445次尝试，0次最终请求失败；输入352,166 token、输出100,481 token。按文章计延迟 p50 15.35秒、p95 39.94秒。调用与token包含批量候选、逐题工作器、分歧裁决及所有修复步骤，没有只统计父任务来低估代价。

完整记录：[本轮500题报告](data/english-grounded-500-v6/comparison.json)、[基线重判报告](data/english-experiment-glm45air-500-v1/comparison-format-v2.json)。原始回答、错题、运行清单及中间实验均保留，未覆盖旧实验。

## 最终工作流

1. Harness 按预算准备英文原文，保留段号、否定和空格。完整原文上的阅读题先生成批量候选。
2. 使用通用 `AgentRuntime.delegate` 为每道阅读题独立求解。工作器只接收原文、当前题和最新要求，不接收批量候选、其他题的答案、父会话历史、参考答案或工具权限。
3. 两个模型候选一致时收敛；分歧时仅将本题的候选选项与原文交给隔离工作器裁决。裁决失败保留逐题候选并记录事件。子任务不递归，每轮最多32次委派，继承基础 Harness 的超时、取消、重试及用量统计。
4. 工作器失败由英语父流程有界补答剩余题。语法、完形保持同组求解，保留跨空依赖；原文裁剪时沿用英语原文回查工具循环。
5. 基础 `resultProcessors` 执行英语输出完整性检查：只合并完全相同的重复结论，遗漏、冲突最多重答一次，不能根据参考答案修复答案。判分器仍拒绝原始重复、遗漏和冲突答案。

代码入口：[agent.ts](src/modules/english/agent.ts)、[harness.ts](src/modules/english/harness.ts)、[response.ts](src/modules/english/response.ts)。英语直接实现原始通用接口，不继承语文或数学的定义。没有增加另一套委派、核验或题库 HTTP 接口。

## 独立纯阅读确认集

固定最终流程后，对另一份100题、28篇文章的纯阅读确认集只运行一次：**95/100，95%**。132次完成模型调用、133次尝试，0次最终请求失败；按文章计延迟 p50 14.38秒、p95 29.49秒；输入101,088 token，输出25,637 token。95% Wilson区间为88.82%至97.85%，观察到的样本准确率不等于任意新题的准确率保证。

该确认集在运行前按文章哈希顺序冻结，整篇排除原500题和此前两份共200题的留出材料。规范化文章重复数为0；5词片段 Jaccard 相似度按0.8阈值审计，近重复数为0。100题全部为阅读选择题，没有用简单语法题或原创模板题补高分数，也没有按求解结果挑题、剔除失败或修改参考答案。

原始记录：

- [确认集报告](data/english-grounded-confirmation-v6/comparison.json)
- [运行清单](data/english-grounded-confirmation-v6/manifest.json)
- [冻结清单](evals/english/confirmation-holdout-manifest.json)
- [重复审计](data/english-grounded-confirmation-v6/isolation-audit.json)

## 数据与判分边界

原500题语料和参考答案保持不变。运行时不检索带答案的 bank，也不按题号命中参考答案直接返回；参考答案只在模型完成之后进入评测判分器。练习题ID只用于取用户明确指定的无答案材料；`authored-bank.ts` 只用于离线构建原有练习数据。本轮新增阅读材料只作为评测留出集，没有加入运行时题库。

测试覆盖了翻转参考标签后的提示一致性、工作器上下文隔离、分歧裁决不接收其他题答案、失败补答、有界重答、取消、严格判分和父子模型用量只计一次。`npm test` 193项、`npm run test:eval` 22项全部通过，`typecheck`、`build` 与 `git diff --check` 通过。

阅读来源为公开 RACE-M 中学英语材料，不能宣称全部是官方初三真题；公开材料可能进入模型预训练。本轮防泄漏保证针对运行时题库、提示与评测标签的数据流，不构成对模型预训练数据的保证。逐题求解和分歧裁决增加模型调用与输入成本，完整原文仍优先于有损摘要。

## 复现

设置终端环境变量 `LLM_API_KEY` 后执行，输出目录必须不存在：

```powershell
npm run eval:english -- --out data/english-repeat-500 --split all --variants adaptive --limit 500 --concurrency 2 --workflow grounded --thinking disabled
npm run eval:english -- --out data/english-repeat-confirmation --corpus evals/english/confirmation-holdout.json --split test --variants adaptive --limit 100 --concurrency 2 --workflow grounded --thinking disabled
```

原始下载、语料与逐篇结果在被 Git 忽略的 `data/`、`evals/` 中保留，未写入密钥。运行清单保留语料哈希、源码哈希、题目ID和统计口径；`all` 含练习与开发题，必须另看 `bySplit.test`，不能将其总分当作留出测试分数。

实验启动后补充了语料ID的路径安全校验及报告说明；已评测语料满足新校验，解题提示、候选选择逻辑和参考答案没有随之调整。
