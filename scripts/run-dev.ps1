#Requires -Version 5.1
<#
.SYNOPSIS
  개발 모드 실행 (매번 쓰는 편의 스크립트)
#>

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "▶ K Desktop Agent 개발 모드 시작..." -ForegroundColor Cyan
Write-Host "  Ctrl+C로 종료, 창을 닫아도 이 터미널에서 Ctrl+C 한 번 더 필요할 수 있음." -ForegroundColor Gray
Write-Host ""

npm run tauri:dev
