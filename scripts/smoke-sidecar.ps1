#Requires -Version 5.1
<#
.SYNOPSIS
  Phase 9.5 — sidecar headless smoke (no UI, no LLM call, no Claude quota).

.DESCRIPTION
  Spawns the sidecar (`sidecar/dist/index.js`) directly, injects one user_message JSON on stdin,
  and asserts that the diagnostic line in `logs/sidecar.log` contains the Phase 9 markers:

    - hooks=overwriteGuard+pitfallGuard   (Phase 9 step 4 — pitfall guard wired)
    - memory=N/Mb                         (Phase 9 step 1 — memory loader wired)
    - attachments=0                       (attachment plumbing reachable)

  Replaces the Claude CLI with a no-op stub (CLAUDE_CLI env var) so:
    - probe at sidecar startup succeeds (stub returns 0 on --version)
    - the LLM is NEVER called → 0 USD, 0 tokens, < 5 s end-to-end

  Use this on every push (CI) and after every rebuild to detect regressions in:
    - JSON-stdin parsing
    - Phase 9 step 1 (memory loader)
    - Phase 9 step 4 (pitfall guard registration)
    - attachment plumbing reachability

.PARAMETER Build
  Force a sidecar rebuild (npm run build in sidecar/) before running. Default off — assumes
  dist/index.js is fresh; full-rebuild-and-verify.ps1 already runs the build.

.PARAMETER TimeoutSec
  How long to wait for the diagnostic line in sidecar.log. Default 15 s.

.PARAMETER Quiet
  Suppress per-step progress lines (only print final pass/fail).

.EXAMPLE
  .\scripts\smoke-sidecar.ps1
  .\scripts\smoke-sidecar.ps1 -Build
  .\scripts\smoke-sidecar.ps1 -TimeoutSec 30 -Quiet
#>

