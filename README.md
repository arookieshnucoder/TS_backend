# Agent / Harness 后端

Node.js + TypeScript + Express 5 后端，提供会话 API、Agent 工作流、Harness 执行环境、MCP 工具接入和逐问题运行记录。模型通过 LangChain 或 GLM 适配器接入。

| 运行方式 | 用途 | 需要准备 |
| --- | --- | --- |
| `general` | 通用 AskAgent；按需调用会话记忆、工作区和 MCP 工具 | 模型服务与 `LLM_API_KEY`，无需评测数据 |
| 数学模式 | 初中数学文字搜题、相似题检索与解题 | 模型凭据、数学语料、匹配的向量索引与 embedding 服务 |
| eval 平台 | 手动验证 Agent + Harness，比较配置并生成评测报告 | 本地评测数据；live 模式另需真实服务凭据 |

**日常 CI 只运行后端回归测试、TypeScript 构建和 Compose 配置校验。eval 平台及其测试单独手动运行。**

## 部署

以下命令在本仓库根目录（`backend`）执行，使用 PowerShell 7。原生运行采用与 CI 一致的 Node.js 24.x 和 npm；容器部署需要 Docker Compose、Linux 容器，以及相邻的前端仓库。

### 原生开发与部署

安装锁定的依赖，只在不存在配置文件时复制示例：

~~~powershell
npm ci
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
~~~

干净检出时先使用 `general`。当前代码及 `.env.example` 的非测试默认模式为 `combined`，但 `evals/` 和 `data/` 均未纳入版本控制，克隆仓库不会获得数学语料和索引。

~~~powershell
$env:MATH_AGENT_VARIANT = "general"
$env:PORT = "8080"
$env:FRONTEND_ORIGIN = "http://localhost:5173"
$env:LLM_BASE_URL = "https://api.deepseek.com"
$env:LLM_MODEL = "deepseek-flash"
$env:LLM_API_KEY = Read-Host "模型 API Key" -MaskInput
npm run dev
~~~

开发模式监听源码变化。正式运行在同一个已配置环境变量的终端执行：

~~~powershell
npm run build
$env:NODE_ENV = "production"
$env:MCP_ADMIN_TOKEN = Read-Host "管理接口令牌" -MaskInput
npm start
~~~

构建入口为 `dist/server.js`。生产进程由服务管理器启动并注入环境变量，工作目录、数据目录和代理超时须保持稳定；只运行一个后端进程。在另一个终端检查：

~~~powershell
Invoke-RestMethod http://localhost:8080/api/health
~~~

返回 `httpStatusCode: 200` 仅证明 HTTP 服务可用。模型凭据、embedding、数学语料和工具链是否可用，需要发消息或执行对应的真实冒烟测试验证。

### Docker Compose 全栈部署

目录布局：

~~~text
RagAgent/
├── backend/       # 本仓库：compose.yml、Dockerfile、scripts/deploy.ps1
└── frontend/      # 前端仓库，必须包含 Dockerfile
~~~

标准镜像和 `compose.yml` 明确运行 `general`，使用前端、后端、Elasticsearch 三个服务。前端暴露 `127.0.0.1:3000`，通过代理访问后端；后端和 Elasticsearch 不映射宿主机端口。

~~~powershell
$env:LLM_API_KEY = Read-Host "模型 API Key" -MaskInput
$env:MCP_ADMIN_TOKEN = Read-Host "管理接口令牌" -MaskInput
./scripts/deploy.ps1 -Mode Build
~~~

首次运行会生成忽略提交的 `deploy/.env`。编辑其中的模型地址、模型名称、`FRONTEND_ORIGIN` 和 Web 端口后重新运行。Compose 的 `deploy/.env` 与原生运行的 `backend/.env` 是两个独立配置来源；部署脚本不会将原生 `.env` 自动传入容器。

~~~powershell
./scripts/deploy.ps1 -Mode Validate
./scripts/deploy.ps1 -Mode Status
Invoke-RestMethod http://localhost:3000/api/health
docker compose --env-file deploy/.env -f compose.yml logs --tail=80 backend
docker compose --env-file deploy/.env -f compose.yml stop
~~~

