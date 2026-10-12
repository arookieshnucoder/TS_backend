# MCP 接入与自建工具教程

## 从 MCP Hub 连接服务

展开聊天侧边栏的 **MCP Hub**，选择“导入 MCP”。可以填写配置，也可以粘贴 JSON 或选择 JSON 文件。导入只保存配置，默认停用。启用开关后会建立连接并发现工具；后续每次回答开始时会刷新工具目录。

“已启用”表示 Agent 可以使用该服务，“已连接”表示握手和工具发现成功。连接异常不会停止已有记忆、工作区或自定义工具。修改配置、停用再启用会重新连接；同一个服务 ID 再导入会替换其配置。

支持以下传输：

| 方式 | 配置字段 | 地址/进程所在位置 |
| --- | --- | --- |
| Streamable HTTP | `transport: "http"`, `url` | 从后端可访问的 MCP endpoint，通常为 `/mcp` |
| stdio | `transport: "stdio"`, `command`, `args`, 可选 `cwd` | 在后端主机启动子进程，不是在用户浏览器运行 |
| 旧 SSE | `transport: "sse"`, `url` | 服务文档提供的 SSE endpoint，通常为 `/sse` |

默认只开放 `annotations.readOnlyHint: true` 的工具。没有此标记或能修改数据的工具会显示“未开放”；确认信任该服务后，可以勾选“允许修改数据”。该授权覆盖服务内的所有工具。工具注解是服务作者的声明，不提供操作系统隔离。

每个工具使用包含服务 ID 和哈希的稳定模型名称，多个服务与已有自定义工具同名也不会冲突。模型自行决定是否调用。当前 Agent 消费文本、嵌入的文本资源、资源链接与 `structuredContent`；图片/音频返回说明性占位文本。独立 MCP resources/prompts、采样、用户询问与交互式 OAuth 暂未实现。

## 导入第三方配置

按服务作者的安装文档先安装程序并准备凭据，然后导入：

```json
{
  "mcpServers": {
    "my-tools": {
      "name": "我的本地工具",
      "command": "node",
      "args": ["D:/mcp-example/server.mjs"],
      "cwd": "D:/mcp-example",
      "env": { "SERVICE_TOKEN": "${MY_SERVICE_TOKEN}" }
    },
    "remote-tools": {
      "transport": "http",
      "url": "http://localhost:3001/mcp",
      "headers": { "Authorization": "Bearer ${MY_REMOTE_TOKEN}" }
    }
  }
}
```

单个配置也可以直接导入，需带 `id` 字段。兼容 `type: "stdio" | "http" | "streamable-http" | "sse"`。可选 `enabled` 与 `allowMutations` 默认为 `false`。最多 32 个服务，每个服务最多 256 个工具。参数数组每个元素对应一个命令行参数，表单中每行一个；不要把整条 shell 命令填入 `command`。

`${变量名}` 在后端进程环境中解析，不会把后端完整环境传给子进程。缺少变量会导致连接失败。可以使用字面量 env/headers，但配置文件会保存该值，推荐使用环境变量引用。不要把密钥写进 URL 或命令行参数。管理响应不返回原始连接配置和凭据。

PowerShell 启动示例：

```powershell
$env:MY_SERVICE_TOKEN = 'your-token'
$env:MCP_ADMIN_TOKEN = 'your-admin-token'
npm run dev
```

管理令牌必须通过进程环境设置。默认管理接口仅允许本机连接；设置 `MCP_ADMIN_TOKEN` 后，需要在 Hub 的“远程管理认证”输入令牌，页面只将其保存在内存中。浏览器来源还必须匹配 `FRONTEND_ORIGIN`。该应用目前没有多用户权限隔离，服务开关是整个后端共享配置；公网部署还需为聊天接口配置应用认证，建议通过受控反向代理提供访问。

## 自建一个 stdio MCP

在单独目录建立 Node.js 项目：

```powershell
npm init -y
npm install @modelcontextprotocol/sdk@1.32.1 zod
```

