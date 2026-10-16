# 数学与语文解题助手

基于 Agent + Harness 的初三学习助手，支持数学检索解题和语文阅读理解，前端使用 Vue，后端使用 TypeScript。

## 依赖

- 运行环境：Node.js 24.12+（24.x）、npm、PowerShell 7。
- 后端：Express 5、LangChain、MCP SDK、AJV、js-tiktoken。
- 前端：Vue 3、Vite、KaTeX。
- 模型服务：示例使用 GLM-4.5-Air；数学检索使用 GLM embedding-3。

npm 依赖通过下面的 `npm ci` 安装；模型服务需要可用的 API Key。

## 启动

### 后端

在项目目录（包含 `backend` 和 `frontend`）打开 PowerShell：

```powershell
cd backend
npm ci
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}

$env:LLM_API_KEY = Read-Host "GLM API Key" -MaskInput
$env:LLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"
$env:LLM_MODEL = "glm-4.5-air"
$env:MATH_EMBEDDING_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"
$env:SCHOOL_SUBJECT = "auto"
$env:MATH_AGENT_VARIANT = "adaptive"
$env:READING_AGENT_VARIANT = "adaptive"
$env:PORT = "8080"
$env:FRONTEND_ORIGIN = "http://localhost:5173"
```

首次使用数学解题时，在同一终端生成题库并建立索引（索引构建会调用 embedding 服务）：

```powershell
npm run math:expand
npm run math:index
```

已有匹配的题库和索引可跳过；题库或 embedding 配置改变后需重新建索引。`evals/` 和 `data/` 不随仓库分发。API Key 只从终端环境读取，不写入 `.env`；模型与 embedding 使用不同服务地址时，另设 `EMBEDDING_API_KEY`。

语文支持直接粘贴以 `[原文]`、`[题目]` 分隔的阅读材料；如需使用内置题库，先下载并整理公开阅读题：

```powershell
npm run chinese:download -- 100
npm run chinese:prepare
```

最后启动后端：

```powershell
npm run dev
```

### 前端

在项目目录另开终端：

```powershell
cd frontend
npm ci
npm run dev
```

打开 [http://localhost:5173](http://localhost:5173)，前端默认将请求转发到后端 `8080` 端口。

## 解题流程

`SCHOOL_SUBJECT=auto` 根据当前输入及会话历史选择学科。以下为 `adaptive` 模式；Agent 负责解题步骤，Harness 负责上下文、工具执行、预算与重试。

### 数学

先检索相似例题并检查条件，再依据当前题目求解；长对话结合相关历史和用户更正，多道独立题分别处理。

```mermaid
flowchart TD
    A[输入数学题] --> B[规范化题目并记录提交]
    B --> C[拆分独立题目，结合相关历史与最新更正]
    C --> D[向量与 BM25 混合检索，公式和数字重排]
    D --> E[整理例题证据并检查数值条件]
    E --> F[适用概率题确定性求解，其他题由模型求解]
    F --> G[部分长难题触发独立复核]
    G --> H[返回推导与答案，保存会话及解题记录]
```

### 语文

以原文为依据回答阅读题。全文能放入上下文时直接保留；超出预算则选取相关原文，并允许按段号补读。

```mermaid
flowchart TD
    A[输入原文与题目，或选择题库题目] --> B[解析文章和子问，追问复用已有原文]
    B --> C{全文是否适合上下文预算}
    C -->|是| D[保留完整原文]
    C -->|否| E[选取相关原文片段并保留段号]
    D --> F[模型依据原文逐题解答]
    E --> G[模型按需调用补读工具找回原文段落]
    G --> F
    F --> H[返回结论、依据与段号引用，保存会话]
```
