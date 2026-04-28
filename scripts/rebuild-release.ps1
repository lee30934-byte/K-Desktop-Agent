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
Write-Step "Sidecar build (tsc)"
Push-Location "$projectRoot\sidecar"
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "sidecar build failed" }
} finally {
    Pop-Location
}

# 4. Tauri release build (no bundle)
Write-Step "Tauri release build (no-bundle)"
$buildStart = Get-Date
npm run tauri build -- --no-bundle
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed" -ForegroundColor Red
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

# 5. Optional launch
if ($Launch) {
    Write-Step "Launch new binary"
    Start-Process -FilePath $releaseExe -WorkingDirectory $projectRoot
    Write-Host "Launched" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Tip: re-run with -Launch to start immediately, or use the desktop shortcut." -ForegroundColor Gray
}
