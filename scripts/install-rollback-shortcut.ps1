<#
.SYNOPSIS
  바탕화면에 "K-Desktop-Agent 비상복구" 바로가기 설치.

.DESCRIPTION
  rollback.ps1 을 PowerShell 로 실행하는 .lnk 파일을
  K 의 바탕화면에 만듭니다. LLM 통신 불능 시 K 가 더블클릭만으로 복구하기 위함.

.PARAMETER Remove
  바로가기 제거.
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$rollbackPs1 = Join-Path $root 'scripts\rollback.ps1'
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath 'K-Desktop-Agent 비상복구.lnk'

if ($Remove) {
  if (Test-Path $shortcutPath) {
    Remove-Item $shortcutPath -Force
    Write-Host "✅ 바로가기 제거: $shortcutPath" -ForegroundColor Green
  } else {
    Write-Host "바로가기 없음 (이미 제거됨)" -ForegroundColor DarkGray
  }
  exit 0
}

if (-not (Test-Path $rollbackPs1)) {
  Write-Host "❌ rollback.ps1 을 찾을 수 없음: $rollbackPs1" -ForegroundColor Red
  exit 1
}

$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($shortcutPath)
$sc.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$rollbackPs1`""
$sc.WorkingDirectory = $root
$sc.IconLocation = "$env:WINDIR\System32\imageres.dll,229"  # 빨간 경고 아이콘
$sc.Description = "K-Desktop-Agent 를 마지막 백업 시점으로 복원합니다 (LLM 통신 불능 시 비상용)"
$sc.Save()

Write-Host "✅ 바로가기 설치: $shortcutPath" -ForegroundColor Green
Write-Host "   대상: $rollbackPs1" -ForegroundColor DarkGray
Write-Host ""
Write-Host "사용법: 평소엔 무시하시고, 앱이 안 뜨거나 응답 안 할 때 더블클릭" -ForegroundColor Yellow