`Build` 构建并启动服务，等待健康检查和前端代理检查；`Validate` 校验 Compose 配置，`Status` 显示容器状态。停止服务保留数据卷：

| 数据卷 | 容器路径 | 内容 |
| --- | --- | --- |
| `sessions` | `/app/data/sessions` | 会话 JSON |
| `harness` | `/app/runtime` | MCP 配置及运行记录 |
| `elasticsearch` | `/usr/share/elasticsearch/data` | 会话记忆索引 |

远程访问需配置 `WEB_BIND_ADDRESS`、`WEB_PORT` 和实际 `FRONTEND_ORIGIN`，并在入口代理配置 HTTPS、身份认证和请求限制。宿主机上的 embedding 服务从容器访问时使用 `host.docker.internal`。

已有成对发布镜像时，指定同一次发布的镜像摘要：

~~~powershell
./scripts/deploy.ps1 -Mode Pull -EnvFile ./deploy/.env `
    -BackendImage "ghcr.io/<owner>/ragagent-backend@sha256:<digest>" `
    -FrontendImage "ghcr.io/<owner>/ragagent-frontend@sha256:<digest>"
~~~

`release-stack.yml` 手动触发后测试前后端、构建并冒烟验证全栈、发布成对镜像，也不运行 eval。可选 Windows 部署使用 `windows-production` 环境、带 `ragagent-deploy` 标签的自托管 runner、`DEPLOY_ENV_FILE` 变量和 `LLM_API_KEY` 等运行凭据。发布全栈还需要可读取的前端仓库；默认仓库及分支见该 workflow。

### 启用数学模式

数学模式复用聊天 API，但需要单独提供资产。先恢复本地 `evals/math/corpus.json`，再使用相同的 embedding 配置构建 `data/math/index.json`：

~~~powershell
$env:MATH_AGENT_VARIANT = "combined"
$env:LLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"
$env:LLM_MODEL = "glm-4.7"
$env:LLM_API_KEY = Read-Host "数学模型 API Key" -MaskInput
npm run math:index
npm run dev
~~~

目前 `math:index` 脚本固定读取上述默认语料路径并写入默认索引路径。运行服务可通过 `MATH_CORPUS_PATH`、`MATH_INDEX_PATH`、`MATH_SUBMISSIONS_PATH` 指定其他路径；移动资产后使配置与文件一致。索引必须匹配语料顺序、内容、embedding 模型和维度；不匹配时重新构建。

数学 embedding 默认使用 `MATH_EMBEDDING_BASE_URL` 指定的 GLM `embedding-3`，维度为 256。同一模型端点可复用 `LLM_API_KEY`，不同端点必须提供 `EMBEDDING_API_KEY`；这与通用记忆检索的 embedding 配置不同。

| `MATH_AGENT_VARIANT` | 工作流 | 检索方式 |
| --- | --- | --- |
| `general` | 通用 AskAgent | 会话记忆、工作区、MCP 按需调用 |
| `baseline` | AskAgent | 模型按需调用数学向量检索工具 |
| `agent` | MathAgent | 工作流主动检索，随后解题 |
| `harness` | AskAgent + 数学检索包装 | 首轮前混合检索并注入证据 |
| `combined` | MathAgent + 数学检索包装 | 混合检索、适用题型的确定性求解及必要复核 |

标准 Docker 镜像未打包数学语料或向量索引，标准 Compose 固定为 `general`。容器部署数学模式需要额外的 Compose 覆盖文件：将模式设为 `combined`、传入数学配置、只读挂载语料和索引、将提交目录挂到可写持久化卷。仅修改 `deploy/.env` 无法切换标准 Compose 的模式。

## 使用边界

