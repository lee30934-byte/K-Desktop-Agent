#Requires -Version 5.1
<#
.SYNOPSIS
  Preflight 검증 — Phase 완료 또는 커밋 전에 전체 빌드/타입 체크.

.DESCRIPTION
  아래 항목을 순서대로 검증합니다. 실패 시 비-제로 종료코드.

  1. Rust   : cargo check --manifest-path src-tauri/Cargo.toml --all-targets
  2. Front  : tsc --noEmit (tsconfig.json)
  3. Sidecar: tsc --noEmit (sidecar/tsconfig.json)
  4. Tests  : sidecar/test-perm-gate.mjs, test-hook-overwriteGuard.mjs, test-hook-pitfallGuard.mjs, test-cmdline-limit.mjs,
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
# Set-Location 은 PowerShell provider 위치만 바꿀 뿐, .NET 의 프로세스 CWD
# ([Environment]::CurrentDirectory) 는 그대로다. [System.IO.File]::ReadAllBytes 같은
# .NET 상대경로 호출이 엉뚱한 cwd(예: 리셋된 작업폴더)를 보고 실패하는 함정 차단.
[Environment]::CurrentDirectory = $projectRoot

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
    # 이전 step 의 native exit code 잔존이 다음 step 의 throw 트리거를 잘못 작동시키는 것 방지.
    $global:LASTEXITCODE = 0
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
# Phase 66.5 (v0.6.6) — scripts/*.ps1 의 한글 + BOM 부재 조합 사전 차단.
#
# 배경: install-kpersonal-mcp.ps1 (v0.6.5 까지) 가 BOM 없이 한글 박힌 상태로 빌드 →
# K 의 한국어 Windows (CP949) PowerShell 5.1 이 한글을 깨뜨려 읽음 → "ERR 오류" 가
# "ERR ?�류" 로 깨져 parser 가 'ERR' token 못 알아봄 → 영구 실행 불가.
#
# K 가 클릭하는 모든 .ps1 (install-deps, install-kpersonal-mcp, backup, rollback) +
# K 가 빌드 시 직접 호출하는 ps1 (build-release, bump-version, ...) 다 동일 위험.
# 이 step 이 한 줄이라도 발견하면 빌드 차단. 메모리의 pitfall_powershell_secret_bom 의
# 반대 케이스 — 그 함정은 BOM 잘못 박힘, 이건 BOM 없어서 깨짐. 둘 다 인코딩 함정.
Invoke-Step "scripts/*.ps1 BOM 검증 (한글 인코딩 함정 차단)" {
    $broken = @()
    foreach ($f in Get-ChildItem "scripts\*.ps1") {
        $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
        if ($bytes.Length -lt 3) { continue }
        $hasBom = ($bytes[0] -eq 0xEF) -and ($bytes[1] -eq 0xBB) -and ($bytes[2] -eq 0xBF)
        # UTF-8 로 본문 읽어 한글 (가–힣) 포함 검사
        $text = [System.Text.Encoding]::UTF8.GetString($bytes)
        $hasHangul = $false
        foreach ($c in $text.ToCharArray()) {
            if ($c -ge [char]0xAC00 -and $c -le [char]0xD7A3) { $hasHangul = $true; break }
        }
        if ($hasHangul -and -not $hasBom) {
            $broken += $f.Name
        }
    }
    if ($broken.Count -gt 0) {
        Write-Host ""
        Write-Host "❌ 다음 .ps1 파일이 한글을 포함하면서 UTF-8 BOM 이 없습니다:" -ForegroundColor Red
        $broken | ForEach-Object { Write-Host "  - scripts/$_" -ForegroundColor Red }
        Write-Host ""
        Write-Host "한국어 Windows 의 PowerShell 5.1 은 BOM 없는 UTF-8 파일을 CP949 로" -ForegroundColor Yellow
        Write-Host "잘못 해석해 한글이 깨지고 parser 에러로 영구 실행 불가합니다." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "FIX:" -ForegroundColor Cyan
        Write-Host '  $utf8Bom = New-Object System.Text.UTF8Encoding $true' -ForegroundColor White
        Write-Host '  $content = [System.IO.File]::ReadAllText("scripts/<file>.ps1", [System.Text.Encoding]::UTF8)' -ForegroundColor White
        Write-Host '  [System.IO.File]::WriteAllText("scripts/<file>.ps1", $content, $utf8Bom)' -ForegroundColor White
        throw "PowerShell BOM 함정 — 위 파일들 fix 필수"
    }
    Write-Host "  모든 한글 .ps1 이 UTF-8 BOM 박혀있음 ✓" -ForegroundColor DarkGreen
}

