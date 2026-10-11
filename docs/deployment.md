# Windows Docker 与一键发布

## 本机启动

要求 Docker Desktop 已启动并处于 **Linux containers** 模式，Windows 终端能执行 `docker info`，Docker 至少有约 3 GB 可用内存。前后端保持当前同级目录：

```text
RagAgent/
  backend/compose.yml
  backend/scripts/deploy.ps1
  frontend/Dockerfile
```

在 RagAgent 根目录的 PowerShell 中运行：

```powershell
# 密钥只在运行时注入，不参与构建。也可写入被 Git 忽略的 backend/deploy/.env。
$env:LLM_API_KEY = Read-Host 'LLM API key'
./backend/scripts/deploy.ps1
```

脚本首次将 `backend/deploy/.env.example` 复制到 `backend/deploy/.env`，然后校验配置、构建镜像、等待健康检查并验证 `/api/health`。访问 `http://localhost:3000`。没有模型密钥时容器仍可启动、查看页面及历史，但聊天模型调用会失败。

也可直接使用 Compose：

```powershell
docker compose --env-file backend/deploy/.env -f backend/compose.yml up -d --build --wait --wait-timeout 300
docker compose --env-file backend/deploy/.env -f backend/compose.yml ps
docker compose --env-file backend/deploy/.env -f backend/compose.yml logs --tail 100
```

首次直接使用 Compose 前，应先复制配置示例。`backend/.env` 是原来的宿主机开发配置；Docker 使用 **backend/deploy/.env**，两者分开，避免端口与模型配置意外混用。终端环境变量优先于 env 文件。更改配置后再次运行脚本应用更新。

前端镜像：Node 24 编译，非 root Nginx 提供静态页面及 `/api/` 反向代理。后端镜像：Node 24 编译，只携带 dist 与生产依赖，使用 node 用户运行。两个构建上下文均排除 `.env`、历史、node_modules 和 Git 数据。Compose 不发布后端、内部回调或 Elasticsearch 端口，只有本机 `127.0.0.1:3000`。Nginx 拒绝 `/internal/`。

Elasticsearch 默认启用 BM25；配置 `EMBEDDING_BASE_URL`、`EMBEDDING_MODEL` 和正确维度后启用混合向量检索。容器访问 Windows 本机上的 embedding 服务请用 `host.docker.internal`，不能用 `localhost`。API key 如有需要设置 `EMBEDDING_API_KEY`。切换 embedding 模型或维度时使用新索引名。

宿主机服务如果占用 3000，修改 `WEB_PORT` 和 `FRONTEND_ORIGIN`。此版本是单用户原型，默认只允许本机访问；Elasticsearch 的无认证端口隔离在 internal 网络。公网发布前需要在入口补充 HTTPS 和访问认证。

## 数据与停止

`ragagent_sessions` 保存完整 JSON 对话，`ragagent_elasticsearch` 保存派生索引；项目名修改后卷名前缀也会改变。重建镜像及重新部署保留卷。现有 `backend/data/sessions` 的宿主机历史不会自动导入新卷，避免覆盖已有数据。需要迁移时应先备份并明确选择要导入的数据。

仅停止服务、保留容器和卷：

```powershell
docker compose --env-file backend/deploy/.env -f backend/compose.yml stop
./backend/scripts/deploy.ps1 -Mode Status
```

脚本不执行批量删除、volume 删除、prune 或递归清理。测试及旧产物由用户按需手动管理。

## GitHub CI/CD

前后端各有 `.github/workflows/ci.yml`，push/PR 自动测试和构建镜像，不发布。前端集成测试会检出同级 backend；默认仓库是 `arookieshnucoder/TS_backend`，分支 master，可用前端仓库变量 `BACKEND_REPOSITORY` 和 `BACKEND_REF` 修改。

**统一发布入口在 backend 仓库**：Actions → **Release full stack** → **Run workflow**。

1. 将本次 backend 代码推送到 GitHub 默认分支，frontend 代码推送到选定分支；否则远端找不到 Dockerfile/workflow。当前 frontend 默认选择 `feature/inifront`，发布时也可填 tag 或完整 commit SHA。
2. 选择 backend workflow 分支和 `frontend_ref`。
3. 工作流测试两个仓库、构建两个镜像、启动含真实 Elasticsearch 的完整栈并进行 HTTP 冒烟检查；成功才将这两个镜像推送到 GHCR。
4. 成对镜像名称为 `ghcr.io/<owner>/ragagent-backend:release-<run_id>-<attempt>` 和 `ghcr.io/<owner>/ragagent-frontend:release-<run_id>-<attempt>`。发布产物 `ragagent-release` 包含 Compose、启动脚本、配置模板和记录源码 SHA / 镜像 digest 的 `images.env`。
5. 不勾选 `deploy_windows` 时只发布镜像；勾选后自动部署到下面配置的 Windows runner，按 digest 拉取，避免 tag 漂移。

GHCR 推送使用工作流的 `GITHUB_TOKEN`，不需要额外 Docker Hub 密码。如果 GHCR 同名包已存在，需允许 backend 仓库 Actions 对包读写。跨仓库 checkout 默认依赖公共仓库；私有仓库需配置 secret `SOURCE_READ_TOKEN`，仅授予相关仓库 Contents read。backend 的 `FRONTEND_REPOSITORY` 变量可覆盖前端仓库地址。

### Windows 自动部署的一次性配置

在 backend GitHub 仓库 Settings → Actions → Runners 添加 Windows x64 self-hosted runner，并添加标签 **ragagent-deploy**。runner 应使用能够访问 Docker Desktop 的 Windows 用户，安装 PowerShell 7 (`pwsh`)；Docker Desktop 通常依赖登录用户会话，因此建议在同一已登录用户下运行 runner，不要默认使用无法访问 Docker 的系统服务账号。保持 runner 为当前版本。

创建 GitHub Environment **windows-production**，配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variable | DEPLOY_ENV_FILE | Windows 上长期保存的配置文件绝对路径，例如 `D:\MS\RagAgent\backend\deploy\.env` |
| Secret | LLM_API_KEY | 实际模型 API key，自动部署必填 |
| Secret | EMBEDDING_API_KEY | embedding 服务需要认证时填写 |

保护该 environment，仅允许可信发布者触发部署。部署 job 只由手动 release 触发，不在 Windows 机器上执行 PR 工作流。宿主机 runtime env 文件提供模型名、base URL、端口及上下文配置；GitHub secrets 在部署时覆盖对应运行时密钥。

配置完成后只需在 **Run workflow** 勾选 `deploy_windows`。GitHub 的 runner 注册和 secrets 必须由仓库管理员配置；本地写入工作流文件不会自动启用远端发布，也不会自动 push 代码。

## 手动拉取与回退

从成功的发布产物获取成对 digest，在已登录 GHCR 的 Windows PowerShell 中运行：

```powershell
./backend/scripts/deploy.ps1 -Mode Pull -BackendImage 'ghcr.io/OWNER/ragagent-backend@sha256:DIGEST' -FrontendImage 'ghcr.io/OWNER/ragagent-frontend@sha256:DIGEST'
```

下载发布产物后，也可直接使用里面的 `scripts/deploy.ps1`，Pull 模式不需要源码或本地 Dockerfile。回退时使用同一次旧发布的两个 digest；历史与索引卷继续保留。部署健康检查失败会返回非零状态并保留日志与容器，脚本不会自动删除数据或伪报成功。

设计依据：[Compose 健康检查启动顺序](https://docs.docker.com/compose/how-tos/startup-order/)、[GitHub 发布 Docker 镜像](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)。