param(
    [switch]$Build,
    [int]$TimeoutSec = 15,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

function Write-SmokeStep($msg) {
    if (-not $Quiet) {
        Write-Host "  $msg" -ForegroundColor DarkGray
    }
}

function Write-SmokeOK($msg) {
    if (-not $Quiet) {
        Write-Host "  ✓ $msg" -ForegroundColor Green
    }
}

function Write-SmokeErr($msg) {
    Write-Host "  ✗ $msg" -ForegroundColor Red
}

# ─── 1. Resolve paths ─────────────────────────────────────────
$sidecarDir   = Join-Path $projectRoot 'sidecar'
$entryPath    = Join-Path $sidecarDir 'dist\index.js'
$logPath      = Join-Path $projectRoot 'logs\sidecar.log'

if ($Build -or -not (Test-Path $entryPath)) {
    Write-SmokeStep "build sidecar (tsc)"
    Push-Location $sidecarDir
    try {
        npm run build 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "sidecar build failed (npm run build exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path $entryPath)) {
    Write-SmokeErr "sidecar entry not found: $entryPath"
    exit 1
}

# Pick a node binary — prefer the bundled one (matches what release uses), fall back to PATH.
$bundledNode = Join-Path $projectRoot 'node-bundle\node.exe'
$nodeExe = if (Test-Path $bundledNode) { $bundledNode } else { 'node' }
Write-SmokeStep "node = $nodeExe"

# ─── 2. Build the Claude CLI stub (no-op, no LLM) ──────────────
$stubDir = Join-Path $env:TEMP "kda-smoke-stub-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Force -Path $stubDir | Out-Null
$stubPath = Join-Path $stubDir 'claude-stub.cmd'

# `more > nul` drains the prompt that sidecar writes on stdin; without it the
# stub would exit before sidecar's `proc.stdin.end()` resolves and we'd race.
# `ping -n 2 …` gives the smoke ~1 s to inspect any side-effects (e.g. the
# attachment temp dir before sidecar's finally-block cleanup runs).
$stubBody = @'
@echo off
if /i "%~1"=="--version" (
  echo claude-stub-0.0.0
  exit /b 0
)
more >nul
ping -n 2 127.0.0.1 >nul
exit /b 0
'@
Set-Content -Path $stubPath -Value $stubBody -Encoding ASCII
Write-SmokeStep "stub = $stubPath"

# ─── 3. Snapshot log size before spawn (avoid matching old lines) ─
$logSizeBefore = if (Test-Path $logPath) { (Get-Item $logPath).Length } else { 0 }
Write-SmokeStep "log baseline: $logSizeBefore bytes"

# ─── 4. Spawn sidecar with isolated env ───────────────────────
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName               = $nodeExe
$psi.WorkingDirectory       = $sidecarDir
$psi.UseShellExecute        = $false
$psi.RedirectStandardInput  = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError  = $true
$psi.CreateNoWindow         = $true
# NOTE: ArgumentList is .NET 5+; PowerShell 5.1 / .NET Framework only has Arguments (string).
# Quote the path manually — it never contains a literal `"` so this is safe.
$psi.Arguments              = '"' + $entryPath + '"'

# Replace Claude CLI with our stub — sidecar's resolveClaudeCli() honors $env:CLAUDE_CLI first.
$psi.EnvironmentVariables['CLAUDE_CLI'] = $stubPath

# Inherit current env (PATH, APPDATA, …) — ProcessStartInfo does that by default when we
# only override CLAUDE_CLI.

$proc = [System.Diagnostics.Process]::Start($psi)
Write-SmokeStep "sidecar PID $($proc.Id)"

# We read stdout/stderr synchronously at the very end (after WaitForExit). Sidecar emits
# a handful of small JSON events (< 1 KB) before we tear down, well under the 4 KB
# Windows pipe buffer, so blocking-on-fill is not a concern for this short smoke.

# ─── 5. Inject one user_message ───────────────────────────────
$smokeId = "smoke-{0:yyyyMMdd-HHmmss}-{1}" -f (Get-Date), [guid]::NewGuid().ToString('N').Substring(0,6)
$payload = @{
    type    = 'user_message'
    id      = $smokeId
    content = 'smoke test (no LLM call — sidecar diagnostic check)'
} | ConvertTo-Json -Compress

Write-SmokeStep "inject id=$smokeId"
$proc.StandardInput.WriteLine($payload)
$proc.StandardInput.Flush()

# ─── 6. Tail sidecar.log for our diagnostic line ──────────────
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$diagLine = $null

while ((Get-Date) -lt $deadline) {
    if (Test-Path $logPath) {
        # Read only what's new since baseline to avoid scanning huge histories.
        $fs = $null; $sr = $null
        try {
            $fs = [System.IO.File]::Open($logPath, 'Open', 'Read', 'ReadWrite')
            $null = $fs.Seek($logSizeBefore, 'Begin')
            $sr = New-Object System.IO.StreamReader($fs)
            $tail = $sr.ReadToEnd()
        } finally {
            if ($sr) { $sr.Dispose() }
            if ($fs) { $fs.Dispose() }
        }
        $hit = $tail -split "`n" | Where-Object { $_ -match "CLI query start id=$([regex]::Escape($smokeId))" } | Select-Object -First 1
        if ($hit) {
            $diagLine = $hit
            break
        }
    }
    Start-Sleep -Milliseconds 250
}

# ─── 7. Tear down sidecar ────────────────────────────────────
$stdoutTail = ''
$stderrTail = ''
try {
    if (-not $proc.HasExited) {
        # interrupt the active turn (kills the stub) then close stdin → readline EOF → exit(0)
        $interrupt = @{ type = 'interrupt'; id = $smokeId } | ConvertTo-Json -Compress
        try { $proc.StandardInput.WriteLine($interrupt) } catch { }
        try { $proc.StandardInput.Close() } catch { }
        if (-not $proc.WaitForExit(3000)) {
            try { $proc.Kill() } catch { }
            [void]$proc.WaitForExit(2000)
        }
    }
    # Drain any captured streams once the child has exited (or been killed).
    try { $stdoutTail = $proc.StandardOutput.ReadToEnd() } catch { }
    try { $stderrTail = $proc.StandardError.ReadToEnd() } catch { }
} catch { }

# Cleanup stub
Remove-Item -Recurse -Force -Path $stubDir -ErrorAction SilentlyContinue

# ─── 8. Assertions ───────────────────────────────────────────
$failures = New-Object System.Collections.Generic.List[string]

if (-not $diagLine) {
    $failures.Add("no diagnostic line for id=$smokeId in $logPath within ${TimeoutSec}s")
} else {
    Write-SmokeOK "diagnostic line found"
    if (-not $Quiet) { Write-Host "    $diagLine" -ForegroundColor DarkGray }

    # Required tokens for Phase 9 step 1 + step 4.
    if ($diagLine -notmatch 'hooks=overwriteGuard\+pitfallGuard') {
        $failures.Add("missing token: hooks=overwriteGuard+pitfallGuard")
    } else {
        Write-SmokeOK "hooks=overwriteGuard+pitfallGuard"
    }
    if ($diagLine -notmatch 'memory=(\d+)/(\d+)b') {
        $failures.Add("missing token: memory=N/Mb")
    } else {
        $memCount = [int]$Matches[1]; $memBytes = [int]$Matches[2]
        if ($memCount -lt 1) {
            $failures.Add("memory=$memCount/${memBytes}b — expected >= 1 file (Phase 9 memory loader)")
        } else {
            Write-SmokeOK "memory=$memCount/${memBytes}b"
        }
    }
    if ($diagLine -notmatch 'attachments=0') {
        $failures.Add("expected attachments=0 for plain text smoke (got: $diagLine)")
    } else {
        Write-SmokeOK "attachments=0 (no attachments in this smoke)"
    }
}

# ─── 9. Verdict ──────────────────────────────────────────────
if ($failures.Count -eq 0) {
    if (-not $Quiet) { Write-Host "" }
    Write-Host "✓ smoke-sidecar PASS  (id=$smokeId)" -ForegroundColor Green
    exit 0
} else {
    Write-Host ""
    Write-Host "✗ smoke-sidecar FAIL ($($failures.Count) issue$(if ($failures.Count -ne 1){'s'}))" -ForegroundColor Red
    foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
    if ($stderrTail) {
        Write-Host "  --- sidecar stderr (tail) ---" -ForegroundColor DarkYellow
        Write-Host $stderrTail.TrimEnd() -ForegroundColor DarkYellow
    }
    if ($stdoutTail -and -not $diagLine) {
        Write-Host "  --- sidecar stdout (tail) ---" -ForegroundColor DarkYellow
        Write-Host $stdoutTail.TrimEnd() -ForegroundColor DarkYellow
    }
    exit 1
}
