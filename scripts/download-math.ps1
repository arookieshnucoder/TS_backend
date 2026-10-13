$ErrorActionPreference = 'Stop'
$taskSourceDir = Join-Path $PSScriptRoot '../data/math/sources'
New-Item -ItemType Directory -Path $taskSourceDir -Force | Out-Null
$taskArchive = Join-Path $taskSourceDir 'mathbench_v1.zip'
Invoke-WebRequest 'https://github.com/open-compass/MathBench/files/15384594/mathbench_v1.zip' -OutFile $taskArchive
Expand-Archive -LiteralPath $taskArchive -DestinationPath (Join-Path $taskSourceDir 'mathbench') -Force
Write-Output 'Downloaded public MathBench v0.1.0. Original file and its SHA-256 are retained in corpus metadata.'
