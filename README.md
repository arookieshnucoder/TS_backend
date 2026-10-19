# 松间学习助手

支持语文、数学、英语解题。按以下步骤启动后，可用管理员账号查看三科流程图和运行记录。

## 启动前

- 安装 Node.js 24.12 或更新版本。
- 启动本机 PostgreSQL，继续使用已有的 `agentest` 数据库。
- 准备数据库密码、智谱 API Key 和已有管理员账号。
- `backend` 与 `frontend` 文件夹保持在同一目录下。下面以本机 `D:\MS\TSpj` 为例。

## 1. 启动后端

打开一个 PowerShell 终端，执行：

```powershell
Set-Location D:\MS\TSpj\backend
npm ci # 首次运行需要，后续可跳过
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}

Remove-Item Env:AUTH_DATABASE_URL, Env:SOLUTION_SKILLS_DATABASE_URL -ErrorAction SilentlyContinue
$env:PGHOST = 'localhost'
$env:PGPORT = '5432'
$env:PGUSER = 'postgres'
$env:PGDATABASE = 'agentest'
$env:PGOPTIONS = '-c search_path=public'
$dbPassword = Read-Host '数据库密码' -AsSecureString
$env:PGPASSWORD = ([System.Net.NetworkCredential]::new('', $dbPassword)).Password

$apiKey = Read-Host '智谱 API Key' -AsSecureString
$env:LLM_API_KEY = ([System.Net.NetworkCredential]::new('', $apiKey)).Password
$env:AUTH_ENABLED = 'true'
$env:PORT = '8080'
$env:FRONTEND_ORIGIN = 'http://localhost:3000'

npm run dev
```

看到 `server.started` 表示启动成功，保持此终端运行。密码和 API Key 在终端提示时输入；新开启动终端时需要重新输入。

## 2. 打开前端

另开一个 PowerShell 终端，执行：

```powershell
Set-Location D:\MS\TSpj\frontend
npm ci # 首次运行需要，后续可跳过
$env:VITE_PORT = '3000'
$env:VITE_AUTH_ENABLED = 'true'
$env:VITE_CHAT_MODE = 'backend'
$env:API_PROXY_TARGET = 'http://localhost:8080'
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)，使用已有管理员账号登录。本机账号为 `admin@123.com`，密码使用你已设置的管理员密码。

## 3. 查看流程图

1. 点击左侧 **工作流工作台**。
2. 在 **流程定义** 中选择数学、语文或英语。
3. 点击画布上方的循环名称查看内部步骤；点击节点查看条件、输入输出和属性。
4. 图太小可以缩放，或点击属性面板中的 **居中查看此节点**；**查看全图** 可恢复整体视图。

查看实际解题过程：先在聊天中发送一道题，展开对话下方的 **执行流程**，选择对应运行并点击 **在画布中查看**。点击循环节点后，可在右侧按轮次查看日志。

流程图和运行日志仅管理员可见。编辑画布用于流程说明和日志展示，不会直接改变解题执行规则。

## 遇到问题

- **没有工作流入口**：确认登录的是管理员账号；普通账号不显示该入口。
- **无法打开页面或请求失败**：确认前后端两个终端都在运行，后端显示 `server.started`。
- **数据库连接失败**：确认 PostgreSQL 已启动，数据库名和密码填写正确。
- **端口被占用**：先停止旧服务，再重新启动。正常停止时，在两个终端分别按 `Ctrl+C`；PostgreSQL 可保持运行。
