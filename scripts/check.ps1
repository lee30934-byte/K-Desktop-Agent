#Requires -Version 5.1
<#
.SYNOPSIS
  Preflight 검증 — Phase 완료 또는 커밋 전에 전체 빌드/타입 체크.

.DESCRIPTION
  아래 항목을 순서대로 검증합니다. 실패 시 비-제로 종료코드.

  1. Rust   : cargo check --manifest-path src-tauri/Cargo.toml --all-targets
  2. Front  : tsc --noEmit (tsconfig.json)
  3. Sidecar: tsc --noEmit (sidecar/tsconfig.json)
  4. Tests  : sidecar/test-perm-gate.mjs, test-hook-overwriteGuard.mjs, test-cmdline-limit.mjs,
              test-context-meter.mjs, test-headless-mcp.mjs (Phase 13),
              test-codex-integration.mjs (Phase 15)
  5. Deps   : package.json 과 실제 설치 상태 일치 여부 (npm ls)

.EXAMPLE
  .\scripts\check.ps1
  .\scripts\check.ps1 -SkipDeps   # 빠른 반복 시 의존성 검사 생략
#>

param(
    [switch]$SkipDeps
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$failures = @()

function Write-Section($title) {
    Write-Host ""
    Write-Host "──────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host " $title" -ForegroundColor Cyan
    Write-Host "──────────────────────────────────────────────" -ForegroundColor DarkGray
}

function Invoke-Step($name, $scriptBlock) {
    Write-Host "▶ $name ..." -ForegroundColor Yellow
    $start = Get-Date
    try {
        & $scriptBlock
        if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
            throw "exit code $LASTEXITCODE"
        }
        $elapsed = [int]((Get-Date) - $start).TotalSeconds
        Write-Host "✓ $name ($elapsed s)" -ForegroundColor Green
    } catch {
        $elapsed = [int]((Get-Date) - $start).TotalSeconds
        Write-Host "✗ $name 실패: $_ ($elapsed s)" -ForegroundColor Red
        $script:failures += $name
    }
}

Write-Section "K Desktop Agent — Preflight Check"
Write-Host "프로젝트: $projectRoot" -ForegroundColor Gray

# 1. Rust 컴파일 체크
Invoke-Step "Rust cargo check" {
    cargo check --manifest-path src-tauri/Cargo.toml --all-targets --quiet
}

# 2. 프론트 타입 체크
Invoke-Step "Frontend tsc --noEmit" {
    npx --yes tsc --noEmit --project tsconfig.json
}

# 3. sidecar 타입 체크
Invoke-Step "Sidecar tsc --noEmit" {
    npx --yes tsc --noEmit --project sidecar/tsconfig.json
}

# 4. sidecar 회귀 테스트들 — 권한 게이트 / 덮어쓰기 hook / cmdline 길이 한계 / 컨텍스트 미터 / Phase 13.
#    한 번이라도 실패하면 Phase 완료 / 커밋 / release 빌드 금지.
Invoke-Step "Sidecar tests (perm-gate + hook + cmdline-limit + context-meter + headless-mcp + codex)" {
    $testFiles = @(
        "sidecar/test-perm-gate.mjs",
        "sidecar/test-hook-overwriteGuard.mjs",
        "sidecar/test-cmdline-limit.mjs",
        "sidecar/test-context-meter.mjs",
        "sidecar/test-headless-mcp.mjs",
        "sidecar/test-codex-integration.mjs"
    )
    foreach ($t in $testFiles) {
        Write-Host "  • $t" -ForegroundColor DarkGray
        node $t
        if ($LASTEXITCODE -ne 0) {
            throw "test failed: $t (exit $LASTEXITCODE)"
        }
    }
}

# 5. 의존성 설치 상태 체크 (선언 <-> 설치 불일치 감지)
if (-not $SkipDeps) {
    Invoke-Step "npm ls (root, depth=0)" {
        # npm ls 는 extraneous/missing 이 있으면 exit 1. 우리는 missing 만 문제 삼으므로 경고를 필터링.
        $out = npm ls --depth=0 --json 2>$null | ConvertFrom-Json
        if ($out.problems) {
            $missing = $out.problems | Where-Object { $_ -match "missing" }
            if ($missing) {
                Write-Host "누락된 패키지:" -ForegroundColor Red
                $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
                throw "missing packages detected"
            }
        }
    }

    Invoke-Step "npm ls (sidecar, depth=0)" {
        Push-Location sidecar
        try {
            $out = npm ls --depth=0 --json 2>$null | ConvertFrom-Json
            if ($out.problems) {
                $missing = $out.problems | Where-Object { $_ -match "missing" }
                if ($missing) {
                    Write-Host "누락된 패키지:" -ForegroundColor Red
                    $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
                    throw "missing packages detected"
                }
            }
        } finally {
            Pop-Location
        }
    }
} else {
    Write-Host "⚠ 의존성 검사 스킵 (-SkipDeps)" -ForegroundColor DarkYellow
}

# 결과
Write-Section "결과"
if ($failures.Count -eq 0) {
    Write-Host "✓ 모든 검사 통과" -ForegroundColor Green
    exit 0
} else {
    Write-Host "✗ 실패한 검사 ($($failures.Count)):" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
