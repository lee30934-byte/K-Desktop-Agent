# ═══════════════════════════════════════════════════════════════
# K Desktop Agent Release Build Script
# Phase 5: MSI/NSIS 인스톨러 빌드
# ═══════════════════════════════════════════════════════════════

param(
    [switch]$SkipSidecar,
    [switch]$Debug
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$SidecarDir = Join-Path $ProjectRoot "sidecar"

Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  K Desktop Agent - Release Build" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# 1. Node.js 체크
Write-Host "[1/5] Node.js 버전 확인..." -ForegroundColor Yellow
$nodeVersion = node --version 2>$null
if (-not $nodeVersion) {
    Write-Host "ERROR: Node.js가 설치되어 있지 않습니다." -ForegroundColor Red
    exit 1
}
Write-Host "  Node.js: $nodeVersion" -ForegroundColor Green

# 2. Rust 체크
Write-Host "[2/5] Rust 버전 확인..." -ForegroundColor Yellow
$rustVersion = rustc --version 2>$null
if (-not $rustVersion) {
    Write-Host "ERROR: Rust가 설치되어 있지 않습니다." -ForegroundColor Red
    exit 1
}
Write-Host "  Rust: $rustVersion" -ForegroundColor Green

# 3. Frontend 종속성 설치
Write-Host "[3/5] 프론트엔드 종속성 설치..." -ForegroundColor Yellow
Push-Location $ProjectRoot
try {
    npm ci --silent
    if ($LASTEXITCODE -ne 0) { throw "npm ci 실패" }
    Write-Host "  프론트엔드 종속성 설치 완료" -ForegroundColor Green
} finally {
    Pop-Location
}

# 4. Sidecar 빌드
if (-not $SkipSidecar) {
    Write-Host "[4/5] Sidecar 빌드..." -ForegroundColor Yellow
    Push-Location $SidecarDir
    try {
        npm ci --silent
        if ($LASTEXITCODE -ne 0) { throw "sidecar npm ci 실패" }

        npm run build
        if ($LASTEXITCODE -ne 0) { throw "sidecar 빌드 실패" }

        Write-Host "  Sidecar 빌드 완료" -ForegroundColor Green
    } finally {
        Pop-Location
    }
} else {
    Write-Host "[4/5] Sidecar 빌드 건너뜀 (-SkipSidecar)" -ForegroundColor DarkGray
}

# 5. Tauri 빌드
Write-Host "[5/5] Tauri 릴리스 빌드..." -ForegroundColor Yellow
Push-Location $ProjectRoot
try {
    if ($Debug) {
        npm run tauri build -- --debug
    } else {
        npm run tauri build
    }

    if ($LASTEXITCODE -ne 0) { throw "Tauri 빌드 실패" }
    Write-Host "  Tauri 빌드 완료" -ForegroundColor Green
} finally {
    Pop-Location
}

# 결과 출력
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  빌드 완료!" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan

$OutputDir = Join-Path $ProjectRoot "src-tauri\target\release\bundle"
if (Test-Path $OutputDir) {
    Write-Host ""
    Write-Host "출력 파일:" -ForegroundColor Yellow

    $msiFiles = Get-ChildItem -Path "$OutputDir\msi" -Filter "*.msi" -ErrorAction SilentlyContinue
    $nsisFiles = Get-ChildItem -Path "$OutputDir\nsis" -Filter "*.exe" -ErrorAction SilentlyContinue

    foreach ($f in $msiFiles) {
        Write-Host "  MSI:  $($f.FullName)" -ForegroundColor White
        Write-Host "        Size: $([math]::Round($f.Length / 1MB, 2)) MB" -ForegroundColor DarkGray
    }

    foreach ($f in $nsisFiles) {
        Write-Host "  NSIS: $($f.FullName)" -ForegroundColor White
        Write-Host "        Size: $([math]::Round($f.Length / 1MB, 2)) MB" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "NOTE: Windows SmartScreen 경고가 표시될 수 있습니다." -ForegroundColor DarkYellow
Write-Host "      코드 서명이 없는 앱은 '자세히 보기' > '실행'으로 진행하세요." -ForegroundColor DarkYellow
