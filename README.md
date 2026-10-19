# 松间学习助手

支持语文阅读、数学解题和英语练习。

基础 Harness 已接入解题经验 Skills：适用性匹配、自动提炼、版本更新、包含复用及综合经验拆分，经独立审核后存入 PostgreSQL 并导出 SKILL.md。三科使用 GLM-4.5-Air 求解、GLM-4.7 复核与经验整理。工具协议、评测及联调入口见 [解题经验 Skills](EXPERIENCE_SKILLS.md)。

## 启动后端

准备 Node.js 24.12+、一个可用的 PostgreSQL 数据库和模型服务 API Key。将下方数据库用户名、数据库名替换为自己的配置。

在项目根目录打开 PowerShell：

```powershell
cd backend
npm ci
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}

$env:PGHOST = 'localhost'
$env:PGPORT = '5432'
$env:PGUSER = 'postgres'
$env:PGDATABASE = '你的数据库名'
$dbPassword = Read-Host '数据库密码' -AsSecureString
$env:PGPASSWORD = ([System.Net.NetworkCredential]::new('', $dbPassword)).Password

$apiKey = Read-Host '模型服务 API Key' -AsSecureString
$env:LLM_API_KEY = ([System.Net.NetworkCredential]::new('', $apiKey)).Password
$env:PORT = '8080'
$env:FRONTEND_ORIGIN = 'http://localhost:5173'

npm run dev
```

看到 `server.started` 后，保持终端运行。账号所需的表会自动创建。

在线数学功能已移除旧 bank 和索引依赖，无需预先准备题库。以下命令仅供旧题库的离线检索实验使用：

```powershell
npm run math:expand
npm run math:index
```

## 打开前端

在项目根目录另开一个 PowerShell 终端：

```powershell
cd frontend
npm ci
$env:VITE_PORT = '5173'
$env:VITE_CHAT_MODE = 'backend'
npm run dev
```

打开 [http://localhost:5173](http://localhost:5173)。

## 使用流程

1. 使用邮箱注册并登录；用户表为空时，首个成功注册用户自动成为管理员，后续用户为普通用户。清空全部用户后，此规则重新生效。
2. 选择语文、数学或英语，输入题目；阅读题请附上原文，选择题请保留选项。
3. 查看回答，继续追问，也可以从历史记录中恢复对话。
4. 使用结束后退出登录。