# Phase 66.5 (v0.6.6) — bundle.resources 에 scripts/*.ps1 가 다 등록돼있는지 검증.
#
# 배경: v0.6.1 (Phase 66) 박을 때 install-kpersonal-mcp.ps1 을 tauri.conf.json 의
# bundle.resources 에 등록 누락 → 빌드는 통과해도 K 의 설치 폴더에 .ps1 자체가 안 박힘
# → resolve_script_path 가 8개 path 다 뒤져도 못 찾음.
#
# 이 step 은 Rust 가 spawn 하는 모든 scripts/*.ps1 이 tauri.conf.json 에 박혔는지 검증.
# 예외: build-release / bump-version / bundle-node / rebuild-release / check / setup /
# install-rollback-shortcut / run-dev / gui-smoke 같은 빌드 측 ps1 은 K 의 PC 가 아닌
# 빌드 서버에서만 호출 → 번들 미포함이 정상.
Invoke-Step "tauri.conf.json bundle.resources 의 scripts ps1 등록 검증" {
    $conf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
    $resources = @($conf.bundle.resources)
    # 런타임에 K 의 PC 에서 실행되는 .ps1 들 — Rust lib.rs 의 resolve_script_path 가 찾는 대상.
    # 새 ps1 추가 시 이 배열에도 박아야 검증됨.
    $runtimePs1 = @("install-deps.ps1", "install-kpersonal-mcp.ps1", "backup.ps1", "rollback.ps1")
    $missing = @()
    foreach ($name in $runtimePs1) {
        $expected = "../scripts/$name"
        if (-not ($resources -contains $expected)) {
            $missing += $name
        }
    }
    if ($missing.Count -gt 0) {
        Write-Host ""
        Write-Host "❌ 다음 .ps1 이 tauri.conf.json bundle.resources 에 없습니다:" -ForegroundColor Red
        $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
        Write-Host ""
        Write-Host "FIX: src-tauri/tauri.conf.json 의 bundle.resources 배열에 \"../scripts/<file>.ps1\" 추가" -ForegroundColor Yellow
        throw "tauri bundle resources 누락"
    }
    Write-Host "  $($runtimePs1.Count) 개 런타임 ps1 모두 등록됨 ✓" -ForegroundColor DarkGreen
}

Invoke-Step "Rust cargo check" {
    cargo check --manifest-path src-tauri/Cargo.toml --all-targets --quiet
}

# 2. 프론트 타입 체크 — Phase 25.1 (v0.5.12): npx 없는 환경에서도 동작하도록
#    node_modules 의 typescript bin 직접 호출로 fallback. CI 도 같은 path 쓰지만
#    K 의 PC 에서도 commit 전 tsc fail 사전 발견 가능.
function Invoke-Tsc($projectFile, $tscBin) {
    if (Test-Path $tscBin) {
        & node $tscBin --noEmit --project $projectFile
        if ($LASTEXITCODE -ne 0) { throw "tsc exit $LASTEXITCODE" }
    } else {
        npx --yes tsc --noEmit --project $projectFile
    }
}

Invoke-Step "Frontend tsc --noEmit" {
    Invoke-Tsc "tsconfig.json" "node_modules/typescript/bin/tsc"
}

# 3. sidecar 타입 체크
Invoke-Step "Sidecar tsc --noEmit" {
    Invoke-Tsc "sidecar/tsconfig.json" "sidecar/node_modules/typescript/bin/tsc"
}

