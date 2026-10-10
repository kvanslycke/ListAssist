# Smart Note — whisper.cpp local setup for Windows (SP7).
#
# Downloads the whisper.cpp Windows release and a ggml model into
# C:\Users\<user>\whisper-cpp\, then (optionally) registers a Task
# Scheduler entry that starts whisper-server at login on
# http://127.0.0.1:8080.
#
# Usage (from an elevated or non-elevated PowerShell):
#   .\setup-whisper.ps1
#   .\setup-whisper.ps1 -InstallDir "D:\whisper-cpp"
#   .\setup-whisper.ps1 -Model small.en
#   .\setup-whisper.ps1 -RegisterLoginTask
#   .\setup-whisper.ps1 -SkipDownload   # just register the task
#
# After it finishes, open Obsidian → List Assistant → "Smart Note:
# benchmark transcribers" to confirm the mic-to-text path works.

[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:USERPROFILE "whisper-cpp"),
    [ValidateSet("base.en", "small.en")]
    [string]$Model = "base.en",
    [string]$WhisperReleaseUrl = "https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-blas-bin-x64.zip",
    [switch]$RegisterLoginTask,
    [switch]$SkipDownload,
    [int]$Port = 8080
)

$ErrorActionPreference = "Stop"

Write-Host "Smart Note / whisper.cpp setup" -ForegroundColor Cyan
Write-Host "  Install dir: $InstallDir"
Write-Host "  Model:       ggml-$Model.bin"
Write-Host "  Port:        $Port"
Write-Host ""

if (-not $SkipDownload) {
    if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null }
    $modelsDir = Join-Path $InstallDir "models"
    if (-not (Test-Path $modelsDir)) { New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null }

    $zipPath = Join-Path $InstallDir "whisper-cpp.zip"
    if (-not (Test-Path (Join-Path $InstallDir "whisper-server.exe")) -and -not (Test-Path (Join-Path $InstallDir "server.exe"))) {
        Write-Host "Downloading whisper.cpp Windows release..." -ForegroundColor Yellow
        Write-Host "  from: $WhisperReleaseUrl"
        Invoke-WebRequest -Uri $WhisperReleaseUrl -OutFile $zipPath -UseBasicParsing
        Write-Host "Extracting..." -ForegroundColor Yellow
        Expand-Archive -Path $zipPath -DestinationPath $InstallDir -Force
        Remove-Item $zipPath
    } else {
        Write-Host "whisper.cpp binary already present — skipping download." -ForegroundColor Green
    }

    $modelPath = Join-Path $modelsDir "ggml-$Model.bin"
    if (-not (Test-Path $modelPath)) {
        $modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin"
        Write-Host "Downloading ggml-$Model.bin..." -ForegroundColor Yellow
        Write-Host "  from: $modelUrl"
        Invoke-WebRequest -Uri $modelUrl -OutFile $modelPath -UseBasicParsing
    } else {
        Write-Host "Model ggml-$Model.bin already present — skipping." -ForegroundColor Green
    }
}

# Locate the server executable.
$serverExe = @(
    (Join-Path $InstallDir "whisper-server.exe"),
    (Join-Path $InstallDir "server.exe"),
    (Join-Path $InstallDir "whisper-cli.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $serverExe) {
    Write-Error "Could not find whisper-server.exe / server.exe in $InstallDir after extraction. Inspect the archive and update this script's expected name."
    exit 2
}
Write-Host "Server binary: $serverExe" -ForegroundColor Green

$modelPath = Join-Path $InstallDir "models\ggml-$Model.bin"
$args = @("-m", $modelPath, "--host", "127.0.0.1", "--port", $Port)

if ($RegisterLoginTask) {
    Write-Host ""
    Write-Host "Registering Task Scheduler entry 'WhisperServer' (runs at login)..." -ForegroundColor Cyan
    try { Unregister-ScheduledTask -TaskName "WhisperServer" -Confirm:$false -ErrorAction Stop } catch { }
    $action = New-ScheduledTaskAction -Execute $serverExe -Argument ($args -join " ") -WorkingDirectory $InstallDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName "WhisperServer" -Trigger $trigger -Action $action -Settings $settings -Principal $principal -Description "Smart Note / List Assistant: local whisper.cpp server for voice transcription." | Out-Null
    Write-Host "Task registered. It will start whisper-server on next login." -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Starting whisper-server once in the foreground. Ctrl+C to stop." -ForegroundColor Cyan
    Write-Host "  Launch:  $serverExe $($args -join ' ')"
    & $serverExe @args
}
