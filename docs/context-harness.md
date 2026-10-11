# Agent 与上下文管理

## 调研结论

- [Elasticsearch hybrid search](https://www.elastic.co/docs/solutions/search/hybrid-search)：BM25 是词法相关性，不是 embedding；语义检索需配置独立 embedding 服务。本实现用 BM25 + dense_vector kNN，并在应用端执行 RRF（常数 60），避免依赖 Elasticsearch RRF retriever 的授权版本。
- [Elasticsearch similarity](https://www.elastic.co/docs/reference/elasticsearch/index-settings/similarity)：文本字段默认 BM25。中英混合聊天使用内置 `cjk` analyzer，无需安装中文分析插件。
- [LangChain tool calling](https://www.langchain.com/blog/tool-calling-with-langchain)：`bindTools` → 模型 tool_calls → 校验和执行 → ToolMessage → 再次调用。仅“往 prompt 添加记忆”不等于 tool-calling agent。

## 运行与配置

现有 `npm install`、`npm run dev` 入口不变。`.env` 只加载非密钥配置，API key 仍从启动终端继承。

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| LLM_MAX_INPUT_TOKENS | 32768 | 模型允许的最大**输入**，请按实际供应商设置；如果只知道总窗口，应先扣除输出预算（回答上限 4096） |
| CONTEXT_CHUNK_TOKENS | 512 | 可配置 128–2048，建议比较 512/1024 |
| CONTEXT_OVERLAP_RATIO | 0.15 | 相邻块重叠；中间块前后合计不超过 30% |
| CONTEXT_COMPRESSION_TRIGGER | 0.65 | 触发区间 0.60–0.70 |
| CONTEXT_COMPRESSION_TARGET | 0.08 | 记忆摘要目标为输入上限的 5%–10%，不包括当前问题和固定指令 |
| CONTEXT_TOKENIZER | cl100k_base | 也支持 o200k_base；供应商不同需选择近似 tokenizer 并提高安全系数 |
| CONTEXT_TOKEN_SAFETY_FACTOR | 1.2 | 1–3；不是供应商真实 token 用量保证 |
| AGENT_MAX_TOOL_STEPS | 4 | 最多四轮工具调用，每轮最多四个工具，最后一次模型调用不提供工具 |
| ELASTICSEARCH_URL | 未配置 | 未配置时使用本地 BM25；配置后失败会明确报错，不自动降级 |
| ELASTICSEARCH_INDEX | chat-memory-v1 | 每个仓库/独立用户数据域使用独立索引 |
| EMBEDDING_BASE_URL | 未配置 | 兼容 `/embeddings` 的服务根路径，例如 `http://host:port/v1` |
| EMBEDDING_MODEL | 未配置 | 必须和 base URL 一起设置；不要假定聊天供应商提供 embedding |
| EMBEDDING_DIMENSIONS | 1536 | 必须与 embedding 实际维度匹配 |

密钥环境变量：`LLM_API_KEY`、`EMBEDDING_API_KEY`、`ELASTICSEARCH_API_KEY`。后两者按服务认证要求设置。只配置 Elasticsearch 时运行 ES BM25；同时配置 embedding 才是混合向量检索。

建议 Elasticsearch 8.19 或兼容的 9.x 服务。使用 `compose.memory.yml` 可启动单机开发实例：`docker compose -f compose.memory.yml up -d`，然后设置 `ELASTICSEARCH_URL=http://localhost:9200`。此 compose 仅绑定本机并关闭认证，不能用于公开部署。未连接真实服务时，HTTP 协议测试只能证明客户端请求/处理行为，不能证明真实索引质量。

更改 embedding 模型、维度、tokenizer、分块大小时，请使用新的索引名，避免旧映射或分块混用。文档按内容寻址，`_mget` 避免重复 embedding；查询同时过滤本次快照中的文档 ID，旧标题和旧分块不能进入结果。旧派生记录保留，后续索引维护由使用者手动安排。索引是可重建的派生数据，JSON 会话才是历史事实来源。项目目前是单用户、单后端进程原型；共享范围是此 repository 的会话，不具备多租户身份隔离。接入多用户前必须按用户隔离 repository 和索引，不能共用全局候选集合。

## 工具接口与数据流

所有模块位于 `src/modules/context/`，不依赖 Express；可独立实例化复用。`ContextTool<I,O>.execute(input, signal)` 定义可复用接口：

- `SessionContextTool`：检索当前会话消息分块，结果带 session/chunk 来源。
- `SessionTitleTool`：前五个成功 user/assistant 轮次更新标题；第六轮及之后直接返回已存标题。规则：中文 10–15 个汉字，英文 5–10 个单词。非法输出最多纠正一次；持续失败保留合规旧标题或使用合规占位标题，并记录日志，不伪造模型成功。
- `CompressionTool`：分批 map/reduce 调模型摘要，保留偏好、决定、约束、未解决问题和来源；每个摘要请求也受输入预算限制，输出硬限制并再次计数。压缩失败明确中止本次生成。
- `SharedMemoryTool`：排除当前会话，选按更新时间排序的最近十个非空会话；先检索标题，最多选三个匹配会话，只携带其压缩内容。无匹配不注入。历史数据与工具结果标记为不可信数据。
- `ContextHarness`：调度工具、计算含系统指令/消息封装/工具 schema 的预算、执行有界 agent 循环，校验工具名称、参数和 call ID，传递同一个取消信号。工具只能搜索当前请求快照内的会话，模型无法提供任意会话 ID。

历史先分块用于相关内容检索；当前会话原文也保留在待压缩记忆中，避免 top-k 丢掉没有匹配关键词但重要的约束。只要总量超过阈值就压缩记忆；当前用户输入不静默截断，单条过大直接失败。工具输出增长后再次检查预算，必要时将完整工具交换压缩为数据，避免留下孤立的 tool_call。

`.json` 中的 `messages` 始终保存完整成功往返；模型摘要、工具结果和 system 消息不写入聊天历史。前端通过原有接口接收新的 title 与原始 messages。失败重试不增加成功轮次，重启后按历史计算轮次，冻结不会重置。

日志 `context.compressed` 记录前后 token 估算；`agent.tool` 记录工具、步数和结果长度；`context.title_failed` 记录标题失败。日志不记录正文或密钥。

## 验证

`npm test` 覆盖分块覆盖率/重叠/Unicode、512 与 1024 粒度、标题格式与冻结、长历史压缩、当前输入超限、跨会话范围、tool_call 循环与错误、BM25/kNN HTTP 请求、真实 LangChain 适配器、JSON 重启持久化；`npm run typecheck` 与 `npm run build` 检查 TypeScript。前端目录执行 `npm test` 和 `npm run build`。

测试使用确定性模型和本机 HTTP stub，不调用付费 API。摘要语义质量、真实 embedding 召回率以及真实模型工具调用能力仍需配置实际供应商后验证。遵守仓库禁止批量删除规则，测试结束会保留临时目录供人工清理。
