#Requires -Version 5.1
<#
.SYNOPSIS
  K Desktop Agent 최초 환경 셋업 스크립트.

.DESCRIPTION
  Rust, Node.js, Visual Studio Build Tools를 winget으로 설치하고
  프로젝트 의존성(npm)까지 한 번에 끝냅니다.
  이미 설치된 도구는 건너뜁니다.

.USAGE
  PowerShell을 **관리자 권한**으로 열고:
    cd C:\Users\user\Documents\K-Desktop-Agent
    .\scripts\setup.ps1

.NOTES
  실행 정책 차단 시:
    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
#>

$ErrorActionPreference = "Stop"

function Write-Step($msg) {
    Write-Host ""
    Write-Host "▶ $msg" -ForegroundColor Cyan
}

function Test-Command($name) {
    $null = Get-Command $name -ErrorAction SilentlyContinue
    return $?
}

# 관리자 권한 확인
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Warning "관리자 권한 PowerShell이 아닙니다. winget 설치가 일부 실패할 수 있어요."
    $continue = Read-Host "그래도 계속하시겠습니까? (y/N)"
    if ($continue -ne "y") { exit 1 }
}

Write-Host "==========================================" -ForegroundColor Green
Write-Host "  K Desktop Agent - 환경 셋업" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green

# ─── 1. Rust ───
Write-Step "1/5. Rust 확인"
if (Test-Command "rustc") {
    $ver = rustc --version
    Write-Host "  ✓ 이미 설치됨: $ver" -ForegroundColor Green
} else {
    Write-Host "  Rust 설치 중..."
    winget install Rustlang.Rustup --accept-source-agreements --accept-package-agreements
    Write-Host "  ✓ Rust 설치 완료. 새 터미널에서 자동으로 PATH 인식됩니다." -ForegroundColor Green
    Write-Warning "  ⚠ 이 스크립트 완료 후 **새 PowerShell 창**을 열어 나머지 단계 진행 권장."
}

# ─── 2. Node.js ───
Write-Step "2/5. Node.js 확인"
if (Test-Command "node") {
    $ver = node --version
    Write-Host "  ✓ 이미 설치됨: $ver" -ForegroundColor Green
} else {
    Write-Host "  Node.js LTS 설치 중..."
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    Write-Host "  ✓ Node.js 설치 완료." -ForegroundColor Green
}

# ─── 3. Visual Studio Build Tools ───
Write-Step "3/5. Visual Studio Build Tools 확인"
# MSVC 링커 존재 여부로 대체 판단
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasMsvc = $false
if (Test-Path $vsWhere) {
    $vsInstances = & $vsWhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($vsInstances) { $hasMsvc = $true }
}

if ($hasMsvc) {
    Write-Host "  ✓ VC++ Build Tools 이미 설치됨" -ForegroundColor Green
} else {
    Write-Host "  VS 2022 Build Tools + C++ 워크로드 설치 중... (10~20분 소요)"
    winget install Microsoft.VisualStudio.2022.BuildTools `
        --accept-source-agreements `
        --accept-package-agreements `
        --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools;includeRecommended"
    Write-Host "  ✓ Build Tools 설치 완료. 시스템 재부팅 권장." -ForegroundColor Green
}

# ─── 4. npm 의존성 ───
Write-Step "4/5. npm 의존성 설치"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (Test-Command "npm") {
    Write-Host "  프론트엔드 + sidecar 의존성 설치 중..."
    npm install --no-audit --no-fund
    Write-Host "  ✓ npm 설치 완료" -ForegroundColor Green
} else {
    Write-Warning "  ⚠ npm이 PATH에 아직 인식 안 됨. 새 터미널을 열고 이 스크립트 재실행하세요."
    exit 0
}

# ─── 5. 아이콘 확인 ───
Write-Step "5/5. 아이콘 확인"
$iconDir = Join-Path $projectRoot "src-tauri\icons"
if (Test-Path (Join-Path $iconDir "icon.ico")) {
    Write-Host "  ✓ 아이콘 이미 있음 (임시 K 아이콘)" -ForegroundColor Green
} else {
    Write-Warning "  아이콘이 없습니다. 다음 방법 중 하나 선택:"
    Write-Host "    a) 원하는 정사각형 PNG를 프로젝트 루트에 icon.png로 두고:"
    Write-Host "       npx @tauri-apps/cli@latest icon .\icon.png"
    Write-Host "    b) 제공된 임시 아이콘 사용 (이미 icons 폴더에 있어야 함)"
}

# ─── 완료 ───
Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  셋업 완료!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "다음 단계:" -ForegroundColor Yellow
Write-Host "  1. **새 PowerShell 창**을 열어주세요 (PATH 갱신 위해)"
Write-Host "  2. cd $projectRoot"
Write-Host "  3. npm run tauri:dev"
Write-Host ""
Write-Host "최초 실행 시 Rust 의존성 컴파일로 2~5분 걸립니다. ☕"
