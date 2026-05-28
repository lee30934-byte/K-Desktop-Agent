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

# ─── 5. Tauri resources 사전 빌드 ───
# fresh clone 직후 첫 `npm run tauri:dev` 가 자주 세 가지 누락으로 막힘:
#   (a) sidecar/dist/ — sidecar TypeScript 빌드 산출물
#   (b) node-bundle/  — portable Node.js (KDA 설치본 안에 박힘)
#   (c) bundled-mcp/  — K-Personal-MCP (.gitignore 처리, release.yml 만 받음)
# 셋 다 tauri.conf.json 의 resources 배열에 박혀 있어 빌드 시 glob 매칭 필요.
# 여기서 미리 빌드해두면 첫 dev 실행이 즉시 가능.
Write-Step "5/6. Tauri resources 사전 빌드 (sidecar + node-bundle + bundled-mcp)"
if (Test-Command "npm") {
    Write-Host "  sidecar TypeScript 빌드 중..."
    npm run sidecar:build
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✓ sidecar/dist/ 빌드 완료" -ForegroundColor Green
    } else {
        Write-Warning "  ⚠ sidecar 빌드 실패 — 나중에 'npm run sidecar:build' 수동 실행"
    }

    if (-not (Test-Path (Join-Path $projectRoot "node-bundle\node.exe"))) {
        Write-Host "  portable Node.js 다운로드 + 압축 해제 중 (~30초, ~50MB)..."
        & (Join-Path $projectRoot "scripts\bundle-node.ps1")
        if (Test-Path (Join-Path $projectRoot "node-bundle\node.exe")) {
            Write-Host "  ✓ node-bundle/ 준비 완료" -ForegroundColor Green
        } else {
            Write-Warning "  ⚠ node-bundle 생성 실패 — 나중에 '.\scripts\bundle-node.ps1' 수동 실행"
        }
    } else {
        Write-Host "  ✓ node-bundle 이미 존재" -ForegroundColor Green
    }

    # K-Personal-MCP clone (.gitignore 처리되어 있어서 fresh clone 시 누락됨)
    $bundledMcpServer = Join-Path $projectRoot "bundled-mcp\server.py"
    if (-not (Test-Path $bundledMcpServer)) {
        Write-Host "  K-Personal-MCP repo clone 중 (bundled-mcp/)..."
        $bundledMcpDir = Join-Path $projectRoot "bundled-mcp"
        if (Test-Path $bundledMcpDir) {
            # 빈 폴더만 있는 경우 (이전 시도 흔적) — 삭제 후 clone
            Remove-Item -Recurse -Force $bundledMcpDir -ErrorAction SilentlyContinue
        }
        & git clone --depth=1 "https://github.com/lee30934-byte/K-Personal-MCP.git" $bundledMcpDir
        if (Test-Path $bundledMcpServer) {
            # .git 폴더 제거 — Tauri bundle.resources 에 들어가면 안 됨 (크기/privacy)
            Remove-Item -Recurse -Force (Join-Path $bundledMcpDir ".git") -ErrorAction SilentlyContinue
            Write-Host "  ✓ bundled-mcp/ 준비 완료" -ForegroundColor Green
        } else {
            Write-Warning "  ⚠ bundled-mcp clone 실패 — 나중에 수동 실행:"
            Write-Warning "      git clone --depth=1 https://github.com/lee30934-byte/K-Personal-MCP.git bundled-mcp"
            Write-Warning "      Remove-Item -Recurse -Force bundled-mcp\.git"
        }
    } else {
        Write-Host "  ✓ bundled-mcp 이미 존재" -ForegroundColor Green
    }
} else {
    Write-Warning "  ⚠ npm 이 없어 resources 사전 빌드 skip — 새 PowerShell 후 수동 실행:"
    Write-Warning "      npm run sidecar:build"
    Write-Warning "      .\scripts\bundle-node.ps1"
    Write-Warning "      git clone --depth=1 https://github.com/lee30934-byte/K-Personal-MCP.git bundled-mcp"
}

# ─── 6. 아이콘 확인 ───
Write-Step "6/6. 아이콘 확인"
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
Write-Host "  3. npm run tauri:dev   # 로컬 개발용 KDA 실행 — 첫 실행 2~5분 ☕"
Write-Host ""
Write-Host "Release 빌드 흐름 (다른 PC 에서도 동일):" -ForegroundColor Yellow
Write-Host "  1. 코드 수정 + npm run build (TypeScript 검증)"
Write-Host "  2. version bump (package.json / Cargo.toml / tauri.conf.json / Cargo.lock 4개 동기화)"
Write-Host "  3. git commit + git tag vX.Y.Z + git push origin main + git push origin vX.Y.Z"
Write-Host "  4. GitHub Actions 가 자동 빌드 + sign + release publish (~14분)"
Write-Host ""
Write-Host "Signing key 는 GitHub Secrets 에만 — PC 어디에도 보관 불필요." -ForegroundColor DarkGray
Write-Host "자세한 안내: docs\DEV_SETUP.md" -ForegroundColor DarkGray