# 4. sidecar 회귀 테스트들 — 권한 게이트 / 덮어쓰기 hook / cmdline 길이 한계 / 컨텍스트 미터 / Phase 13.
#    한 번이라도 실패하면 Phase 완료 / 커밋 / release 빌드 금지.
Invoke-Step "Sidecar tests (perm-gate + hook + cmdline-limit + context-meter + headless-mcp + codex)" {
    $testFiles = @(
        "sidecar/test-perm-gate.mjs",
        "sidecar/test-hook-overwriteGuard.mjs",
        "sidecar/test-hook-pitfallGuard.mjs",
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

# 4.5 Phase 16 - Settings 5tab split + NSIS shortcut hook install verification
Invoke-Step "Phase 16 (settings tabs + NSIS shortcut hook)" {
    # (a) all settings-section in Settings.tsx have data-tab
    $sectionsAll = (Select-String -Path "src/components/Settings.tsx" -Pattern "settings-section" -SimpleMatch).Count
    $sectionsTagged = (Select-String -Path "src/components/Settings.tsx" -Pattern "settings-section. data-tab=").Count
    if ($sectionsAll -ne $sectionsTagged) {
        throw "Settings sections without data-tab: $($sectionsAll - $sectionsTagged) / $sectionsAll"
    }
    Write-Host "  OK Settings.tsx: $sectionsAll sections, all data-tab tagged" -ForegroundColor DarkGray

    # (b) all 5 tab IDs present
    foreach ($tab in @("ai", "agent", "appearance", "system", "safety")) {
        $found = Select-String -Path "src/components/Settings.tsx" -Pattern "data-tab=.$tab." -Quiet
        if (-not $found) { throw "Settings.tsx missing tab: $tab" }
    }
    Write-Host "  OK All 5 tab IDs present (ai/agent/appearance/system/safety)" -ForegroundColor DarkGray

    # (c) NSIS hook file + tauri.conf.json registration
    if (-not (Test-Path "src-tauri/installer-hooks.nsh")) { throw "src-tauri/installer-hooks.nsh missing" }
    $nshHook = Select-String -Path "src-tauri/installer-hooks.nsh" -Pattern "NSIS_HOOK_PREINSTALL" -SimpleMatch -Quiet
    if (-not $nshHook) { throw "installer-hooks.nsh missing NSIS_HOOK_PREINSTALL macro" }
    $nshGuard = Select-String -Path "src-tauri/installer-hooks.nsh" -Pattern "NoShortcutMode" -SimpleMatch -Quiet
    if (-not $nshGuard) { throw "installer-hooks.nsh missing NoShortcutMode logic" }
    Write-Host "  OK installer-hooks.nsh has PREINSTALL + NoShortcutMode" -ForegroundColor DarkGray

    $tauriHook = Select-String -Path "src-tauri/tauri.conf.json" -Pattern "installerHooks" -SimpleMatch -Quiet
    if (-not $tauriHook) { throw "tauri.conf.json missing nsis.installerHooks registration" }
    Write-Host "  OK tauri.conf.json registers installer-hooks.nsh" -ForegroundColor DarkGray
}

# 4.6 Phase 17 - sidecar fixed cwd + resume_session_missing recovery + UpdateChecker re-check button
Invoke-Step "Phase 17 (fixed sidecar cwd + resume recovery + update re-check)" {
    # (a) lib.rs spawns sidecar with fixed cwd ~/.kda/cwd (transcript shard pin)
    $libFixed = Select-String -Path "src-tauri/src/lib.rs" -Pattern "transcript shard" -SimpleMatch -Quiet
    if (-not $libFixed) { throw "lib.rs missing fixed claude_cwd pin (Phase 17)" }
    $libCwdVar = Select-String -Path "src-tauri/src/lib.rs" -Pattern ".kda" -SimpleMatch -Quiet
    if (-not $libCwdVar) { throw "lib.rs missing .kda cwd anchor" }
    $libMigration = Select-String -Path "src-tauri/src/lib.rs" -Pattern "migrate_legacy_claude_sessions" -SimpleMatch -Quiet
    if (-not $libMigration) { throw "lib.rs missing migrate_legacy_claude_sessions function" }
    Write-Host "  OK lib.rs pins sidecar cwd + has migration helper" -ForegroundColor DarkGray

    # (b) sidecar detects "No conversation found" stderr -> emits resume_session_missing error
    $sidecarStderr = Select-String -Path "sidecar/src/index.ts" -Pattern "No conversation found with session ID" -SimpleMatch -Quiet
    if (-not $sidecarStderr) { throw "sidecar/src/index.ts missing 'No conversation found' stderr detector" }
    $sidecarErrCode = Select-String -Path "sidecar/src/index.ts" -Pattern "resume_session_missing" -SimpleMatch -Quiet
    if (-not $sidecarErrCode) { throw "sidecar/src/index.ts missing resume_session_missing error code emit" }
    Write-Host "  OK sidecar emits resume_session_missing on stale --resume" -ForegroundColor DarkGray

    # (c) App.tsx auto-recovers (clears agentId) on resume_session_missing
    $appRecovery = Select-String -Path "src/App.tsx" -Pattern "resume_session_missing" -SimpleMatch -Quiet
    if (-not $appRecovery) { throw "src/App.tsx missing resume_session_missing recovery branch" }
    Write-Host "  OK App.tsx auto-clears agentId on resume_session_missing" -ForegroundColor DarkGray

    # (d) Settings.tsx 'latest' state has re-check button (다시 확인)
    $reCheck = Select-String -Path "src/components/Settings.tsx" -Pattern "update-latest-section" -SimpleMatch -Quiet
    if (-not $reCheck) { throw "Settings.tsx missing update-latest-section (re-check button)" }
    Write-Host "  OK Settings.tsx 'latest' state has re-check button" -ForegroundColor DarkGray
}

# 4.7 Phase 18 - Python detect fallback + dependency auto-install + first-run wizard
Invoke-Step "Phase 18 (python detect + install-deps + first-run wizard)" {
    # (a) sidecar/src/index.ts has Python candidate fallback (resolvePython + py.exe priority)
    $resolvePython = Select-String -Path "sidecar/src/index.ts" -Pattern "function resolvePython" -SimpleMatch -Quiet
    if (-not $resolvePython) { throw "sidecar/src/index.ts missing resolvePython function (Phase 18-D)" }
    $pyExeFirst = Select-String -Path "sidecar/src/index.ts" -Pattern '"py\.exe"' -Quiet
    if (-not $pyExeFirst) { throw "sidecar/src/index.ts missing py.exe candidate (Phase 18-D)" }
    Write-Host "  OK sidecar resolvePython + py.exe fallback" -ForegroundColor DarkGray

    # (b) sidecar logs resolved python at boot
    $pyLog = Select-String -Path "sidecar/src/index.ts" -Pattern "resolved python:" -SimpleMatch -Quiet
    if (-not $pyLog) { throw "sidecar/src/index.ts missing 'resolved python:' init log" }
    Write-Host "  OK sidecar logs resolved python at init" -ForegroundColor DarkGray

    # (c) install-deps.ps1 exists with required functions
    if (-not (Test-Path "scripts/install-deps.ps1")) { throw "scripts/install-deps.ps1 missing" }
    foreach ($fn in @("Resolve-PythonExe", "Find-KPersonalMCP", "Install-WingetPackage", "Install-NpmGlobal")) {
        $found = Select-String -Path "scripts/install-deps.ps1" -Pattern "function $fn" -SimpleMatch -Quiet
        if (-not $found) { throw "install-deps.ps1 missing function: $fn" }
    }
    Write-Host "  OK install-deps.ps1 has all required functions" -ForegroundColor DarkGray

    # (d) install-deps.ps1 has UTF-8 BOM (PowerShell 5.1 reads .ps1 with Hangul correctly only with BOM)
    # NOTE: .NET API 는 PowerShell $PWD 가 아닌 프로세스 CWD 로 상대경로를 해석하므로 절대경로 사용
    # (일부 실행 환경에서 프로세스 CWD ≠ projectRoot → "Could not find file" 오진). $projectRoot 기준.
    $bytes = [System.IO.File]::ReadAllBytes((Join-Path $projectRoot "scripts/install-deps.ps1"))
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    if (-not $hasBom) { throw "scripts/install-deps.ps1 missing UTF-8 BOM (Hangul will mojibake on PS 5.1)" }
    Write-Host "  OK install-deps.ps1 has UTF-8 BOM" -ForegroundColor DarkGray

    # (e) lib.rs has 4 Phase 18 Tauri commands + invoke_handler registration
    foreach ($cmd in @("is_first_run", "mark_first_run_complete", "check_dependencies", "run_install_deps")) {
        $defFound = Select-String -Path "src-tauri/src/lib.rs" -Pattern "fn $cmd" -SimpleMatch -Quiet
        if (-not $defFound) { throw "lib.rs missing fn $cmd (Phase 18)" }
        $regFound = (Select-String -Path "src-tauri/src/lib.rs" -Pattern "^\s+$cmd," -CaseSensitive | Measure-Object).Count -gt 0
        if (-not $regFound) { throw "lib.rs invoke_handler missing $cmd registration" }
    }
    Write-Host "  OK lib.rs has 4 Phase 18 commands + invoke_handler entries" -ForegroundColor DarkGray

    # (f) Settings.tsx invokes the new commands + has firstrun marker class
    foreach ($call in @("check_dependencies", "run_install_deps", "is_first_run", "mark_first_run_complete")) {
        $callFound = Select-String -Path "src/components/Settings.tsx" -Pattern "invoke.+`"$call`"" -Quiet
        if (-not $callFound) { throw "Settings.tsx not invoking $call" }
    }
    $firstRunMarker = Select-String -Path "src/components/Settings.tsx" -Pattern 'data-firstrun=' -SimpleMatch -Quiet
    if (-not $firstRunMarker) { throw "Settings.tsx missing data-firstrun attribute (Phase 18 first-run marker)" }
    Write-Host "  OK Settings.tsx invokes Phase 18 commands + has first-run marker" -ForegroundColor DarkGray

    # (g) App.tsx auto-detects first-run -> opens Settings on system tab
    $appFirstRun = Select-String -Path "src/App.tsx" -Pattern 'invoke.+"is_first_run"' -Quiet
    if (-not $appFirstRun) { throw "src/App.tsx not detecting first-run via is_first_run" }
    # Phase 20 에서 v1 → v2 로 (sessionStorage 기반)
    $appAutoOpen = Select-String -Path "src/App.tsx" -Pattern "kda_firstrun_wizard_seen_v" -SimpleMatch -Quiet
    if (-not $appAutoOpen) { throw "src/App.tsx missing first-run wizard auto-open guard" }
    Write-Host "  OK App.tsx auto-opens Settings on first-run (with seen-guard)" -ForegroundColor DarkGray
}

# 4.8 Phase 19 - release path resolution: scripts/ + K-Personal MCP path 자동 분기
Invoke-Step "Phase 19 (release path resolution + bundle resources)" {
    # (a) lib.rs 의 resolve_script_path / resolve_kpersonal_mcp_server helper
    foreach ($fn in @("resolve_script_path", "resolve_kpersonal_mcp_server")) {
        $found = Select-String -Path "src-tauri/src/lib.rs" -Pattern "fn $fn" -SimpleMatch -Quiet
        if (-not $found) { throw "lib.rs missing fn $fn (Phase 19)" }
    }
    Write-Host "  OK lib.rs has Phase 19 path resolver helpers" -ForegroundColor DarkGray

    # (b) 4개 site 모두 helper 사용 (옛 'project_root().join("scripts")' 패턴 잔존 X)
    $oldPattern = (Select-String -Path "src-tauri/src/lib.rs" -Pattern 'project_root.*scripts' -CaseSensitive | Measure-Object).Count
    if ($oldPattern -gt 0) {
        throw "lib.rs still has $oldPattern occurrences of project_root()/scripts/ — should use resolve_script_path helper"
    }
    $callerCount = (Select-String -Path "src-tauri/src/lib.rs" -Pattern "resolve_script_path\(" | Measure-Object).Count
    if ($callerCount -lt 3) { throw "lib.rs has only $callerCount resolve_script_path() callers (expected >=3 for backup/rollback/install-deps)" }
    Write-Host "  OK lib.rs all script call sites use resolve_script_path ($callerCount callers)" -ForegroundColor DarkGray

    # (c) codex_register_mcp 가 resolve_kpersonal_mcp_server 사용
    # 옛 caller 패턴 (Phase 19 전): `project root has no parent` 라는 unique error string 사용했음.
    # 이 문구가 caller 영역에 남아있으면 옛 코드 잔존.
    $oldKPersonalCaller = Select-String -Path "src-tauri/src/lib.rs" -Pattern '"project root has no parent"' -Quiet
    if ($oldKPersonalCaller) {
        throw "lib.rs still has old caller pattern with 'project root has no parent' — should use resolve_kpersonal_mcp_server helper"
    }
    $kPersonalCaller = Select-String -Path "src-tauri/src/lib.rs" -Pattern "resolve_kpersonal_mcp_server\(\)" -Quiet
    if (-not $kPersonalCaller) { throw "lib.rs codex_register_mcp not using resolve_kpersonal_mcp_server" }
    Write-Host "  OK codex_register_mcp uses resolve_kpersonal_mcp_server" -ForegroundColor DarkGray

    # (d) tauri.conf.json bundle.resources 에 scripts/*.ps1 3종 모두 등록
    foreach ($script in @("install-deps.ps1", "backup.ps1", "rollback.ps1")) {
        $found = Select-String -Path "src-tauri/tauri.conf.json" -Pattern "scripts/$script" -SimpleMatch -Quiet
        if (-not $found) { throw "tauri.conf.json bundle.resources missing scripts/$script" }
    }
    Write-Host "  OK tauri.conf.json bundles 3 scripts (install-deps + backup + rollback)" -ForegroundColor DarkGray
}

# 4.9 Phase 20 - resolve_script_path 다중 후보 + codex valid 검증 + first-run 마법사 진단 강화
Invoke-Step "Phase 20 (multi-candidate path + codex valid + first-run diagnostics)" {
    # (a) resolve_script_path 다중 후보 — install_dir/scripts/, install_dir/resources/scripts/ 등
    $multiCandidate = Select-String -Path "src-tauri/src/lib.rs" -Pattern 'install_dir\.join\("resources"\)' -Quiet
    if (-not $multiCandidate) { throw "lib.rs resolve_script_path missing 'install_dir/resources/scripts' candidate (Phase 20)" }
    $upDir = Select-String -Path "src-tauri/src/lib.rs" -Pattern 'install_dir\.join\("_up_"\)' -Quiet
    if (-not $upDir) { throw "lib.rs resolve_script_path missing '_up_/scripts' candidate" }
    Write-Host "  OK resolve_script_path has multi-candidate paths (install_dir + resources + _up_)" -ForegroundColor DarkGray

    # (b) codex_login_status 가 read_codex_access_token 으로 valid 검증 (단순 auth.exists 만 X)
    $codexValid = Select-String -Path "src-tauri/src/lib.rs" -Pattern 'cli_available && auth\.exists\(\) && read_codex_access_token' -Quiet
    if (-not $codexValid) { throw "lib.rs codex_login_status missing valid token check (still uses simple auth.exists?)" }
    Write-Host "  OK codex_login_status validates with read_codex_access_token" -ForegroundColor DarkGray

    # (c) App.tsx first-run useEffect 가 sessionStorage 가드 (localStorage 영구 봉인 함정 회피)
    $sessionGuard = Select-String -Path "src/App.tsx" -Pattern 'kda_firstrun_wizard_seen_v2' -SimpleMatch -Quiet
    if (-not $sessionGuard) { throw "App.tsx missing v2 sessionStorage first-run guard (Phase 20)" }
    $diagnoseLog = Select-String -Path "src/App.tsx" -Pattern '[first-run]' -SimpleMatch -Quiet
    if (-not $diagnoseLog) { throw "App.tsx missing [first-run] diagnostic console logs" }
    Write-Host "  OK App.tsx uses sessionStorage v2 guard + diagnostic logs" -ForegroundColor DarkGray

    # (d) Settings.tsx Install button always shown on fatal error + reset wizard guard button
    $alwaysInstallBtn = Select-String -Path "src/components/Settings.tsx" -Pattern '!depsResult \|\| !depsResult\.fullyReady' -Quiet
    if (-not $alwaysInstallBtn) { throw "Settings.tsx install button hidden when depsResult=null (fatal error path)" }
    $resetGuardBtn = Select-String -Path "src/components/Settings.tsx" -Pattern 'kda_firstrun_wizard_seen_v2' -SimpleMatch -Quiet
    if (-not $resetGuardBtn) { throw "Settings.tsx missing kda_firstrun_wizard_seen_v2 reset button" }
    Write-Host "  OK Settings.tsx install btn always visible + wizard guard reset" -ForegroundColor DarkGray
}

# 4.10 Phase 22 - universal path: user-specific hardcoded paths must NOT exist in src/sidecar
Invoke-Step "Phase 22 (universal path: no user-specific hardcoded)" {
    # (a) sidecar K_PERSONAL_PATH 가 dynamic resolveKPersonalPath() 사용
    $sidecarDynamic = Select-String -Path "sidecar/src/index.ts" -Pattern "function resolveKPersonalPath" -SimpleMatch -Quiet
    if (-not $sidecarDynamic) { throw "sidecar missing resolveKPersonalPath() dynamic helper (Phase 22)" }

    # (b) sidecar 의 옛 hardcoded HARDCODED_MEMORY_KEY 정의 잔존 X
    $oldKey = Select-String -Path "sidecar/src/index.ts" -Pattern "const HARDCODED_MEMORY_KEY" -SimpleMatch -Quiet
    if ($oldKey) { throw "sidecar still defines HARDCODED_MEMORY_KEY (use dynamic fallback instead)" }
    Write-Host "  OK sidecar K_PERSONAL_PATH dynamic + no HARDCODED_MEMORY_KEY" -ForegroundColor DarkGray

    # (c) src/ 와 sidecar/src/ 코드 (test/script 제외) 에 'C:/Users/user/' 또는 'Users\\user\\' 잔존 검색
    $sourceFiles = @(
        "sidecar/src/index.ts",
        "src/App.tsx",
        "src/prompts.ts",
        "src/components/Settings.tsx",
        "src-tauri/src/lib.rs"
    )
    $hardcodedFound = @()
    foreach ($f in $sourceFiles) {
        if (-not (Test-Path $f)) { continue }
        $matches = Select-String -Path $f -Pattern "C:/Users/user/" -CaseSensitive
        if ($matches) {
            foreach ($m in $matches) {
                $hardcodedFound += "$f`:$($m.LineNumber)"
            }
        }
    }
    if ($hardcodedFound.Count -gt 0) {
        throw "user-specific hardcoded path 'C:/Users/user/' 잔존 ($($hardcodedFound.Count)): $($hardcodedFound -join ', ')"
    }
    Write-Host "  OK src/sidecar 코드에 user-specific hardcoded 'C:/Users/user/' 없음" -ForegroundColor DarkGray
}

