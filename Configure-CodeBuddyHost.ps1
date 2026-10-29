param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$destination = Join-Path $PSScriptRoot 'data\codebuddy-host.credential'
if ($CheckOnly) {
  if (-not (Test-Path -LiteralPath $destination)) { Write-Output 'NOT_CONFIGURED'; exit 1 }
  $null = Get-Content -LiteralPath $destination -Raw | ConvertTo-SecureString
  Write-Output 'CONFIGURED_FOR_CURRENT_WINDOWS_USER'
  exit 0
}
Write-Host 'CodeBuddy native host credential setup (China site).'
Write-Host 'Get your credential from https://copilot.tencent.com/profile/'
Write-Host 'Stored with Windows DPAPI for this Windows user. Never paste it into chat.'
$credential = Read-Host 'API credential (hidden input)' -AsSecureString
if ($credential.Length -eq 0) { throw 'Empty credential' }
New-Item -ItemType Directory -Force (Split-Path -Parent $destination) | Out-Null
$encrypted = ConvertFrom-SecureString -SecureString $credential
[IO.File]::WriteAllText($destination, $encrypted, [Text.Encoding]::ASCII)
Write-Host 'Saved encrypted credential. This does not call a model or validate billing/access.'
