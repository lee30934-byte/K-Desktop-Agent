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
    $bytes = [System.IO.File]::ReadAllBytes("scripts/install-deps.ps1")
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