- **单进程存储**：会话采用本地 JSON，互斥锁只在进程内有效，适用于单实例部署。多实例需要共享仓储和跨进程并发控制。重启后遗留的 `pending` 会话转为 `failure`，已有历史保留。
- **接口与访问控制**：聊天和会话 API 暂无用户身份认证与按用户隔离。`FRONTEND_ORIGIN` 控制浏览器 CORS，不提供用户授权。开放服务前在入口加身份认证，不要直接提供为多用户公共服务。
- **响应与状态**：消息接口返回完整 JSON，同一会话同时只能处理一个问题，不提供流式响应。问题失败不追加本轮消息；成功先保存回答，再更新标题，标题失败保留已提交答案。
- **模型与检索**：通用模式需要支持工具调用的模型。配置 Elasticsearch 后，其失败会传播，不自动替换成本地检索。模型重试有限，鉴权、权限和无效请求不触发重试。通用模式备用模型必须显式配置，不同端点需要独立凭据。
- **工作区与 MCP**：工作区工具只读，限制在配置根目录内，拒绝路径穿越、链接及敏感路径。MCP 导入默认禁用，默认只开放 `readOnlyHint: true` 的工具；启用 `allowMutations` 前确认服务行为。stdio MCP 命令运行在后端主机或容器中，依赖程序必须存在。
- **模式差异**：通用模式装配会话记忆、工作区和动态 MCP 工具；当前数学模式使用数学工具与专用工作流，不自动装配这些通用工具，也未接入通用模式的备用模型链。
- **数学与 OCR**：数学专用提示词面向初中数学，但未实现 HTTP 层的题目领域拒绝。模型答案仍需核验，新问题结果记为 `solved_unverified`，不会自动进入可信知识库。OCR 默认返回 `501 MATH_OCR_NOT_CONFIGURED`，配置供应商后低置信度结果需用户确认。
- **管理与运行记录**：生产环境的 MCP 和观测接口必须设置 `MCP_ADMIN_TOKEN`，否则返回 503；调用带 `Authorization: Bearer <token>`。开发环境未设令牌时只接受本机连接，存在 Origin 时须匹配配置。运行记录经过脱敏，但可能保留题目、回答和工具证据，按业务数据管理。

## 配置与凭据

原生运行：启动终端环境变量 > `backend/.env` 中允许的非敏感配置 > 代码默认值。`LLM_API_KEY`、`EMBEDDING_API_KEY`、`ELASTICSEARCH_API_KEY`、`LLM_FALLBACK_API_KEY`、`MCP_ADMIN_TOKEN` 等凭据只从进程环境读取，写入原生 `.env` 不会加载。

Compose 运行：启动终端环境和 `--env-file deploy/.env` 参与变量替换，再由 `compose.yml` 传给容器。凭据用于容器运行，不作为镜像构建参数。

| 配置 | 代码默认值 / 标准部署值 | 用途 |
| --- | --- | --- |
| `PORT` / `FRONTEND_ORIGIN` | `8080` / `http://localhost:3000` | 监听端口与浏览器来源；原生示例来源为 5173 |
| `MATH_AGENT_VARIANT` | 非测试默认 `combined`；标准 Compose 固定 `general` | 工作流选择 |
| `LLM_BASE_URL` / `LLM_MODEL` | general：DeepSeek / `deepseek-flash`；数学：GLM / `glm-4.7` | 主模型 |
| `LLM_TIMEOUT_MS` | `120000` | 整轮回答超时；标题另有最多 5 秒预算 |
| `LLM_MAX_INPUT_TOKENS` | `32768` | Harness 输入预算 |
| `AGENT_MAX_TOOL_STEPS` / `AGENT_MAX_CALLS_PER_STEP` | `4` / `4` | 工具轮数与每轮调用上限 |
| `AGENT_TOOL_TIMEOUT_MS` | `15000` | 单工具超时 |
| `AGENT_MODEL_RETRIES` / `AGENT_TOOL_RETRIES` | `2` / `1` | 瞬时错误重试；工具需满足幂等条件 |
| `AGENT_MODEL_ATTEMPT_TIMEOUT_MS` | `30000` | 单次模型尝试超时 |
| `AGENT_WORKSPACE_ENABLED` / `AGENT_WORKSPACE_ROOT` | `true` / `.` | 通用模式的只读工作区 |
| `SESSION_DATA_DIR` | `data/sessions` | 会话持久化 |
| `AGENT_TRACE_ENABLED` / `AGENT_TRACE_MAX_EVENTS` | `true` / `512` | 逐问题记录与事件上限 |
| `AGENT_RUN_DATA_DIR` / `MCP_CONFIG_FILE` | `data/sessions-runs` / `data/mcp-servers.json` | 原生默认记录和工具配置 |
| `ELASTICSEARCH_URL` | 原生未配置；Compose 内部服务 | 通用模式会话记忆索引 |
| `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` | 未配置 | 通用记忆向量检索；无需时使用词法检索 |

