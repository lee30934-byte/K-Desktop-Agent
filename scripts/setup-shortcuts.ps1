<#
.SYNOPSIS
  K Desktop Agent 의 바탕화면 + 시작 메뉴 바로가기를 생성합니다.
  옵션으로 Windows 시작 시 자동 실행 등록도 가능.

.USAGE
  .\scripts\setup-shortcuts.ps1
  .\scripts\setup-shortcuts.ps1 -AutoStart
  .\scripts\setup-shortcuts.ps1 -Remove      # 제거
#>

param(
    [switch]$AutoStart,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $projectRoot "scripts\launch.vbs"
$iconPath = Join-Path $projectRoot "src-tauri\icons\icon.ico"

if (-not (Test-Path $launcher)) {
    Write-Error "launcher 없음: $launcher"
    exit 1
}

# 바로가기 대상 경로들
$desktopPath   = [Environment]::GetFolderPath('Desktop')
$startMenuPath = [Environment]::GetFolderPath('StartMenu') + "\Programs"
$startupPath   = [Environment]::GetFolderPath('Startup')

$desktopLink = Join-Path $desktopPath "K Desktop Agent.lnk"
$startMenuLink = Join-Path $startMenuPath "K Desktop Agent.lnk"
$startupLink = Join-Path $startupPath "K Desktop Agent.lnk"

function New-Shortcut {
    param(
        [string]$Path,
        [string]$Target,
        [string]$Arguments = "",
        [string]$WorkingDirectory = "",
        [string]$IconLocation = "",
        [string]$Description = ""
    )
    $WshShell = New-Object -ComObject WScript.Shell
    $shortcut = $WshShell.CreateShortcut($Path)
    $shortcut.TargetPath = $Target
    if ($Arguments) { $shortcut.Arguments = $Arguments }
    if ($WorkingDirectory) { $shortcut.WorkingDirectory = $WorkingDirectory }
    if ($IconLocation) { $shortcut.IconLocation = $IconLocation }
    if ($Description) { $shortcut.Description = $Description }
    $shortcut.Save()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($WshShell) | Out-Null
}

if ($Remove) {
    Write-Host "==========================================" -ForegroundColor Yellow
    Write-Host "  바로가기 제거" -ForegroundColor Yellow
    Write-Host "==========================================" -ForegroundColor Yellow
    foreach ($link in @($desktopLink, $startMenuLink, $startupLink)) {
        if (Test-Path $link) {
            Remove-Item $link -Force
            Write-Host "  ✓ 제거: $link" -ForegroundColor Green
        }
    }
    Write-Host "완료" -ForegroundColor Green
    exit 0
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  K Desktop Agent - 바로가기 설치" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# wscript.exe 가 .vbs 를 실행. 이게 타겟.
$wscript = "$env:SystemRoot\System32\wscript.exe"

# 1. 바탕화면
Write-Host "`n▶ 바탕화면 바로가기 생성..."
New-Shortcut -Path $desktopLink `
    -Target $wscript `
    -Arguments "`"$launcher`"" `
    -WorkingDirectory $projectRoot `
    -IconLocation "$iconPath,0" `
    -Description "K Desktop Agent - Personal Automation"
Write-Host "  ✓ $desktopLink" -ForegroundColor Green

# 2. 시작 메뉴
Write-Host "`n▶ 시작 메뉴 바로가기 생성..."
New-Shortcut -Path $startMenuLink `
    -Target $wscript `
    -Arguments "`"$launcher`"" `
    -WorkingDirectory $projectRoot `
    -IconLocation "$iconPath,0" `
    -Description "K Desktop Agent - Personal Automation"
Write-Host "  ✓ $startMenuLink" -ForegroundColor Green

# 3. 시작 프로그램 (옵션)
if ($AutoStart) {
    Write-Host "`n▶ Windows 시작 시 자동 실행 등록 (숨김 모드)..."
    New-Shortcut -Path $startupLink `
        -Target $wscript `
        -Arguments "`"$launcher`" --minimized" `
        -WorkingDirectory $projectRoot `
        -IconLocation "$iconPath,0" `
        -Description "K Desktop Agent (background)"
    Write-Host "  ✓ $startupLink" -ForegroundColor Green
} else {
    Write-Host "`n💡 Windows 시작 시 자동 실행도 원하시면: .\scripts\setup-shortcuts.ps1 -AutoStart" -ForegroundColor Gray
}

Write-Host "`n==========================================" -ForegroundColor Green
Write-Host "  설치 완료!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "▶ 사용법:" -ForegroundColor Yellow
Write-Host "  1. 바탕화면의 'K Desktop Agent' 더블클릭"
Write-Host "  2. PowerShell/cmd 창 없이 몇 초 후 앱이 뜸"
Write-Host "  3. 창 X 누르면 트레이로 숨음 (시스템 트레이 아이콘 클릭해 복원)"
Write-Host ""
Write-Host "▶ 실행 로그: $projectRoot\logs\launch.log" -ForegroundColor Gray
Write-Host "▶ 제거: .\scripts\setup-shortcuts.ps1 -Remove" -ForegroundColor Gray
