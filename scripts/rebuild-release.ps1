#Requires -Version 5.1
<#
.SYNOPSIS
  Rebuild + restart release binary.

.DESCRIPTION
  Recompiles src-tauri/target/release/k-desktop-agent.exe with latest code.
  Steps: preflight -> kill existing release app -> sidecar build -> tauri build --no-bundle -> optional launch.
  MSI/NSIS bundle is skipped; takes roughly 1-5 minutes (incremental).

.PARAMETER Launch
  Start the new binary after a successful build.

.PARAMETER SkipPreflight
  Skip cargo check / tsc preflight (emergency rebuild).

.EXAMPLE
  .\scripts\rebuild-release.ps1
  .\scripts\rebuild-release.ps1 -Launch
#>

param(
    [switch]$Launch,
    [switch]$SkipPreflight
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$releaseExe = Join-Path $projectRoot "src-tauri\target\release\k-desktop-agent.exe"

function Write-Step($msg) {
    Write-Host ""
    Write-Host "[STEP] $msg" -ForegroundColor Cyan
}

# 1. Preflight
if (-not $SkipPreflight) {
    Write-Step "Preflight check"
    & "$PSScriptRoot\check.ps1" -SkipDeps
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Preflight failed - aborting build" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "Preflight skipped (-SkipPreflight)" -ForegroundColor DarkYellow
}

# 2. Kill running release app (leave dev debug build alone)
Write-Step "Stop existing release app (if running)"
$existing = Get-Process -Name "k-desktop-agent" -ErrorAction SilentlyContinue
if ($existing) {
    $toKill = $existing | Where-Object { $_.Path -eq $releaseExe }
    if ($toKill) {
        $toKill | ForEach-Object {
            Write-Host "  kill PID $($_.Id)" -ForegroundColor DarkGray
            Stop-Process -Id $_.Id -Force
        }
        Start-Sleep -Seconds 1
    } else {
        Write-Host "  no release instance (dev/debug builds untouched)" -ForegroundColor DarkGray
    }
} else {
    Write-Host "  no k-desktop-agent process" -ForegroundColor DarkGray
}

# 3. Sidecar build (TS -> dist/index.js)
# cmd /c 경유 — PowerShell 5.1 의 native command stderr wrapping 함정 회피.
Write-Step "Sidecar build (tsc)"
Push-Location "$projectRoot\sidecar"
try {
    & cmd.exe /c "npm run build 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "sidecar build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

# 4. Tauri release build (no bundle)
# cmd.exe 경유로 호출 — Tauri/cargo/node 가 stderr 에 정보 메시지를 뿌리는데
# Windows PowerShell 5.1 은 native command 의 stderr 라인을 NativeCommandError 로 wrap 해서
# ErrorActionPreference="Stop" 환경에선 정보 메시지 한 줄에 throw 됨. cmd 내부에서 2>&1 로
# 합치면 stderr 가 PowerShell 까지 안 올라와 함정 회피.
Write-Step "Tauri release build (no-bundle)"
$buildStart = Get-Date
& cmd.exe /c "npm run tauri build -- --no-bundle 2>&1"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}
$buildSecs = [int]((Get-Date) - $buildStart).TotalSeconds
Write-Host "Build OK ($buildSecs s)" -ForegroundColor Green

if (-not (Test-Path $releaseExe)) {
    Write-Host "Binary missing at: $releaseExe" -ForegroundColor Red
    exit 1
}

$size = [math]::Round((Get-Item $releaseExe).Length / 1MB, 1)
Write-Host "Binary: $releaseExe ($size MB)" -ForegroundColor Gray

# 5. Sync to install dir if K is running the installed version
#    (Tauri single-instance plugin rejects the dev release exe when the install version is alive,
#     so just re-launching the dev exe doesn't update K's actual workflow. We instead copy the
#     freshly built sidecar/dist + hooks into the install dir so the next sidecar respawn picks them up.)
$installSidecar = Join-Path $env:LOCALAPPDATA 'K Desktop Agent\_up_\sidecar'
$installExe = Join-Path $env:LOCALAPPDATA 'K Desktop Agent\k-desktop-agent.exe'
$installDistFile = Join-Path $installSidecar 'dist\index.js'
if (Test-Path $installDistFile) {
    Write-Step "Sync sidecar to install dir (K's actual runtime)"
    $installRunning = Get-Process -Name 'k-desktop-agent' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $installExe }
    if ($installRunning) {
        Write-Host "  install version running — sidecar respawn picks up new files on next message" -ForegroundColor DarkGray
    }

    # Backup current dist with timestamp suffix
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item $installDistFile "$installDistFile.before-$stamp" -Force
    Write-Host "  backup: dist\index.js.before-$stamp" -ForegroundColor DarkGray

    # Sync dist
    Copy-Item "$projectRoot\sidecar\dist\index.js" $installDistFile -Force
    $newSize = [int](Get-Item $installDistFile).Length
    Write-Host "  synced: dist\index.js ($newSize bytes)" -ForegroundColor DarkGray

    # Sync hooks (whole folder mirror)
    $installHooks = Join-Path $installSidecar 'hooks'
    New-Item -ItemType Directory -Force -Path $installHooks | Out-Null
    Get-ChildItem "$projectRoot\sidecar\hooks\*.mjs" -ErrorAction SilentlyContinue | ForEach-Object {
        Copy-Item $_.FullName $installHooks -Force
    }
    $hookCount = (Get-ChildItem "$installHooks\*.mjs" -ErrorAction SilentlyContinue).Count
    Write-Host "  synced: hooks\ ($hookCount .mjs files)" -ForegroundColor DarkGray
}

# 6. Optional launch
if ($Launch) {
    Write-Step "Launch new binary"
    Start-Process -FilePath $releaseExe -WorkingDirectory $projectRoot
    Write-Host "Launched (note: if install version is running, single-instance plugin focuses it instead)" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Tip: re-run with -Launch to start immediately, or use the desktop shortcut." -ForegroundColor Gray
}
