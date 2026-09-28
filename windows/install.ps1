# Installs the List Assistant nightly Task Scheduler task and drops the
# on-demand shortcut on the desktop. Run from an elevated PowerShell
# session (Task Scheduler write requires it):
#
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\windows\install.ps1
#
# Idempotent: re-running replaces an existing task with the same name.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$xmlPath = Join-Path $PSScriptRoot "ListAssistant_Nightly.xml"
$urlPath = Join-Path $PSScriptRoot "ListAssistant_TriageAndSync.url"
$taskName = "ListAssistant\Nightly triage and sync"

if (-not (Test-Path $xmlPath)) {
    throw "Task XML not found at $xmlPath"
}
if (-not (Test-Path $urlPath)) {
    throw "URL shortcut not found at $urlPath"
}

Write-Host "Registering scheduled task: $taskName"
schtasks.exe /Create /XML "$xmlPath" /TN "$taskName" /F | Out-Null
Write-Host "  Registered."

$desktop = [Environment]::GetFolderPath("Desktop")
$dst = Join-Path $desktop "List Assistant — Triage and Sync.url"
Copy-Item -Path $urlPath -Destination $dst -Force
Write-Host "Placed desktop shortcut: $dst"

Write-Host ""
Write-Host "Done. The task fires every day at 00:00 local time." -ForegroundColor Green
Write-Host "Verify with: Get-ScheduledTask -TaskPath '\ListAssistant\'"
Write-Host "Or run it now: Start-ScheduledTask -TaskPath '\ListAssistant\' -TaskName 'Nightly triage and sync'"
