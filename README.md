# TypeScript 分层后端

基于现有 Express 5 + TypeScript 环境，采用类似 Spring 的构造函数注入与 Controller / Service / Repository 分层，按业务模块组织。当前是可逐步拆分服务的模块化单体，不是已部署的分布式系统。

## 运行

沿用现有 `.env`、端口及脚本：

```sh
npm install
npm run dev
npm run typecheck
npm test
npm run build
npm start
```

配置示例（请填写在本地 `.env`，不要提交真实凭据）：

```dotenv
PORT=8080
FRONTEND_ORIGIN=http://localhost:5173
NODE_ENV=development
```

未设置时端口为 3000、前端来源为 http://localhost:5173。来源必须是完整 HTTP(S) origin，不包含末尾斜杠或路径。启动时校验配置，配置错误直接报错。

## 目录

```text
src/
├── server.ts                       进程入口，调用启动器
├── app.ts                          创建应用、注册模块及中间件，不监听端口
├── bootstrap/
│   ├── container.ts                依赖装配，选择仓储实现
│   └── server.ts                   监听端口、信号处理、优雅关闭
├── config/
│   └── env.ts                      环境配置读取、默认值、校验
├── common/
│   ├── errors/app-error.ts         可预期的应用异常
│   ├── http/                      请求 ID、404、统一异常响应
│   └── logging/logger.ts          结构化日志接口及实现
├── modules/
│   ├── health/
│   │   ├── controller/
│   │   ├── service/
│   │   └── health.module.ts        健康检查模块装配及路由
│   └── chat/
│       ├── controller/            HTTP 协议、DTO 转换
│       ├── service/               业务用例
│       ├── repository/            数据访问接口
│       ├── entity/                业务数据结构
│       ├── dto/                   请求校验及响应契约
│       └── chat.module.ts         聊天模块装配及路由
├── infrastructure/
│   └── persistence/memory/        仓储的内存实现
└── routes/health.ts                原路由的兼容入口，不重复挂载
tests/
└── backend.test.ts                 接口、仓储隔离与配置测试
docs/
└── architecture.md                 分层规则、Spring 对照及服务拆分路线
```

## 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/health | 保持原响应：`{ "status": "ok" }` |
| POST | /api/chat/sessions | 创建会话，JSON：`{ "title": "学习 TS" }` |
| GET | /api/chat/sessions | 列出当前进程的会话，按创建时间降序 |
| GET | /api/chat/sessions/:id | 获取单个会话 |

创建返回 201，包含 Location 头；查询返回 200。聊天接口成功响应为 `{ data: ... }`，日期采用 ISO 字符串。title 去除首尾空白后要求 1～100 个 JS 字符串长度单位。

异常统一返回：

```json
{
  "error": { "code": "SESSION_NOT_FOUND", "message": "Chat session not found" },
  "requestId": "请求唯一标识"
}
```

每个 HTTP 请求都有服务端生成的 `X-Request-Id`，响应 ID 与请求日志关联。JSON 请求体限制为 1 MB，未知异常不向客户端暴露堆栈或内部错误内容。

## 当前边界

- 会话仓储仅在内存中；重启丢失，多进程不共享。列表暂未分页。
- 没有认证、用户归属、真实 LLM、消息接口、数据库或消息队列。
- 前端继续使用自己的 mock 数据，本次没有连接前后端。
- 替换存储时实现 `ChatSessionRepository`，在 `bootstrap/container.ts` 注入即可。
- `createApp(config, dependencies)` 用于测试或嵌入；默认导出现在是工厂函数，原先直接导入 app 实例的外部代码需要调用它。
- SIGINT / SIGTERM 停止接收新连接并等待请求结束，10 秒后强制关闭。Windows 部分强制终止方式不会触发这些信号。
