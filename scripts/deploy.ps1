[CmdletBinding()]
param(
    [ValidateSet('Build', 'Pull', 'Validate', 'Status')][string]$Mode = 'Build',
    [string]$EnvFile,
    [string]$BackendImage,
    [string]$FrontendImage
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectDirectory = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $projectDirectory 'compose.yml'
if (-not $EnvFile) { $EnvFile = Join-Path $projectDirectory 'deploy/.env' }
if (-not (Test-Path -LiteralPath $EnvFile)) {
    $template = Join-Path $projectDirectory 'deploy/.env.example'
    $parentDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($EnvFile))
    New-Item -ItemType Directory -Path $parentDirectory -Force | Out-Null
    Copy-Item -LiteralPath $template -Destination $EnvFile
    Write-Host "Created runtime configuration: $EnvFile"
}
$EnvFile = (Resolve-Path -LiteralPath $EnvFile).Path
Get-Command docker -ErrorAction Stop | Out-Null
$engine = & docker info --format '{{.OSType}}'
if ($LASTEXITCODE -ne 0 -or $engine -ne 'linux') { throw 'Start Docker Desktop and select Linux containers before deploying.' }
$composeArguments = @('compose', '--env-file', $EnvFile, '-f', $composeFile)
function Invoke-Compose {
    param([string[]]$CommandArguments)
    & docker @composeArguments @CommandArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed: $($CommandArguments -join ' ')" }
}
$previousBackend = $env:BACKEND_IMAGE
$previousFrontend = $env:FRONTEND_IMAGE
try {
    if ($BackendImage) { $env:BACKEND_IMAGE = $BackendImage }
    if ($FrontendImage) { $env:FRONTEND_IMAGE = $FrontendImage }
    Invoke-Compose -CommandArguments @('config', '--quiet')
    if ($Mode -eq 'Validate') { Write-Host 'Compose configuration is valid.'; return }
    if ($Mode -eq 'Status') { Invoke-Compose -CommandArguments @('ps'); return }
    if ($Mode -eq 'Build') { Invoke-Compose -CommandArguments @('build', '--pull', 'backend', 'frontend') }
    else { Invoke-Compose -CommandArguments @('pull') }
    Invoke-Compose -CommandArguments @('up', '-d', '--no-build', '--wait', '--wait-timeout', '300')
    Invoke-Compose -CommandArguments @('ps')
    $binding = & docker @composeArguments port frontend 8080
    if ($LASTEXITCODE -ne 0 -or -not $binding) { throw 'Frontend port is unavailable.' }
    $port = ($binding | Select-Object -First 1).Split(':')[-1]
    $url = "http://localhost:$port"
    $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 15
    if ($health.httpStatusCode -ne 200) { throw 'Backend proxy health check failed.' }
    Write-Host "Deployment healthy: $url"
    Write-Host 'A configured LLM_API_KEY is required for chat replies. Session and index volumes are preserved.'
} finally {
    $env:BACKEND_IMAGE = $previousBackend
    $env:FRONTEND_IMAGE = $previousFrontend
}
