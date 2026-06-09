# ═══════════════════════════════════════════════════════════════
# K Desktop Agent - 버전 자동 업데이트 스크립트
# ═══════════════════════════════════════════════════════════════
# 사용법:
#   .\scripts\bump-version.ps1 patch   # 0.1.0 → 0.1.1
#   .\scripts\bump-version.ps1 minor   # 0.1.0 → 0.2.0
#   .\scripts\bump-version.ps1 major   # 0.1.0 → 1.0.0
#   .\scripts\bump-version.ps1 0.2.5   # 직접 지정
# ═══════════════════════════════════════════════════════════════

param(
    [Parameter(Mandatory=$true)]
    [string]$VersionArg
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
[Environment]::CurrentDirectory = $ProjectRoot

# ─── 버전 파일 경로들 ───────────────────────────────────────────
$FILES = @{
    "package.json"           = "$ProjectRoot\package.json"
    "Cargo.toml"             = "$ProjectRoot\src-tauri\Cargo.toml"
    "tauri.conf.json"        = "$ProjectRoot\src-tauri\tauri.conf.json"
}

# ─── 현재 버전 읽기 ─────────────────────────────────────────────
function Get-CurrentVersion {
    $pkg = Get-Content $FILES["package.json"] | ConvertFrom-Json
    return $pkg.version
}

# ─── 버전 파싱 ──────────────────────────────────────────────────
function Parse-Version([string]$ver) {
    $parts = $ver -split '\.'
    return @{
        Major = [int]$parts[0]
        Minor = [int]$parts[1]
        Patch = [int]$parts[2]
    }
}

# ─── 새 버전 계산 ───────────────────────────────────────────────
function Get-NewVersion([string]$current, [string]$arg) {
    $v = Parse-Version $current

    switch ($arg.ToLower()) {
        "patch" {
            $v.Patch += 1
        }
        "minor" {
            $v.Minor += 1
            $v.Patch = 0
        }
        "major" {
            $v.Major += 1
            $v.Minor = 0
            $v.Patch = 0
        }
        default {
            # 직접 버전 지정 (예: 0.2.5)
            if ($arg -match '^\d+\.\d+\.\d+$') {
                return $arg
            } else {
                throw "잘못된 버전 형식: $arg (예: patch, minor, major, 또는 0.2.5)"
            }
        }
    }

    return "$($v.Major).$($v.Minor).$($v.Patch)"
}

# ─── package.json 업데이트 ──────────────────────────────────────
function Update-PackageJson([string]$newVersion) {
    $path = $FILES["package.json"]
    $content = Get-Content $path -Raw
    $content = $content -replace '"version":\s*"[^"]+"', "`"version`": `"$newVersion`""
    Set-Content $path $content -NoNewline
    Write-Host "  ✓ package.json" -ForegroundColor Green
}

# ─── package-lock.json 업데이트 ─────────────────────────────────
function Update-PackageLock([string]$newVersion) {
    $path = "$ProjectRoot\package-lock.json"
    $content = Get-Content $path -Raw | ConvertFrom-Json
    $content.version = $newVersion
    if ($content.packages -and $content.packages."" -and $content.packages."".version) {
        $content.packages."".version = $newVersion
    }
    $json = $content | ConvertTo-Json -Depth 100
    Set-Content $path $json -NoNewline
    Write-Host "  ✓ package-lock.json" -ForegroundColor Green
}

# ─── Cargo.toml 업데이트 ────────────────────────────────────────
function Update-CargoToml([string]$newVersion) {
    $path = $FILES["Cargo.toml"]
    $content = Get-Content $path -Raw
    # [package] 섹션의 version만 변경 (첫 번째 version = 만 매칭)
    $content = $content -replace '(^\[package\][\s\S]*?version\s*=\s*")[^"]+(")', "`${1}$newVersion`${2}"
    Set-Content $path $content -NoNewline
    Write-Host "  ✓ Cargo.toml" -ForegroundColor Green
}

# ─── tauri.conf.json 업데이트 ───────────────────────────────────
function Update-TauriConf([string]$newVersion) {
    $path = $FILES["tauri.conf.json"]
    $content = Get-Content $path -Raw
    $content = $content -replace '"version":\s*"[^"]+"', "`"version`": `"$newVersion`""
    Set-Content $path $content -NoNewline
    Write-Host "  ✓ tauri.conf.json" -ForegroundColor Green
}

# ─── CHANGELOG 업데이트 ─────────────────────────────────────────
function Update-Changelog([string]$oldVersion, [string]$newVersion) {
    $path = "$ProjectRoot\CHANGELOG.md"
    $date = Get-Date -Format "yyyy-MM-dd"

    $newEntry = @"
## [$newVersion] - $date

### 변경사항
-

### 추가
-

### 수정
-

---

"@

    if (Test-Path $path) {
        $content = Get-Content $path -Raw
        # "## [" 앞에 새 엔트리 삽입
        if ($content -match '## \[') {
            $content = $content -replace '(## \[)', "$newEntry`$1"
        } else {
            $content = $newEntry + $content
        }
        Set-Content $path $content -NoNewline
    } else {
        # 새로 생성
        $header = @"
# Changelog

모든 주요 변경사항을 여기에 기록합니다.
형식: [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/)

$newEntry
"@
        Set-Content $path $header
    }
    Write-Host "  ✓ CHANGELOG.md" -ForegroundColor Green
}

# ═══════════════════════════════════════════════════════════════
# 메인 실행
# ═══════════════════════════════════════════════════════════════

Write-Host "원격 main/tag 기준으로 다음 버전 계산 중..." -ForegroundColor Cyan
$newVersion = (& node "$ProjectRoot\scripts\release-version-guard.mjs" next $VersionArg)
if ($LASTEXITCODE -ne 0) {
    throw "release-version-guard failed"
}
$currentVersion = Get-CurrentVersion

Write-Host ""
Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  K Desktop Agent 버전 업데이트" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "  현재 버전: " -NoNewline
Write-Host "$currentVersion" -ForegroundColor Yellow
Write-Host "  새 버전:   " -NoNewline
Write-Host "$newVersion" -ForegroundColor Green
Write-Host ""

# 확인
$confirm = Read-Host "진행할까요? (y/N)"
if ($confirm -ne 'y' -and $confirm -ne 'Y') {
    Write-Host "취소됨." -ForegroundColor Red
    exit 0
}

Write-Host ""
Write-Host "파일 업데이트 중..." -ForegroundColor Cyan

Update-PackageJson $newVersion
Update-PackageLock $newVersion
Update-CargoToml $newVersion
Update-TauriConf $newVersion
Update-Changelog $currentVersion $newVersion

Write-Host ""
Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  완료! v$newVersion" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "다음 단계:" -ForegroundColor Yellow
Write-Host "  1. CHANGELOG.md 에 변경사항 작성"
Write-Host "  2. git add -A && git commit -m 'chore: bump version to $newVersion'"
Write-Host "  3. git tag v$newVersion"
Write-Host "  4. npm run tauri:build"
Write-Host ""
