<#
.SYNOPSIS
  K Desktop Agent 의 바탕화면 + 시작 메뉴 바로가기를 생성합니다.
  옵션으로 Windows 시작 시 자동 실행 등록도 가능.

.USAGE
  .\scripts\setup-shortcuts.ps1                # dev 모드 (launch.vbs → npm run tauri:dev)
  .\scripts\setup-shortcuts.ps1 -Release       # release 모드 (k-desktop-agent.exe 직접 실행) — 권장
  .\scripts\setup-shortcuts.ps1 -Release -AutoStart
  .\scripts\setup-shortcuts.ps1 -Remove        # 제거

.NOTES
  -Release 모드를 쓰려면 먼저 `npm run tauri build -- --no-bundle` 로 바이너리를 빌드해야 합니다.
  release 바이너리는 dev watcher 가 없어서 코드 변경에도 꺼지지 않습니다.
#>

param(
    [switch]$AutoStart,
    [switch]$Remove,
    [switch]$Release
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $projectRoot "scripts\launch.vbs"
$releaseExe = Join-Path $projectRoot "src-tauri\target\release\k-desktop-agent.exe"
$iconPath = Join-Path $projectRoot "src-tauri\icons\icon.ico"

if ($Release) {
    if (-not (Test-Path $releaseExe)) {
        Write-Error "release 바이너리 없음: $releaseExe`n먼저 빌드 필요: npm run tauri build -- --no-bundle"
        exit 1
    }
} else {
    if (-not (Test-Path $launcher)) {
        Write-Error "launcher 없음: $launcher"
        exit 1
    }
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

$modeLabel = if ($Release) { "RELEASE (production .exe)" } else { "DEV (launch.vbs → npm tauri:dev)" }
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  K Desktop Agent - 바로가기 설치" -ForegroundColor Cyan
Write-Host "  모드: $modeLabel" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 타겟 결정: release 면 .exe 직접, 아니면 wscript → vbs
if ($Release) {
    $linkTarget = $releaseExe
    $linkArgs = ""
    $autoStartArgs = "--minimized"
} else {
    $linkTarget = "$env:SystemRoot\System32\wscript.exe"
    $linkArgs = "`"$launcher`""
    $autoStartArgs = "`"$launcher`" --minimized"
}

# 1. 바탕화면
Write-Host "`n▶ 바탕화면 바로가기 생성..."
New-Shortcut -Path $desktopLink `
    -Target $linkTarget `
    -Arguments $linkArgs `
    -WorkingDirectory $projectRoot `
    -IconLocation "$iconPath,0" `
    -Description "K Desktop Agent - Personal Automation"
Write-Host "  ✓ $desktopLink" -ForegroundColor Green

# 2. 시작 메뉴
Write-Host "`n▶ 시작 메뉴 바로가기 생성..."
New-Shortcut -Path $startMenuLink `
    -Target $linkTarget `
    -Arguments $linkArgs `
    -WorkingDirectory $projectRoot `
    -IconLocation "$iconPath,0" `
    -Description "K Desktop Agent - Personal Automation"
Write-Host "  ✓ $startMenuLink" -ForegroundColor Green

# 3. 시작 프로그램 (옵션)
if ($AutoStart) {
    Write-Host "`n▶ Windows 시작 시 자동 실행 등록 (숨김 모드)..."
    New-Shortcut -Path $startupLink `
        -Target $linkTarget `
        -Arguments $autoStartArgs `
        -WorkingDirectory $projectRoot `
        -IconLocation "$iconPath,0" `
        -Description "K Desktop Agent (background)"
    Write-Host "  ✓ $startupLink" -ForegroundColor Green
} else {
    Write-Host "`n💡 Windows 시작 시 자동 실행도 원하시면: -AutoStart 추가" -ForegroundColor Gray
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
