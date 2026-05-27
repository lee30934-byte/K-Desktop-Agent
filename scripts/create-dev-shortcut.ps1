<#
.SYNOPSIS
  Create a Desktop shortcut for KDA dev mode (npm run tauri:dev).

.DESCRIPTION
  Drops a "KDA Dev.lnk" on the current user's Desktop. Double-clicking it
  launches PowerShell, cd's into this repo, and runs `npm run tauri:dev`.

  Idempotent: re-running just overwrites the existing shortcut with the
  current repo path. Safe to run on every new PC.

  NOTE: This script is intentionally ASCII-only. PowerShell 5.1 on Korean
  Windows can mis-decode BOM-less UTF-8 .ps1 files that contain Hangul,
  causing parser errors. Keeping this file pure ASCII sidesteps that whole
  family of encoding pitfalls (see pitfall_powershell_secret_bom.md).

.PARAMETER NoExit
  Add -NoExit to the shortcut so the PowerShell window stays open after
  npm exits (so you can read errors). Default ON. Pass -NoExit:$false to
  make the window auto-close.

.EXAMPLE
  .\scripts\create-dev-shortcut.ps1

.EXAMPLE
  .\scripts\create-dev-shortcut.ps1 -NoExit:$false   # auto-close window
#>
param(
    [switch]$NoExit = $true
)

$ErrorActionPreference = 'Stop'

# Resolve the repo root relative to this script (so it works no matter where
# the user calls it from — `.\scripts\create-dev-shortcut.ps1` or absolute).
$repo = Split-Path -Parent $PSScriptRoot

# Find a meaningful icon. icon.ico ships with the Tauri bundle; fall back to
# powershell.exe's icon if the file is missing (e.g. fresh clone before build).
$iconPath = Join-Path $repo 'src-tauri\icons\icon.ico'
if (Test-Path $iconPath) {
    $iconLocation = "$iconPath,0"
} else {
    $iconLocation = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe,0"
}

# Build the PowerShell arguments. -NoExit keeps the console open for log review.
$noExitFlag = if ($NoExit) { "-NoExit " } else { "" }
$psArgs     = "$($noExitFlag)-ExecutionPolicy Bypass -Command `"cd '$repo'; npm run tauri:dev`""

# Create / overwrite the .lnk on the Desktop.
$lnkPath = Join-Path $env:USERPROFILE 'Desktop\KDA Dev.lnk'

$WshShell = New-Object -ComObject WScript.Shell
$shortcut = $WshShell.CreateShortcut($lnkPath)
$shortcut.TargetPath       = 'powershell.exe'
$shortcut.Arguments        = $psArgs
$shortcut.WorkingDirectory = $repo
$shortcut.IconLocation     = $iconLocation
$shortcut.Description      = 'K Desktop Agent - Dev Mode (npm run tauri:dev)'
$shortcut.Save()

Write-Host ""
Write-Host "[OK] Desktop shortcut created" -ForegroundColor Green
Write-Host "  Path  : $lnkPath"
Write-Host "  Target: powershell.exe $psArgs"
Write-Host "  WD    : $repo"
Write-Host "  Icon  : $iconLocation"
Write-Host ""
Write-Host "Double-click 'KDA Dev' on your Desktop to launch dev mode." -ForegroundColor Cyan
