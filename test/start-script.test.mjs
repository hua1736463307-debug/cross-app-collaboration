import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Chinese startup script retains UTF-8 BOM for Windows PowerShell 5.1', () => {
  const bytes = fs.readFileSync(new URL('../Start.ps1', import.meta.url));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('batch launcher script parses in Windows PowerShell', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$e=$null; $t=$null; [System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) "Start.ps1"),[ref]$t,[ref]$e) | Out-Null; if ($e.Count) { $e | Out-String | Write-Output; exit 1 }'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message || result.stdout || result.stderr);
});
