# Start the peptidematch API bound to 127.0.0.1 with an ephemeral port.
# Manages only this project's process; records its pid under the project.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path "data" | Out-Null
$pidFile = Join-Path $root ".peptidematch.pid"
if (Test-Path $pidFile) {
  $oldPid = [int](Get-Content $pidFile)
  $existing = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Output "already running with pid $oldPid"; exit 0
  }
  Remove-Item $pidFile -Force
}
$env:PEPTIDEMATCH_DB = "data/peptidematch.sqlite"
$proc = Start-Process -FilePath "node" `
  -ArgumentList "--experimental-strip-types","--disable-warning=ExperimentalWarning","src/server.ts" `
  -RedirectStandardOutput "data/server.out" -RedirectStandardError "data/server.err" `
  -WindowStyle Hidden -PassThru
Set-Content -Path $pidFile -Value $proc.Id
Start-Sleep -Seconds 1
Get-Content "data/server.out"
Write-Output "started pid $($proc.Id)"
