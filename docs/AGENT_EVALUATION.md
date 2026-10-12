# Agent + Harness 评测使用说明

实现与研究计划见 [AGENT_EVALUATION_PLAN.md](AGENT_EVALUATION_PLAN.md)，当前实验结果见 [AGENT_EVALUATION_BASELINE.md](AGENT_EVALUATION_BASELINE.md)。

## 评测对象与边界

评测直接运行生产 `AskAgent`、`AgentHarness`、上下文管理、统一工具注册器和恢复策略，每次试验隔离工具状态、工作区、记忆及 MCP 连接。MCP 案例使用真实 SDK 的 stdio 子进程，工作区和记忆案例使用项目现有工具。没有另写一套模拟 agent 循环。

- `offline`：脚本决定模型输出及故障，验证 harness 是否正确处理协议、预算、参数修正、幂等重试、明确回退、取消和超时。注入案例验证受控流程，不证明真实模型抵抗提示注入的能力。
- `live`：使用进程中的 `LLM_API_KEY`、`LLM_MODEL`、`LLM_BASE_URL` 和超时设置。主模型和明确配置的 `LLM_FALLBACK_*` 使用生产 SDK。缺少密钥直接退出，不替换成脚本模型。只运行标记为 live 的案例。
- `standard` 使用配置的恢复次数；`no-recovery` 禁用模型/工具重试和备用模型，用于对照。离线退避缩短为 5–20 ms；真实模式保留生产退避配置。

25 个项目自编案例中，12 个任务允许真实模型运行，13 个故障控制仅用于离线。它们不是公开 benchmark，也不覆盖整个 HTTP 聊天生命周期、标题生成、Elasticsearch 或所有 MCP transport；这些已有独立集成测试。不能据此给通用 agent 能力排名。

## 运行

在 backend 目录安装依赖后执行，输出目录每次使用新路径：

```sh
npm test
npm run build
npm run eval -- --repeats 10 --seed 20261012 --out data/evaluations/control-new
npm run eval -- --repeats 10 --baseline data/evaluations/control-new/report.json --out data/evaluations/candidate-new
npm run eval -- --profile no-recovery --repeats 3 --baseline data/evaluations/control-new/report.json --out data/evaluations/no-recovery-new
npm run eval -- --variant omit-tools --repeats 3 --baseline data/evaluations/control-new/report.json --out data/evaluations/omit-tools-new
npm run eval -- --variant wrong-answer --repeats 3 --baseline data/evaluations/control-new/report.json --out data/evaluations/wrong-answer-new
```

后面三条是故意退化的实验，退出码 1 是预期结果。输出保留用于核查，程序不删除 fixture 或覆盖既有报告。

你配置 backend **进程环境**后，先做真实模型小批试跑，再扩展重复次数：

```sh
npm run eval:live -- --repeats 2 --out data/evaluations/live-smoke-new
npm run eval:live -- --repeats 10 --seed 20261013 --out data/evaluations/live-baseline-new
npm run eval:live -- --repeats 10 --seed 20261014 --baseline data/evaluations/live-baseline-new/report.json --out data/evaluations/live-candidate-new
```

CLI 不从 `.env` 获取密钥。价格也不会自动猜测，只有明确传入 `--input-usd-per-million` 和 `--output-usd-per-million` 两个参数才计算费用。价格单位为 USD / 百万 token；如果主模型和备用模型价格不同，这个统一单价只能作为指定费率的估算，精确账单仍需供应商数据。

`--help` 显示参数；支持 `--dataset`、`--timeout-ms`、`--min-pass-rate`、`--max-regression`。退出码：0 门禁通过，1 指标/边界回归，2 配置、数据集或输出错误。CI 执行每题两次离线评测，要求通过率 1；不需要外部模型密钥。

## 指标判读

