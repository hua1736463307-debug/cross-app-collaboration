param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$baseUrl = 'http://127.0.0.1:4318'
try {
  $existing = Invoke-RestMethod -Uri ($baseUrl + '/health') -TimeoutSec 2
  if ($existing.name -eq '跨应用协作系统') {
    if (-not $NoBrowser) { Start-Process $baseUrl }
    exit 0
  }
} catch {}
$nodeCommand = Get-Command node -ErrorAction Stop | Select-Object -First 1
$major = (& $nodeCommand.Source -p "process.versions.node.split('.')[0]") -as [int]
if ($major -lt 24) { throw '需要 Node.js 24 或更高版本。' }
$dataDirectory = Join-Path $projectRoot 'data'
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$env:HUB_PORT = '4318'
$env:HUB_DATA_DIR = $dataDirectory
$entry = Join-Path $projectRoot 'src\server.mjs'
$process = Start-Process -FilePath $nodeCommand.Source -ArgumentList ('"' + $entry + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDirectory 'server.out.log') -RedirectStandardError (Join-Path $dataDirectory 'server.err.log') -PassThru
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 200
  $process.Refresh()
  if ($process.HasExited) { break }
  try {
    $health = Invoke-RestMethod -Uri ($baseUrl + '/health') -TimeoutSec 1
    if ($health.name -eq '跨应用协作系统') { $ready = $true; break }
  } catch {}
}
if (-not $ready) {
  $errorLog = Join-Path $dataDirectory 'server.err.log'
  $detail = if (Test-Path -LiteralPath $errorLog) { (Get-Content -LiteralPath $errorLog -Tail 15 -Encoding UTF8) -join "`n" } else { '' }
  if ([string]::IsNullOrWhiteSpace($detail)) { $detail = '服务未在等待时间内就绪，请检查端口占用或启动耗时。' }
  throw ("启动失败：`n" + $detail + "`n日志位置：" + $errorLog)
}
if (-not $NoBrowser) { Start-Process $baseUrl }