# 4.11 Phase 25 - portable data dir: data_root() helper + commands + UI 일관성
Invoke-Step "Phase 25 (portable data dir + migration)" {
    # (a) lib.rs 에 data_root + data_pointer_path + migrate_legacy_db_if_needed 정의
    $libContent = Get-Content "src-tauri/src/lib.rs" -Raw
    foreach ($fn in @("fn data_root", "fn data_pointer_path", "fn install_dir", "fn migrate_legacy_db_if_needed", "fn copy_dir_recursive")) {
        if ($libContent -notmatch [regex]::Escape($fn)) { throw "lib.rs missing helper: $fn (Phase 25)" }
    }
    Write-Host "  OK lib.rs has Phase 25 data_root helpers" -ForegroundColor DarkGray

    # (b) 두 새 Tauri command (get_data_dir_info, change_data_dir) 가 정의 + invoke_handler 등록
    foreach ($cmd in @("get_data_dir_info", "change_data_dir")) {
        $defOk = $libContent -match "fn $cmd"
        $regOk = $libContent -match "(?s)invoke_handler.*$cmd"
        if (-not $defOk) { throw "lib.rs: command $cmd 정의 없음 (Phase 25)" }
        if (-not $regOk) { throw "lib.rs: command $cmd invoke_handler 등록 없음 (Phase 25)" }
    }
    Write-Host "  OK lib.rs Phase 25 commands defined + registered" -ForegroundColor DarkGray

    # (c) first_run_sentinel + claude_cwd 가 data_root() 사용 (~/.kda hardcode 잔존 X)
    if ($libContent -notmatch "data_root\(\)\.join\(`"first-run-completed\.flag`"\)") {
        throw "lib.rs first_run_sentinel_path: data_root() 미사용 (Phase 25)"
    }
    if ($libContent -notmatch "data_root\(\)\.join\(`"cwd`"\)") {
        throw "lib.rs claude_cwd: data_root() 미사용 (Phase 25)"
    }
    Write-Host "  OK lib.rs sentinel + claude_cwd use data_root()" -ForegroundColor DarkGray

    # (d) backup.ps1 가 -DataRoot 인자 받음
    $backupContent = Get-Content "scripts/backup.ps1" -Raw
    if ($backupContent -notmatch '\[string\]\$DataRoot') { throw "backup.ps1 missing -DataRoot param (Phase 25)" }
    Write-Host "  OK backup.ps1 accepts -DataRoot" -ForegroundColor DarkGray

    # (e) lib.rs backup_now 가 -DataRoot 인자 넘김
    if ($libContent -notmatch '"-DataRoot"') { throw "lib.rs backup_now: -DataRoot 인자 미전달 (Phase 25)" }
    Write-Host "  OK lib.rs backup_now passes -DataRoot to PS" -ForegroundColor DarkGray

    # (f) db.ts 가 invoke('get_data_dir_info') 사용해 절대경로 DB path
    $dbContent = Get-Content "src/db.ts" -Raw
    if ($dbContent -notmatch 'get_data_dir_info') { throw "db.ts: get_data_dir_info 미호출 (Phase 25)" }
    if ($dbContent -notmatch 'sqlite:\$\{') { throw "db.ts: sqlite:`${...} dynamic path 미사용 (Phase 25)" }
    Write-Host "  OK db.ts uses dynamic absolute SQLite path" -ForegroundColor DarkGray

    # (g) Settings.tsx 가 데이터 폴더 섹션 + handleChangeDataDir 박힘
    $settingsContent = Get-Content "src/components/Settings.tsx" -Raw
    if ($settingsContent -notmatch 'handleChangeDataDir') { throw "Settings.tsx missing handleChangeDataDir (Phase 25)" }
    if ($settingsContent -notmatch 'refreshDataDirInfo') { throw "Settings.tsx missing refreshDataDirInfo (Phase 25)" }
    if ($settingsContent -notmatch 'get_data_dir_info') { throw "Settings.tsx missing get_data_dir_info invoke (Phase 25)" }
    Write-Host "  OK Settings.tsx has data dir section + handler" -ForegroundColor DarkGray

    # (h) installer-hooks.nsh 가 data-pointer.txt 박는 매크로 포함
    $nshContent = Get-Content "src-tauri/installer-hooks.nsh" -Raw
    if ($nshContent -notmatch 'data-pointer\.txt') { throw "installer-hooks.nsh missing data-pointer.txt setup (Phase 25)" }
    if ($nshContent -notmatch 'NSIS_HOOK_POSTINSTALL') { throw "installer-hooks.nsh missing POSTINSTALL hook (Phase 25)" }
    Write-Host "  OK installer-hooks.nsh has POSTINSTALL data-pointer setup" -ForegroundColor DarkGray

    # (i) tauri.conf.json 의 NSIS installMode = currentUser (사용자 path 선택 가능)
    $confContent = Get-Content "src-tauri/tauri.conf.json" -Raw
    if ($confContent -notmatch '"installMode":\s*"currentUser"') {
        throw "tauri.conf.json: NSIS installMode currentUser 미설정 (Phase 25)"
    }
    Write-Host "  OK tauri.conf.json NSIS installMode = currentUser" -ForegroundColor DarkGray
}

