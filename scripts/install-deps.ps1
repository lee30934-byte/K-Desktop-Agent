<#
.SYNOPSIS
  K-Desktop-Agent 의 외부 의존성을 자동 설치 — 다른 PC 에서 setup.exe 만 깔고도
  곧장 동작 가능한 상태로 만든다 (OAuth 로그인은 K 가 직접 1회).

.DESCRIPTION
  Phase 18 (2026-05-07): K 가 다른 PC 에서도 setup.exe 한 번만 클릭하면 완성되도록
  의존성 자동 셋업 스크립트.

  설치 항목 (이미 있으면 skip — idempotent):
    1. Node.js LTS (winget: OpenJS.NodeJS.LTS) — npm 글로벌 명령용
    2. Git for Windows (winget: Git.Git) — Claude CLI 가 git-bash 의존
    3. Python 3.11 (winget: Python.Python.3.11) — K-Personal MCP 가 Python
    4. Claude Code CLI (npm i -g @anthropic-ai/claude-code)
    5. Codex CLI (npm i -g @openai/codex)
    6. K-Personal-MCP 폴더 (옵션 — K 폴더에 이미 있거나 환경변수로 지정 시)

  설치 안 하는 것:
    - Claude / Codex 의 OAuth 로그인 (K 계정 정보 필요 — 보안상 자동화 불가)
    - K-Desktop-Agent 본체 (이미 setup.exe 로 설치됨)

.PARAMETER DryRun
  실제 설치 안 하고 detect 만 (현재 상태 진단). first-run 마법사가 항상 먼저 호출.

.PARAMETER AsJson
  결과를 JSON 으로 stdout 출력 (Tauri command 의 run_install_deps 가 호출 시 사용).
  사람이 읽을 진행 메시지는 stderr 로 흘림.

.PARAMETER SkipPython
  Python 설치 skip. K 가 이미 다른 Python 환경 (anaconda, pyenv 등) 사용 중일 때.

.PARAMETER SkipMCP
  K-Personal-MCP 설치 skip. K 가 직접 옮길 거면.

.EXAMPLE
  # 진단만 (안전)
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-deps.ps1 -DryRun -AsJson

.EXAMPLE
  # 실제 설치
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-deps.ps1

.NOTES
  - winget 은 Windows 10 1809+ / Windows 11 기본 포함 (App Installer).
  - npm 글로벌 설치는 첫 실행 시 %APPDATA%\npm 자동 생성.
  - elevation: winget 이 필요 시 자동으로 UAC 띄움 — 이 스크립트는 elevation 직접 안 함.
  - 결과 JSON 스키마는 docs (CLAUDE.md Phase 18) 에 박혀있음.
#>
param(
  [switch]$DryRun,
  [switch]$AsJson,
  [switch]$SkipPython,
  [switch]$SkipMCP
)

$ErrorActionPreference = 'Continue'  # 한 단계 실패해도 다음 단계 시도

# stderr 가 사람용, stdout 이 JSON 결과 (AsJson 일 때)
function Out-Status($msg, $color = 'Gray') {
  if ($AsJson) {
    [Console]::Error.WriteLine($msg)
  } else {
    Write-Host $msg -ForegroundColor $color
  }
}

function Out-Step($msg) { Out-Status "▸ $msg" 'Yellow' }
function Out-OK($msg)   { Out-Status "  ✅ $msg" 'Green' }
function Out-Skip($msg) { Out-Status "  ⤳ $msg" 'DarkGray' }
function Out-Err($msg)  { Out-Status "  ❌ $msg" 'Red' }

