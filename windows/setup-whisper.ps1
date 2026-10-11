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
    # Pinned to v1.9.2: the ggml-org "latest" release can be source-only
    # (v1.9.5 has 0 assets); its stale ggerganov predecessor is 404.
    [string]$WhisperReleaseUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-blas-bin-x64.zip",
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
        # The v1.9.x archive drops everything inside a Release\ subdirectory;
        # flatten it so the server/model paths below find the exe.
        $releaseDir = Join-Path $InstallDir "Release"
        if (Test-Path $releaseDir) {
            Write-Host "Flattening Release\ subdirectory..." -ForegroundColor Yellow
            Get-ChildItem -Path $releaseDir -Force | Move-Item -Destination $InstallDir -Force
            Remove-Item -Path $releaseDir -Recurse -Force
        }
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
    Write-Host "Registering 'WhisperServer' at-login autostart..." -ForegroundColor Cyan
    # Prefer Task Scheduler (needs elevation on most Windows installs); fall
    # back to a hidden VBS in the user Startup folder when it's blocked.
    $registered = $false
    try {
        try { Unregister-ScheduledTask -TaskName "WhisperServer" -Confirm:$false -ErrorAction Stop } catch { }
        $action = New-ScheduledTaskAction -Execute $serverExe -Argument ($args -join " ") -WorkingDirectory $InstallDir
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName "WhisperServer" -Trigger $trigger -Action $action -Settings $settings -Principal $principal -Description "Smart Note / List Assistant: local whisper.cpp server for voice transcription." -ErrorAction Stop | Out-Null
        Write-Host "Scheduled task registered. Starts whisper-server at every login." -ForegroundColor Green
        $registered = $true
    } catch {
        Write-Host "Task Scheduler denied (needs elevation): $($_.Exception.Message.Split([Environment]::NewLine)[0])" -ForegroundColor Yellow
    }
    if (-not $registered) {
        $startup = [Environment]::GetFolderPath('Startup')
        $vbs = Join-Path $startup 'WhisperServer.vbs'
        $vbsBody = @"
' Smart Note / List Assistant: start whisper.cpp server hidden at user login.
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """$serverExe"" $($args -join ' ')", 0, False
"@
        Set-Content -Path $vbs -Value $vbsBody -Encoding ascii
        Write-Host "Fell back to Startup folder VBS: $vbs" -ForegroundColor Green
        Write-Host "Runs hidden at every user login. No elevation required." -ForegroundColor Green
    }
} else {
    Write-Host ""
    Write-Host "Starting whisper-server once in the foreground. Ctrl+C to stop." -ForegroundColor Cyan
    Write-Host "  Launch:  $serverExe $($args -join ' ')"
    & $serverExe @args
}