完整示例见 [.env.example](.env.example)，容器配置见 [deploy/.env.example](deploy/.env.example)。修改进程配置后重启服务。

## 线框流程图

### 标准部署

~~~text
[浏览器]
    |
    | HTTP / HTTPS
    v
[前端 / 入口代理 :3000] ---- /api ----> [Express 后端 :8080]
                                             |
                      +----------------------+---------------------+
                      |                      |                     |
                      v                      v                     v
              [会话 JSON 卷]        [Harness/MCP/记录卷]    [模型服务 / MCP]

[Express 后端] ---- 通用会话记忆 ----> [Elasticsearch / 索引卷]
~~~

### 一次消息执行

~~~text
[POST /api/chat/sessions/:id/messages]
    |
    v
[Controller：校验 content，绑定断开取消信号]
    |
    v
[SessionService：会话互斥，保存 pending，设置总超时]
    |
    +--> general
    |      [HarnessChatAgent：历史快照、记忆/工作区/MCP 工具]
    |          |
    |          v
    |      +---------- AgentHarness 执行环境 ----------+
    |      | [AskAgent 工作流]                        |
    |      |    prepare：上下文与必要压缩             |
    |      |      -> complete：模型决策               |
    |      |      -> 请求工具？                       |
    |      |          是：校验批次 -> execute 工具    |
    |      |              -> 保存工具结果 -> 下一轮   |
    |      |          否：返回最终回答                |
    |      | 工具到达上限后禁用工具，要求最终回答     |
    |      +------------------------------------------+
    |
    +--> 数学模式
           [加载语料/索引 -> 规范化题目 -> 保存问题及向量]
               |
           [按配置：向量工具检索 / 首轮前混合检索]
               |
           [AskAgent 或 MathAgent + AgentHarness]
               |
           [combined 适用题型确定性求解，其他调用模型]
               |
           [专用工作流必要时独立复核 -> 保存未验证结果]

两条路径返回会话服务：
    成功 -> 保存用户消息与回答 + finished -> 独立标题预算 -> HTTP 200 JSON
    失败 -> 保留已有历史 + failure -> 连接可用时 HTTP 400 JSON
    存储/服务异常 -> HTTP 500；客户端断开后不再发送响应
~~~

AskAgent / MathAgent 负责工作流顺序与结束条件；AgentHarness 提供 `prepare / complete / execute`，统一执行预算、上下文、工具校验、重试、取消和事件。数学 Harness 包装器还负责按配置预取检索证据。

## HTTP 使用

~~~powershell
$base = "http://localhost:8080"
$session = Invoke-RestMethod "$base/api/chat/sessions" -Method Post `
    -ContentType "application/json" -Body '{"title":"新对话"}'
$body = @{ content = "请解释 Agent 和 Harness 的职责" } | ConvertTo-Json
$result = Invoke-RestMethod "$base/api/chat/sessions/$($session.data.id)/messages" `
    -Method Post -ContentType "application/json; charset=utf-8" -Body $body
$result.data.messages[-1].content
~~~

全栈部署将 `$base` 改为前端入口 `http://localhost:3000`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | HTTP 健康检查 |
| POST | `/api/chat/sessions` | 创建会话，`{"title":"新对话"}` |
| GET | `/api/chat/sessions` | 会话列表及历史 |
| GET | `/api/chat/sessions/:id` | 指定会话 |
| POST | `/api/chat/sessions/:id/messages` | 发问题，`{"content":"问题"}` |
| GET | `/api/math/capabilities` | 模式与 OCR 能力信息 |
| POST | `/api/math/ocr` | 预留识图；`mimeType` + `base64` |
| GET / POST | `/api/mcp/servers` / `/api/mcp/servers/import` | 管理：列出 / 导入 MCP |
| PATCH / POST | `/api/mcp/servers/:id` / `/api/mcp/servers/:id/test` | 管理：开关 / 连接测试 |
| GET | `/api/observability/sessions/:id/runs` | 管理：逐问题记录列表 |
| GET | `/api/observability/sessions/:id/runs/:runId` | 管理：执行详情 |