保存 `server.mjs`：

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'my-knowledge-tools', version: '1.0.0' });
server.registerTool('lookup_note', {
  description: '根据关键词查询示例笔记',
  inputSchema: { query: z.string().min(1).max(200) },
  annotations: { readOnlyHint: true, idempotentHint: true },
}, async ({ query }) => ({
  content: [{ type: 'text', text: `你搜索了：${query}。这里可以调用自己的数据库或 API。` }],
}));

await server.connect(new StdioServerTransport());
```

将上一节 `my-tools` 的路径改为此文件的绝对路径，导入后启用。测试连接会出现 `lookup_note`。向 Agent 提问“调用我的笔记工具搜索 TypeScript”，模型可以通过此工具获取结果。

stdio 的 stdout 只输出协议消息；调试日志使用 stderr。业务错误返回 `{ isError: true, content: [{ type: 'text', text: '可公开的错误说明' }] }`。Harness 将应用错误转换为工具失败，避免直接暴露远程异常。取消操作通过 SDK 请求信号处理；数据库或 HTTP 调用也应支持取消。

## 把自建服务改成 HTTP

安装 `express`，沿用上面的 `McpServer` 工具声明。对于无需会话状态的服务，可以为每次 POST 创建 server 与 transport：

```js
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

function createServer() {
  const server = new McpServer({ name: 'my-knowledge-tools', version: '1.0.0' });
  server.registerTool('lookup_note', {
    description: '根据关键词查询示例笔记',
    inputSchema: { query: z.string().min(1).max(200) },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ query }) => ({ content: [{ type: 'text', text: `笔记关键词：${query}` }] }));
  return server;
}
const app = express();
app.use(express.json({ limit: '1mb' }));
app.post('/mcp', async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.listen(3001, '127.0.0.1');
```

HTTP 模式不再调用 `StdioServerTransport`。生产服务应按照 [SDK 服务端文档](https://ts.sdk.modelcontextprotocol.io/server) 加入认证和来源校验。当前 Hub 可以通过 `headers.Authorization` 接入已有静态令牌保护的服务，不能完成交互式 OAuth 登录。

## 现有自定义工具继续使用

原有 `defineReadOnlyTool({ name, description, parameters, execute })` 不用迁移。它继续使用项目的参数声明，MCP 则直接校验服务返回的 JSON Schema。两者最后都进入同一个 `ToolRegistry`，受工具超时、输出长度、取消和后续恢复策略约束。

后端组合根通过 `additionalTools` 追加 MCP 工具，仍允许 `tools` 自定义原有业务工具工厂。在自己构建的 harness 中，可调用 `await mcp.tools(signal)` 后把结果与原有工具数组合并。

## API 与部署

- `GET /api/mcp/servers`：查询状态、授权和工具目录。
- `POST /api/mcp/servers/import`：导入配置，批次校验后原子保存。
- `PATCH /api/mcp/servers/:id`：设置 `enabled` / `allowMutations`。
- `POST /api/mcp/servers/:id/test`，JSON body `{}`：测试已启用服务，结果中的 `status` 为 `connected` 或 `error`。

令牌配置时请求都带 `Authorization: Bearer <token>`，写接口只接受 `application/json`。`MCP_CONFIG_FILE` 默认在会话目录的同级 `mcp-servers.json`；不要设到会话 JSON 文件目录里面。`MCP_TIMEOUT_MS` 默认 10000。重启后恢复配置并按需连接；服务停机时会关闭连接与本地进程。

Docker 中的 `localhost` 指后端容器，使用同网络服务名或可访问的主机地址。stdio 程序、运行时与文件必须安装/挂载到后端容器，配置路径按容器路径填写；保存 MCP 配置的目录需要持久化卷。SDK 启动子进程并不提供沙箱，若不信任服务，应在容器或独立低权限账户中运行。

协议与客户端实现依据：[MCP SDK 客户端文档](https://ts.sdk.modelcontextprotocol.io/client)、[MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。本仓库锁定 SDK 1.32.1，升级 SDK 时应重跑三种传输测试。