# ─── 0. winget 가용성 검사 ──────────────────────────────
function Test-Winget {
  try {
    $null = & winget --version 2>$null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

# ─── 1. 명령 존재 검사 (PATH 의존) ──────────────────────
function Test-Cmd($cmd) {
  $found = Get-Command $cmd -ErrorAction SilentlyContinue
  return [bool]$found
}

# ─── 2. winget 패키지 설치 ──────────────────────────────
function Install-WingetPackage($id, $displayName) {
  Out-Step "$displayName 설치 (winget id=$id)"
  if ($DryRun) {
    Out-Skip "DryRun: winget install --id $id"
    return @{ status = 'dryrun'; id = $id }
  }
  try {
    & winget install --id $id --silent --accept-package-agreements --accept-source-agreements 2>&1 | ForEach-Object {
      Out-Status "    $_" 'DarkGray'
    }
    if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq -1978335189) {
      # -1978335189 = APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE = 이미 최신
      Out-OK "$displayName 설치 완료 (또는 이미 최신)"
      return @{ status = 'installed'; id = $id; exitCode = $LASTEXITCODE }
    } else {
      Out-Err "$displayName 설치 실패 (exit $LASTEXITCODE)"
      return @{ status = 'failed'; id = $id; exitCode = $LASTEXITCODE }
    }
  } catch {
    Out-Err "$displayName 설치 예외: $($_.Exception.Message)"
    return @{ status = 'error'; id = $id; error = $_.Exception.Message }
  }
}

# ─── 3. npm 글로벌 패키지 설치 ──────────────────────────
function Install-NpmGlobal($pkg, $displayName) {
  Out-Step "$displayName 설치 (npm i -g $pkg)"
  if ($DryRun) {
    Out-Skip "DryRun: npm i -g $pkg"
    return @{ status = 'dryrun'; pkg = $pkg }
  }
  try {
    # npm 의 stderr 도 progress 정보가 많아서 같이 흘림
    & npm install -g $pkg 2>&1 | ForEach-Object {
      Out-Status "    $_" 'DarkGray'
    }
    if ($LASTEXITCODE -eq 0) {
      Out-OK "$displayName 설치 완료"
      return @{ status = 'installed'; pkg = $pkg }
    } else {
      Out-Err "$displayName 설치 실패 (exit $LASTEXITCODE)"
      return @{ status = 'failed'; pkg = $pkg; exitCode = $LASTEXITCODE }
    }
  } catch {
    Out-Err "$displayName 설치 예외: $($_.Exception.Message)"
    return @{ status = 'error'; pkg = $pkg; error = $_.Exception.Message }
  }
}

# ─── 4. Python 후보 검출 (sidecar 의 resolvePython 동일 로직) ──
function Resolve-PythonExe {
  $candidates = @('py.exe', 'py', 'python3.exe', 'python3', 'python.exe', 'python')
  foreach ($c in $candidates) {
    try {
      $null = & $c --version 2>$null
      if ($LASTEXITCODE -eq 0) { return $c }
    } catch { }
  }
  return $null
}

# ─── 5. K-Personal-MCP 폴더 detect ──────────────────────
function Find-KPersonalMCP {
  # PowerShell unrolling 함정 회피: pipeline + Where-Object 결과를 [0] 인덱싱하면
  # string 이 char array 로 풀어지는 경우가 있어 명시적 foreach 사용.
  $candidates = @(
    "$env:USERPROFILE\Documents\K-Personal-MCP",
    "$env:USERPROFILE\K-Personal-MCP"
  )
  if ($env:K_PERSONAL_MCP_DIR) { $candidates += $env:K_PERSONAL_MCP_DIR }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path (Join-Path $c 'server.py'))) {
      return $c
    }
  }
  return $null
}

# ─── 6. K-Personal-MCP Python 의존성 설치 ────────────────
function Install-KPersonalMCPDeps($mcpDir, $pythonExe) {
  $reqFile = Join-Path $mcpDir 'requirements.txt'
  if (-not (Test-Path $reqFile)) {
    Out-Skip "requirements.txt 없음: $reqFile"
    return @{ status = 'skipped'; reason = 'no requirements.txt' }
  }
  Out-Step "K-Personal-MCP Python 의존성 설치 ($pythonExe -m pip install -r requirements.txt)"
  if ($DryRun) {
    Out-Skip "DryRun: $pythonExe -m pip install -r $reqFile"
    return @{ status = 'dryrun' }
  }
  try {
    & $pythonExe -m pip install -r $reqFile 2>&1 | ForEach-Object {
      Out-Status "    $_" 'DarkGray'
    }
    if ($LASTEXITCODE -eq 0) {
      Out-OK "Python 의존성 설치 완료"
      return @{ status = 'installed' }
    } else {
      Out-Err "Python 의존성 설치 실패 (exit $LASTEXITCODE)"
      return @{ status = 'failed'; exitCode = $LASTEXITCODE }
    }
  } catch {
    Out-Err "Python 의존성 설치 예외: $($_.Exception.Message)"
    return @{ status = 'error'; error = $_.Exception.Message }
  }
}

# ════════════════════════════════════════════════════════
#                    메인 흐름
# ════════════════════════════════════════════════════════

