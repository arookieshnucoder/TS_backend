# 松间学习助手

支持语文阅读、数学解题和英语练习。

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

首次使用数学功能时，在启动后端前准备题目；已有可用题库时可跳过：

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

1. 使用邮箱注册并登录，首个注册用户自动成为管理员。
2. 选择语文、数学或英语，输入题目；阅读题请附上原文，选择题请保留选项。
3. 查看回答，继续追问，也可以从历史记录中恢复对话。
4. 使用结束后退出登录。
