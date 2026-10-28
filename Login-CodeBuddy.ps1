$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$configPath = Join-Path $projectRoot 'data\launchers.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Missing data/launchers.json. Configure the independent CodeBuddy CLI first.' }
$settings = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($settings.executor -ne 'codebuddy') { throw 'The configured executor is not the independent CodeBuddy CLI.' }
if (-not (Test-Path -LiteralPath $settings.workbuddy -PathType Leaf)) { throw 'The configured CodeBuddy CLI does not exist.' }
$nodeCommand = Get-Command node -ErrorAction Stop | Select-Object -First 1
$saved = @{}
$keys = @(Get-ChildItem Env: | Where-Object { $_.Name -like 'WORKBUDDY_*' -or $_.Name -in @('CODEBUDDY_FORCE_LITE_WB_BUNDLE','CODEBUDDY_CONFIG_DIR') } | ForEach-Object { $_.Name })
try {
  foreach ($key in $keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process'); [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
  Set-Location -LiteralPath $projectRoot
  Write-Host 'CodeBuddy Code login: choose Chinese Site and complete sign-in in your browser.'
  Write-Host 'This does not copy or modify WorkBuddy desktop credentials. Exit after signing in.'
  & $nodeCommand.Source $settings.workbuddy
  $clientExit = $LASTEXITCODE
} finally {
  foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
}
exit $clientExit
