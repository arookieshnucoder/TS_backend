# Ask Agent 后端：独立工作流 + Harness + 本地 JSON

后端的默认主链路为 `ChatSessionService → HarnessChatAgent → AgentHarness → AskAgent`。聊天适配层负责会话快照、记忆工具和标题；Harness 通过接口接收工作流、提示词和工具集，管理上下文、工具执行、预算与取消。具体装配集中在 `bootstrap/chat-agent.ts`；LangChain 仅承担模型协议适配。前端和 REST 返回结构保持兼容。

## 运行真实模型

在 backend 目录的 PowerShell 中设置临时环境变量：

```powershell
$env:PORT = "8080"
$env:LLM_BASE_URL = "https://api.deepseek.com"
$env:LLM_MODEL = "deepseek-flash"
$env:LLM_API_KEY = Read-Host "输入 DeepSeek API Key"
npm run dev
```

模型和地址已按上述值设为默认。Key 只读取 LLM_API_KEY，不读取文件、不回退到其他服务的 Key。聊天答案失败不自动重试、不切换模型、不生成模拟答案；标题格式不合规时最多请求模型纠正一次。改变变量后需重启服务。

后端会读取 backend/.env 中的 PORT、FRONTEND_ORIGIN、NODE_ENV、SESSION_DATA_DIR、LLM_BASE_URL、LLM_MODEL、LLM_TIMEOUT_MS，终端环境变量优先。LLM_API_KEY 只从终端环境变量读取，即使写进 .env 也不会加载。当前本地配置使用后端 8080、前端 3000；前端 API_PROXY_TARGET 应与后端端口保持一致。

DeepSeek 官方配置说明：https://api-docs.deepseek.com/quick_start/pricing/

| 变量 | 默认值 |
| --- | --- |
| PORT | 8080 |
| FRONTEND_ORIGIN | http://localhost:3000 |
| LLM_BASE_URL | https://api.deepseek.com |
| LLM_MODEL | deepseek-flash |
| LLM_API_KEY | 必须在终端设置 |
| LLM_TIMEOUT_MS | 120000；可设 1–600000 毫秒 |
| SESSION_DATA_DIR | backend/data/sessions |
| SNOWFLAKE_WORKER_ID | 0；范围 0–1023 |

## 唯一的请求处理流程

1. POST /api/chat/sessions/:id/messages，body 为 { content }。
2. 保存 sessionStatus=pending，前端显示“生成中”。
3. Harness 创建请求级上下文和只读工具注册表；AskAgent 执行“模型决策 → 工具执行 → 观察结果”的有界循环。无工具调用的有效回复为最终答案，由会话服务保存结果。
4. 有效文本：保存消息和 finished，返回 HTTP 200。
5. 调用失败、超时、取消或空回复：保存 failure，不追加该轮消息，返回 HTTP 400。

成功和失败均为普通 JSON，已删除 NDJSON 状态流。响应：

```json
{
  "httpStatusCode": 400,
  "data": {
    "sessionStatus": "failure",
    "sessionError": {
      "code": "MODEL_REQUEST_FAILED",
      "message": "模型未正确返回，请检查接口配置或网络后重试。",
      "httpStatusCode": 400
    }
  },
  "error": {
    "code": "MODEL_REQUEST_FAILED",
    "message": "模型未正确返回，请检查接口配置或网络后重试。",
    "httpStatusCode": 400
  },
  "requestId": "本次 HTTP 请求 ID"
}
```

data 实际还包含完整会话字段和历史消息。模型失败统一使用 MODEL_REQUEST_FAILED；如果服务商实际返回了 401、429、500 等，会在安全错误说明中保留上游状态码，方便检查 Key、额度、模型名和接口地址，不暴露 SDK 原始异常或凭据。客户端收到的 HTTP 状态仍为 400。

文件读写等服务器自身故障仍明确返回 500，不伪装为模型失败或成功。会话不存在返回 404，同一会话并发发送返回 409。

旧 `/internal/chat/sessions/:id/result` 接口和内部令牌配置已删除。只有当前 Harness 执行可以完成会话；前端仍使用上述 `/api/chat` 接口。

## 其他接口和持久化

- GET /api/health：HTTP 200，{ httpStatusCode: 200 }。
- POST /api/chat/sessions：创建会话，{ title }，返回 201。
- GET /api/chat/sessions：会话列表与消息历史。
- GET /api/chat/sessions/:id：会话及 sessionStatus、sessionError、modelRequestId。

新会话默认 finished（尚无进行中的请求）。状态只有 pending、finished、failure。历史文件若遗留 pending，重启后标记 failure，随后可重试。

每个会话一个 创建请求requestId_创建时间毫秒数.json，后续更新同一文件。采用临时文件加重命名。后端 ID 使用 utils/snowflake.ts，字符串避免数值精度丢失。当前文件仓储只支持单后端进程。

## 核心代码与验证

- src/modules/agent/ask-agent.ts：独立研究/工具/回答循环及终止条件。
- src/modules/harness/agent-harness.ts：请求快照、运行上下文、工具和事件组合。
- src/modules/harness/context-builder.ts：逐轮上下文预算与完整工具轮次压缩。
- src/modules/harness/tool-registry.ts：只读工具注册、参数验证、超时、错误反馈和输出预算。
- src/modules/harness/workspace-tools.ts：限定工作区内的搜索、列目录、按行读取。
- src/infrastructure/llm/langchain-chat-model.ts：ChatOpenAI 配置及工具协议转换。
- src/modules/chat/service/chat-session.service.ts：send() 运行 Harness 并保存唯一结果，不接受外部回调。
- src/modules/chat/dto/session-result-response.ts：前端发送接口的 200/400 响应。
- src/common/errors/error-container.ts：错误定义；src/common/http/http-status.ts：HTTP 状态码。

```sh
npm test
npm run typecheck
npm run build
npm run smoke:agent
```

测试用本地兼容 HTTP 服务运行真实 LangChain 适配器，覆盖 deepseek-flash 请求路径、历史上下文、上游 401/429/500、空回复、无重试、失败保存、旧回调入口不可用、禁止绕过 Agent 写入结果、取消、超时及重启恢复。不使用真实 Key、不产生外部模型费用；真实账户权限和连通性需设置 Key 后验证。

环境配置测试覆盖 .env 的端口读取、终端覆盖优先级，以及文件中的 API Key 不会被加载；废弃内部令牌不会进入应用配置。

## Agent 与上下文管理

默认启用 Ask Harness。工作区默认为 backend 目录；在 backend/.env 设置 `AGENT_WORKSPACE_ROOT=..` 可读取同级 frontend 和 vscode 源码，设置 `AGENT_WORKSPACE_ENABLED=false` 可关闭文件工具。配置 Elasticsearch 与 embedding 后，记忆工具使用混合检索；只有模型实际请求记忆工具才索引和检索。

`npm run smoke:agent` 启动本机兼容模型服务与真实后端，验证“搜索 → 读文件 → 回答 → JSON 保存 → 重启恢复”，完成后关闭测试服务器。启动终端已设置 `LLM_API_KEY` 时，执行 `npm run smoke:agent -- --live` 可对配置的真实供应商运行相同的工作区问答检查。live 模式会产生实际模型请求，不会自动回退到本地模拟服务。
