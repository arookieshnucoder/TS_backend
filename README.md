# 聊天后端：DeepSeek + LangChain + 本地 JSON

## 运行真实模型

在 backend 目录的 PowerShell 中设置临时环境变量：

```powershell
$env:PORT = "8080"
$env:LLM_BASE_URL = "https://api.deepseek.com"
$env:LLM_MODEL = "deepseek-flash"
$env:LLM_API_KEY = Read-Host "输入 DeepSeek API Key"
npm run dev
```

模型和地址已按上述值设为默认。Key 只读取 LLM_API_KEY，不读取文件、不回退到其他服务的 Key。不自动重试、不切换模型、不生成模拟答案。改变变量后需重启服务。

后端会读取 backend/.env 中的 PORT、FRONTEND_ORIGIN、NODE_ENV、SESSION_DATA_DIR、LLM_BASE_URL、LLM_MODEL、LLM_TIMEOUT_MS，终端环境变量优先。LLM_API_KEY 和 INTERNAL_API_TOKEN 只从终端环境变量读取，即使写进 .env 也不会加载。当前本地配置使用后端 8080、前端 3000；前端 API_PROXY_TARGET 应与后端端口保持一致。

DeepSeek 官方配置说明：https://api-docs.deepseek.com/quick_start/pricing/

| 变量 | 默认值 |
| --- | --- |
| PORT | 3000；示例用 8080 匹配前端代理 |
| FRONTEND_ORIGIN | http://localhost:5173 |
| LLM_BASE_URL | https://api.deepseek.com |
| LLM_MODEL | deepseek-flash |
| LLM_API_KEY | 必须在终端设置 |
| LLM_TIMEOUT_MS | 120000；可设 1–600000 毫秒 |
| SESSION_DATA_DIR | backend/data/sessions |
| INTERNAL_API_TOKEN | 不设置则内部接口关闭 |
| SNOWFLAKE_WORKER_ID | 0；范围 0–1023 |

## 唯一的请求处理流程

1. POST /api/chat/sessions/:id/messages，body 为 { content }。
2. 保存 sessionStatus=pending，前端显示“生成中”。
3. LangChain 调用模型一次，把结果交给 ChatSessionService.complete()。
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

## 内部结果接口

```text
POST /internal/chat/sessions/:id/result
Authorization: Bearer <INTERNAL_API_TOKEN>
Content-Type: application/json
```

成功请求体：
```json
{ "requestId": "本轮 modelRequestId", "httpStatusCode": 200, "content": "模型回复" }
```

失败请求体：
```json
{ "requestId": "本轮 modelRequestId", "httpStatusCode": 400 }
```

该接口实际调用 complete() 更新状态和文件，成功返回 200，失败返回 400。HTTP 200 但内容为空也按失败处理。requestId 必须等于当前会话 DTO 中的 modelRequestId，避免旧回调修改新一轮对话。重复结果不能追加两次消息，后到的结果不能覆盖已处理结果。没有进行中的请求时拒绝结果上报。

GET /internal/chat/sessions/:id/result 保留为只读检查：已有有效回复返回 200，否则返回 400。查询不会把仍在正常处理的 pending 改成 failure。

DeepSeek Chat Completions 是请求/响应接口，不会主动调用本项目的内部地址。当前同进程的 LangChain 收到结果后直接调用 complete()；其他后端可以通过上述 POST 调用完全相同的处理逻辑。没有让服务器绕一圈 HTTP 调用自己。

内部接口要求独立的 INTERNAL_API_TOKEN，前端不配置或调用它。接口拒绝浏览器来源请求，不启用 CORS。未设置令牌时返回 404。

## 其他接口和持久化

- GET /api/health：HTTP 200，{ httpStatusCode: 200 }。
- POST /api/chat/sessions：创建会话，{ title }，返回 201。
- GET /api/chat/sessions：会话列表与消息历史。
- GET /api/chat/sessions/:id：会话及 sessionStatus、sessionError、modelRequestId。

新会话默认 finished（尚无进行中的请求）。状态只有 pending、finished、failure。历史文件若遗留 pending，重启后标记 failure，随后可重试。

每个会话一个 创建请求requestId_创建时间毫秒数.json，后续更新同一文件。采用临时文件加重命名。后端 ID 使用 utils/snowflake.ts，字符串避免数值精度丢失。当前文件仓储只支持单后端进程。

## 核心代码与验证

- src/infrastructure/llm/langchain-chat-model.ts：ChatOpenAI 配置和 model.invoke()。
- src/modules/chat/service/chat-session.service.ts：send() 发起调用，complete() 处理唯一结果。
- src/modules/chat/controller/internal-chat.controller.ts：内部 REST 接口。
- src/modules/chat/dto/session-result-response.ts：发送接口和内部接口共享的 200/400 响应。
- src/common/errors/error-container.ts：错误定义；src/common/http/http-status.ts：HTTP 状态码。

```sh
npm test
npm run typecheck
npm run build
```

测试用本地兼容 HTTP 服务运行真实 LangChain 适配器，覆盖 deepseek-flash 请求路径、历史上下文、上游 401/429/500、空回复、无重试、失败保存、内部结果上报、旧回调拒绝、取消、超时及重启恢复。不使用真实 Key、不产生外部模型费用；真实账户权限和连通性需设置 Key 后验证。

环境配置测试覆盖 .env 的端口读取、终端覆盖优先级，以及文件中的 API Key 和内部令牌不会被加载。