消息 `content` 为 1–12000 字符，JSON 请求体上限 1 MiB。创建会话返回 201，回答成功 200，模型/工作流失败 400，会话不存在 404，同会话并发发送 409，存储等服务故障 500。响应中的 `sessionStatus`、`sessionError` 与 `X-Request-Id` 可用于诊断。

## 测试与 eval 边界

| 命令 | 范围 | 数据 / 凭据要求 | 日常 CI |
| --- | --- | --- | --- |
| `npm test` | `tests/*.test.ts`：HTTP、仓储、工具、上下文、恢复、MCP、观测、数学运行逻辑 | 自包含夹具、本机 HTTP 服务和测试替身；无需真实 Key 或 `evals/` | 是 |
| `npm run build` | TypeScript 编译，输出 `dist/` | 无外部服务 | 是 |
| `npm run typecheck` | 仅类型检查 | 无外部服务；CI 的 build 已检查源码类型 | 否 |
| `npm run test:eval` | `tests/*.eval.ts`：评测平台、grader、报告及数据集快照 | 本地 `evals/` 资产；平台测试使用脚本或本机替身 | 否 |
| `npm run smoke:agent` | 通用 HTTP → 搜索 → 读文件 → 回答 → 保存 → 重启恢复 | 本机替身，无真实 Key | 否 |
| `npm run smoke:agent -- --live` | 通用真实模型冒烟 | 真实模型配置与 Key，可能产生调用费用 | 否 |
| `npm run eval` / `eval:live` | Agent + Harness 离线控制 / 真实模型评测 | `evals/agent-v1.json`、`evals/fixtures/mcp-server.mjs`；live 另需模型 Key | 否 |
| `npm run eval:math` / `smoke:math:live` | 数学配置评测 / 真实链路验证 | 数学语料、索引及模型、embedding 凭据 | 否 |

`evals/` 保持本地管理，不作为修复 CI 的必需提交内容。数学语料校验的后端回归测试使用自包含夹具；真实语料的 100/12/30 数量与来源断言保留在手动评测测试中。

~~~powershell
npm test
npm run build
npm run smoke:agent

# 准备本地评测资产后，按需手动执行
npm run test:eval
npm run eval -- --repeats 2 --out data/evaluations/offline-run-001
npm run eval:live -- --repeats 2 --out data/evaluations/live-run-001
npm run eval:math -- --split development --out data/evaluations/math-run-001
~~~

每次评测使用新的输出目录，已有报告不会覆盖。离线控制验证执行契约；模型效果与实际用量通过 live 评测验证。使用真实模型、embedding 或 MCP 服务时按对应服务提供凭据，失败不会制造模拟通过结果。

## 代码入口

| 入口 | 职责 |
| --- | --- |
| [container.ts](src/bootstrap/container.ts) | 依赖注入、通用/数学模式装配 |
| [ask-agent.ts](src/modules/agent/ask-agent.ts) | 通用多轮工作流 |
| [agent-harness.ts](src/modules/harness/agent-harness.ts) | 工作流执行环境 |
| [define-tool.ts](src/modules/harness/define-tool.ts) | 工具声明、schema 与参数验证 |
| [profile.ts](src/modules/math/profile.ts) | 数学配置、工作流与检索组合 |
| [chat-session.service.ts](src/modules/chat/service/chat-session.service.ts) | 会话状态、消息提交、标题 |
| [ci.yml](.github/workflows/ci.yml) | 日常后端 CI |
| [release-stack.yml](.github/workflows/release-stack.yml) | 手动全栈发布与可选 Windows 部署 |
