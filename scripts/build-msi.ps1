#Requires -Version 5.1
<#
.SYNOPSIS
  릴리즈 빌드 (MSI/NSIS 인스톨러 생성)
#>

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "▶ K Desktop Agent 릴리즈 빌드..." -ForegroundColor Cyan
Write-Host "  시간: 3~10분. LTO 최적화 중 커피 한 잔." -ForegroundColor Gray
Write-Host ""

npm run tauri:build

$bundleDir = Join-Path $projectRoot "src-tauri\target\release\bundle"
Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  빌드 완료!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "결과물 위치:" -ForegroundColor Yellow

$msiFiles = Get-ChildItem -Path $bundleDir -Filter "*.msi" -Recurse -ErrorAction SilentlyContinue
foreach ($f in $msiFiles) {
    Write-Host "  MSI: $($f.FullName)"
}

$nsisFiles = Get-ChildItem -Path $bundleDir -Filter "*-setup.exe" -Recurse -ErrorAction SilentlyContinue
foreach ($f in $nsisFiles) {
    Write-Host "  NSIS: $($f.FullName)"
}

Write-Host ""
Write-Host "탐색기로 열기: explorer `"$bundleDir`"" -ForegroundColor Gray