# 4.12 Phase 26 - bundled-mcp: K-Personal-MCP 코드를 KDA setup.exe 에 자동 번들
Invoke-Step "Phase 26 (bundled-mcp auto deploy)" {
    $libContent = Get-Content "src-tauri/src/lib.rs" -Raw

    # (a) deploy_bundled_mcp_if_needed 정의 + setup() 에서 호출
    if ($libContent -notmatch "fn deploy_bundled_mcp_if_needed") {
        throw "lib.rs: deploy_bundled_mcp_if_needed 정의 없음 (Phase 26)"
    }
    if ($libContent -notmatch "deploy_bundled_mcp_if_needed\(\)") {
        throw "lib.rs: setup() 에 deploy_bundled_mcp_if_needed() 호출 없음 (Phase 26)"
    }
    Write-Host "  OK lib.rs has deploy_bundled_mcp_if_needed + setup() call" -ForegroundColor DarkGray

    # (b) resolve_kpersonal_mcp_server 가 bundled-mcp 후보 추가
    if ($libContent -notmatch 'install\.join\("bundled-mcp"\)\.join\("server\.py"\)') {
        throw "lib.rs: resolve_kpersonal_mcp_server 에 install_dir/bundled-mcp/server.py 후보 없음 (Phase 26)"
    }
    Write-Host "  OK resolve_kpersonal_mcp_server has bundled-mcp candidates" -ForegroundColor DarkGray

    # (c) tauri.conf.json bundle.resources 에 bundled-mcp 12 entry 박힘
    $confContent = Get-Content "src-tauri/tauri.conf.json" -Raw
    $bundledRefs = ([regex]::Matches($confContent, '"\.\./bundled-mcp/')).Count
    if ($bundledRefs -lt 7) {
        throw "tauri.conf.json: bundled-mcp resources entries 부족 (받은 $bundledRefs, 7+ 필요) (Phase 26)"
    }
    Write-Host "  OK tauri.conf.json bundle.resources has $bundledRefs bundled-mcp entries" -ForegroundColor DarkGray

    # (d) release.yml 에 git clone step 박힘
    $releaseYml = Get-Content ".github/workflows/release.yml" -Raw
    if ($releaseYml -notmatch 'git clone --depth=1 https://github\.com/lee30934-byte/K-Personal-MCP\.git bundled-mcp') {
        throw ".github/workflows/release.yml: K-Personal-MCP git clone step 없음 (Phase 26)"
    }
    if ($releaseYml -notmatch "Fetch K-Personal-MCP source") {
        throw ".github/workflows/release.yml: 'Fetch K-Personal-MCP source' step name 없음 (Phase 26)"
    }
    Write-Host "  OK release.yml has K-Personal-MCP fetch step" -ForegroundColor DarkGray

    # (e) .gitignore 에 bundled-mcp/ 박힘 (실수로 commit 안 되도록)
    $gitignoreContent = Get-Content ".gitignore" -Raw
    if ($gitignoreContent -notmatch "(?m)^bundled-mcp/") {
        throw ".gitignore: bundled-mcp/ entry 없음 — repo 에 실수로 박힐 위험 (Phase 26)"
    }
    Write-Host "  OK .gitignore has bundled-mcp/" -ForegroundColor DarkGray
}