Out-Status "════════════════════════════════════════" 'Cyan'
Out-Status "  K-Desktop-Agent 의존성 셋업 (Phase 18)" 'Cyan'
Out-Status "  Mode: $(if ($DryRun) { 'DryRun (진단만)' } else { '실제 설치' })" 'Cyan'
Out-Status "════════════════════════════════════════" 'Cyan'

$result = @{
  startedAt = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')
  dryRun = [bool]$DryRun
  steps = @{}
  before = @{}
  after = @{}
}

# ─── Pre-check ──────────────────────────────────────────
$result.before = @{
  winget       = (Test-Winget)
  node         = (Test-Cmd 'node')
  npm          = (Test-Cmd 'npm')
  git          = (Test-Cmd 'git')
  python       = (Resolve-PythonExe)
  claudeCli    = (Test-Cmd 'claude')
  codexCli     = (Test-Cmd 'codex')
  kPersonalMcp = (Find-KPersonalMCP)
}

Out-Status "현재 환경:" 'Cyan'
Out-Status "  winget       : $(if ($result.before.winget) {'있음'} else {'없음'})"
Out-Status "  node         : $(if ($result.before.node) {'있음'} else {'없음'})"
Out-Status "  git          : $(if ($result.before.git) {'있음'} else {'없음'})"
Out-Status "  python       : $(if ($result.before.python) {$result.before.python} else {'없음'})"
Out-Status "  claude CLI   : $(if ($result.before.claudeCli) {'있음'} else {'없음'})"
Out-Status "  codex CLI    : $(if ($result.before.codexCli) {'있음'} else {'없음'})"
Out-Status "  K-Personal MCP: $(if ($result.before.kPersonalMcp) {$result.before.kPersonalMcp} else {'없음'})"

if (-not $result.before.winget) {
  Out-Err "winget 이 없어요 — Windows 10 1809+ 또는 11 필요. App Installer 를 Microsoft Store 에서 설치하세요."
  Out-Err "winget 없으면 이 스크립트는 Node.js / Git / Python 자동 설치 못 합니다."
  $result.fatal = 'no winget'
  if ($AsJson) {
    $result | ConvertTo-Json -Depth 6 -Compress
  }
  exit 2
}

# ─── 1. Node.js ─────────────────────────────────────────
if ($result.before.node -and $result.before.npm) {
  Out-Skip "Node.js 이미 있음 ($(node --version 2>$null))"
  $result.steps.node = @{ status = 'skipped'; reason = 'already installed' }
} else {
  $result.steps.node = (Install-WingetPackage 'OpenJS.NodeJS.LTS' 'Node.js LTS')
}

# ─── 2. Git for Windows ─────────────────────────────────
if ($result.before.git) {
  Out-Skip "Git 이미 있음 ($(git --version 2>$null))"
  $result.steps.git = @{ status = 'skipped'; reason = 'already installed' }
} else {
  $result.steps.git = (Install-WingetPackage 'Git.Git' 'Git for Windows')
}

# ─── 3. Python ──────────────────────────────────────────
if ($SkipPython) {
  Out-Skip "Python 설치 skip (--SkipPython)"
  $result.steps.python = @{ status = 'skipped'; reason = 'user requested' }
} elseif ($result.before.python) {
  Out-Skip "Python 이미 있음 ($($result.before.python))"
  $result.steps.python = @{ status = 'skipped'; reason = 'already installed'; resolved = $result.before.python }
} else {
  $result.steps.python = (Install-WingetPackage 'Python.Python.3.11' 'Python 3.11')
}

# winget 으로 막 설치한 경우 PATH 갱신이 현재 세션엔 반영 안 됨 → User PATH 명시 갱신
if (-not $DryRun) {
  $userPath = [System.Environment]::GetEnvironmentVariable('PATH', 'User')
  $machinePath = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine')
  $env:PATH = "$machinePath;$userPath"
}

# ─── 4. Claude CLI ──────────────────────────────────────
if ($result.before.claudeCli) {
  Out-Skip "Claude CLI 이미 있음"
  $result.steps.claudeCli = @{ status = 'skipped'; reason = 'already installed' }
} elseif (Test-Cmd 'npm') {
  $result.steps.claudeCli = (Install-NpmGlobal '@anthropic-ai/claude-code' 'Claude Code CLI')
} else {
  Out-Err "npm 이 없어 Claude CLI 설치 불가. Node.js 설치 후 PowerShell 새로 띄우고 재실행."
  $result.steps.claudeCli = @{ status = 'failed'; reason = 'no npm in PATH' }
}