| 指标 | 定义与限制 |
| --- | --- |
| 通过率 | 所有该案例断言同时成立；包括预期拒绝、故障及取消。单独报告 task/control 分组，始终显示分母与 Wilson 95% 区间。 |
| pass@k | 每题 n 次、成功 c 次：`1 - C(n-c,k)/C(n,k)`，衡量 k 次中至少一次成功。 |
| pass^k | 每题 `C(c,k)/C(n,k)`，衡量 k 次均成功的有限样本估计；不是将重试成功率冒充首次成功率。仅输出 k ≤ n。 |
| factCoverage | 回答中标注事实的规则覆盖；仅验证有限事实，不是通用语义准确率。 |
| evidenceCoverage | 成功工具结果中标注证据的覆盖。答案碰巧正确而未检索仍会失败。 |
| citationCoverage | 指定来源标记的覆盖；不自动证明每句话都被来源支持。 |
| toolPrecision / toolRecall | 允许工具的调用占比 / 必需工具的覆盖比例；可发现多调和漏调。没有适用工具时为 N/A。 |
| argumentValidity | 工具结果中未返回 INVALID_ARGUMENTS 的比例。控制集包含故意错误参数，不能当作真实模型参数正确率。 |
| policyCompliance | 禁止内容、越权工具、调用限额、预期边界拒绝与副作用计数的限定规则检查。 |
| 延迟 | p50/p95 使用 nearest-rank，包含 fixture 建立、不含关闭连接；另报 setupMs / agentMs。离线延迟不能替代生产模型延迟。 |
| modelTurns / modelAttempts | 逻辑模型操作 / 物理尝试；均包含上下文压缩。toolCalls / toolAttempts 区分逻辑工具调用和执行尝试。 |
| retries / fallbacks / compressions | 直接统计 harness 事件；已有成功工具不能因回退重放，非幂等工具不能自动重试。 |
| estimatedInputTokens | TokenBudget 对 agent 决策上下文的估计合计，不含所有压缩输入及重试重复计费。 |
| reportedInputTokens / reportedOutputTokens | SDK 报告的成功请求用量，包括压缩与备用模型。任一成功请求缺失 usage 时该试验总量为 N/A；usageCoverage 显示覆盖度。 |
| costUsd | 成功请求用量 × 明确提供的统一费率；缺失用量/价格为 N/A，未报告的失败请求费用不在其中。 |

离线输出是受控回归观察，重复不产生模型随机性，其区间是描述性统计。真实模式的 seed 只控制试验顺序，不设置供应商生成 seed；报告保存原始顺序和重复编号。不同题目的聚合区间也不能代表未来任意任务的总体置信度。

## 报告与回归流程

每次输出 `report.json`（逐次结果、事件、失败代码、用量和指纹）、`report.md`（摘要）、`report.html`（独立可打开的交互图表、案例筛选和轨迹选择）。事件展示模型/工具步骤及结果，不记录模型隐藏思维。已知密钥和 canary 会脱敏；真实任务加入新的敏感 fixture 时，应同时扩充脱敏规则。

默认门禁：通过率 ≥ 0.95、相对基线下降 ≤ 0.02；任何 safety/protocol/limits 案例失败或评测环境失败都会直接失败。相同 mode、数据集/评分器哈希、主/备用模型与供应商指纹、超时、单价、案例集合才允许比较。实现哈希与 profile/variant 可变化，支持架构和恢复策略实验；运行参数在报告中保留，改变预算时应解释差异。

每次开发按以下顺序评估：

1. 保持冻结数据集和评分器，先跑测试及小批评测，逐条读失败轨迹，区分模型、工具、策略和环境问题。
2. 运行至少 10 次/题的真实基线与候选，观察逐题 pass^k、事实/证据/引用、冗余调用、延迟和费用；不要只看总分。p95 差值只是描述性比较，没有自动显著性检验。
3. 人工复核一部分通过及失败案例，特别是错误事实、引用不支持结论和注入；改评分器后重新建立基线，不能跨评分器哈希比较。
4. 将发现的问题加入独立案例，增大长链路、多轮、权限及真实任务覆盖；保留开发集和留出集，避免提示词只适配可见案例。
5. 验证故意漏调工具/错误回答/关闭恢复仍会被检出。要求级别提交保留测试结果、报告路径和实现指纹。

研究依据包括 [AgentBench](https://arxiv.org/abs/2308.03688) 的交互环境评测、[τ-bench](https://arxiv.org/abs/2406.12045) 的策略与重复可靠性，以及 [Anthropic 的 agent 评测工程实践](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)。本项目仅借鉴原则，没有宣称实现它们的完整 benchmark。