# 4.13 Phase 72 - Settings tabs ↔ App.css selectors 정합성
#
# Phase 71 함정 재발 방지: Phase 67 (MCP 도구 탭 추가) 에서 Settings.tsx 에 jsx + state +
# 카탈로그 다 박았지만 App.css 의 `.settings-body[data-active-tab="X"] section[data-tab="X"]`
# selector 에 새 id ("tools") 를 빠뜨려서 v0.6.13~14 의 환경설정 MCP 도구 탭 본문이 영구
# display:none. silent throw 처럼 보였지만 단순 CSS 누락. Phase 71 (v0.6.15) 에서 fix.
#
# 새 탭 추가 시 셋 (tabs 배열 + jsx section + CSS selector) 한 세트로 따라가야 함을 강제.
Invoke-Step "Phase 72 (Settings tabs ↔ App.css selectors 정합성)" {
    $settingsPath = "src/components/Settings.tsx"
    $cssPath = "src/App.css"
    if (-not (Test-Path $settingsPath)) { throw "$settingsPath not found" }
    if (-not (Test-Path $cssPath)) { throw "$cssPath not found" }

    # (a) Settings.tsx 의 tabs 배열에서 `{ id: "X", icon: "...", label: "..." }` 패턴의 X 추출
    $settingsContent = Get-Content $settingsPath -Raw
    $tabIds = [regex]::Matches($settingsContent, '\{\s*id:\s*"([a-z-]+)",\s*icon:\s*"') |
        ForEach-Object { $_.Groups[1].Value } |
        Sort-Object -Unique
    if ($tabIds.Count -lt 5) {
        throw "Settings.tsx tabs 배열 추출 실패 (받은 $($tabIds.Count) 개, 5+ 기대). regex pattern 점검 필요"
    }
    Write-Host "  OK Settings.tsx tabs 추출: $($tabIds -join ', ')" -ForegroundColor DarkGray

    # (b) App.css 의 `.settings-body[data-active-tab="X"]` selector key 추출
    $cssContent = Get-Content $cssPath -Raw
    $cssActiveTabs = [regex]::Matches($cssContent, '\.settings-body\[data-active-tab="([a-z-]+)"\]') |
        ForEach-Object { $_.Groups[1].Value } |
        Sort-Object -Unique
    Write-Host "  OK App.css data-active-tab selectors: $($cssActiveTabs -join ', ')" -ForegroundColor DarkGray

    # (c) diff — Settings 에 있는데 css 에 없는 id 가 함정
    $missing = $tabIds | Where-Object { $cssActiveTabs -notcontains $_ }
    if ($missing) {
        Write-Host "Settings.tsx tabs 중 App.css selector 매칭 없음:" -ForegroundColor Red
        $missing | ForEach-Object { Write-Host "  - id=`"$_`" → 필요: .settings-body[data-active-tab=`"$_`"] section[data-tab=`"$_`"]" -ForegroundColor Red }
        throw "Phase 71 함정 재발 — App.css 에 새 탭 selector 추가 필요"
    }

    # (d) section data-tab 도 추출해서 모든 tabs id 가 대응되는 section 갖고 있는지
    $sectionTabs = [regex]::Matches($settingsContent, 'data-tab="([a-z-]+)"') |
        ForEach-Object { $_.Groups[1].Value } |
        Sort-Object -Unique
    $orphanTabs = $tabIds | Where-Object { $sectionTabs -notcontains $_ }
    if ($orphanTabs) {
        Write-Host "Settings.tsx tabs 중 jsx section 매칭 없음 (탭은 있는데 본문 없음):" -ForegroundColor Red
        $orphanTabs | ForEach-Object { Write-Host "  - id=`"$_`" → 필요: <section data-tab=`"$_`">" -ForegroundColor Red }
        throw "Phase 72 함정 — Settings.tsx 에 새 탭 section 추가 필요"
    }
}

# 4.14 Phase 104 - Sidecar heartbeat watchdog
Invoke-Step "Phase 104 (sidecar heartbeat watchdog)" {
    $libPath = "src-tauri/src/lib.rs"
    $sidecarPath = "sidecar/src/index.ts"

    foreach ($needle in @(
        "LAST_SIDECAR_EVENT_SECS",
        "LAST_SIDECAR_SPAWN_SECS",
        "SIDECAR_STARTUP_GRACE_SECS",
        "SIDECAR_HEARTBEAT_TIMEOUT_SECS",
        "sidecar_startup_timeout",
        "sidecar_watchdog_timeout",
        "heartbeat timeout"
    )) {
        if (-not (Select-String -Path $libPath -Pattern $needle -SimpleMatch -Quiet)) {
            throw "lib.rs missing watchdog marker: $needle"
        }
    }
    Write-Host "  OK Rust sidecar heartbeat watchdog markers present" -ForegroundColor DarkGray

    foreach ($needle in @(
        "SIDECAR_HEARTBEAT_INTERVAL_MS",
        "isBrokenStdoutPipe",
        "exitForBrokenStdoutPipe",
        'type: "heartbeat"',
        "activeTurns.size",
        "heartbeatTimer.unref"
    )) {
        if (-not (Select-String -Path $sidecarPath -Pattern $needle -SimpleMatch -Quiet)) {
            throw "sidecar/src/index.ts missing heartbeat marker: $needle"
        }
    }
    Write-Host "  OK Node sidecar emits heartbeat events" -ForegroundColor DarkGray
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