# ─── 5. Codex CLI ───────────────────────────────────────
if ($result.before.codexCli) {
  Out-Skip "Codex CLI 이미 있음"
  $result.steps.codexCli = @{ status = 'skipped'; reason = 'already installed' }
} elseif (Test-Cmd 'npm') {
  $result.steps.codexCli = (Install-NpmGlobal '@openai/codex' 'Codex CLI')
} else {
  Out-Err "npm 이 없어 Codex CLI 설치 불가. Node.js 설치 후 PowerShell 새로 띄우고 재실행."
  $result.steps.codexCli = @{ status = 'failed'; reason = 'no npm in PATH' }
}

# ─── 6. K-Personal-MCP (옵션) ───────────────────────────
if ($SkipMCP) {
  Out-Skip "K-Personal-MCP 설치 skip (--SkipMCP)"
  $result.steps.kPersonalMcp = @{ status = 'skipped'; reason = 'user requested' }
} else {
  $mcpDir = (Find-KPersonalMCP)
  if ($mcpDir) {
    Out-Skip "K-Personal-MCP 이미 있음: $mcpDir"
    # Python 의존성만 추가 설치 시도
    $pythonExe = (Resolve-PythonExe)
    if ($pythonExe) {
      $result.steps.kPersonalMcpDeps = (Install-KPersonalMCPDeps $mcpDir $pythonExe)
    } else {
      Out-Skip "Python 못 찾아 K-Personal-MCP 의존성 설치 skip"
      $result.steps.kPersonalMcpDeps = @{ status = 'skipped'; reason = 'no python' }
    }
    $result.steps.kPersonalMcp = @{ status = 'skipped'; reason = 'already present'; path = $mcpDir }
  } else {
    Out-Skip "K-Personal-MCP 폴더 없음 — K 가 직접 클론해주세요:"
    Out-Skip "  git clone <K 의 K-Personal-MCP repo URL> $env:USERPROFILE\Documents\K-Personal-MCP"
    Out-Skip "  또는 환경변수 K_PERSONAL_MCP_DIR 로 지정"
    $result.steps.kPersonalMcp = @{ status = 'skipped'; reason = 'folder missing — manual clone needed' }
  }
}

# ─── Post-check (PATH 갱신 후 다시 검증) ────────────────
$result.after = @{
  node         = (Test-Cmd 'node')
  npm          = (Test-Cmd 'npm')
  git          = (Test-Cmd 'git')
  python       = (Resolve-PythonExe)
  claudeCli    = (Test-Cmd 'claude')
  codexCli     = (Test-Cmd 'codex')
  kPersonalMcp = (Find-KPersonalMCP)
}

# ─── 마무리 + 다음 단계 안내 ────────────────────────────
$result.completedAt = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')

# 핵심 의존성 ready 검사 — Claude OR Codex 둘 중 하나만 있어도 KDA 동작 가능
$claudeReady = [bool]$result.after.claudeCli
$codexReady  = [bool]$result.after.codexCli
$pythonReady = [bool]$result.after.python
$result.ready = ($claudeReady -or $codexReady)
$result.fullyReady = $claudeReady -and $codexReady -and $pythonReady

$nextSteps = @()
if ($claudeReady)         { $nextSteps += 'claude login   # 브라우저 OAuth' }
if ($codexReady)          { $nextSteps += 'codex login    # 브라우저 OAuth' }
if (-not $result.after.kPersonalMcp) {
  $nextSteps += "K-Personal-MCP 폴더 수동 배치 ($env:USERPROFILE\Documents\K-Personal-MCP)"
}
$result.nextSteps = $nextSteps

Out-Status "" 'Gray'
Out-Status "════════════════════════════════════════" 'Cyan'
Out-Status "  완료 — 다음 단계 (K 가 직접):" 'Cyan'
foreach ($step in $nextSteps) { Out-Status "  • $step" 'Yellow' }
if ($nextSteps.Count -eq 0) {
  Out-Status "  (모든 의존성 ready — OAuth 로그인은 KDA Settings 에서)" 'Green'
}
Out-Status "════════════════════════════════════════" 'Cyan'

if ($AsJson) {
  $result | ConvertTo-Json -Depth 8 -Compress
}

# 종료 코드: 0 = ready, 1 = partial (둘 다 fail), 2 = fatal (winget 없음)
if ($result.ready) {
  exit 0
} else {
  exit 1
}
