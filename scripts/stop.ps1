# Stop only the project process recorded in .peptidematch.pid.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root ".peptidematch.pid"
if (-not (Test-Path $pidFile)) {
  Write-Output "no .peptidematch.pid; nothing to stop"; exit 0
}
$targetPid = [int](Get-Content $pidFile)
$proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
if ($proc) {
  Stop-Process -Id $targetPid -Force
  Write-Output "stopped pid $targetPid"
} else {
  Write-Output "pid $targetPid was not running"
}
Remove-Item $pidFile -Force
