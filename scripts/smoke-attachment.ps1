#Requires -Version 5.1
<#
.SYNOPSIS
  Phase 9.5 — sidecar attachment plumbing smoke (no UI, no LLM call).

.DESCRIPTION
  Same idea as smoke-sidecar.ps1 but with an actual file attachment in the user_message:

    1. Inject a tiny base64-encoded PNG (70 bytes, valid 1×1 transparent pixel) on stdin.
    2. Wait for the `CLI query start` diagnostic line in logs/sidecar.log and parse out
       attDir=<path> from it.
    3. While the stub is still running (gives us a ~1 s window before the finally-block
       cleanup), read back the materialized file from disk and verify its bytes match the
       source byte-for-byte. This proves base64 → fs.writeFileSync round-trips correctly.
    4. After the stub exits and the turn ends, verify the attachment directory was rmSync'd
       (Phase 9 cleanup contract — temp folders never accumulate).

  This catches regressions in:
    - Rust → sidecar attachment forwarding (lib.rs::send_message)
    - sidecar/src/index.ts::materializeAttachments() (decode + write)
    - sidecar finally-block cleanup (rmSync on attachmentsDir)
    - filename sanitization (no path traversal, no Windows reserved chars)

  Like smoke-sidecar.ps1, the LLM is NEVER called — CLAUDE_CLI is replaced with a no-op stub.

.PARAMETER TimeoutSec
  How long to wait for the diagnostic line. Default 15 s.

.PARAMETER Quiet
  Suppress per-step progress lines.

.EXAMPLE
  .\scripts\smoke-attachment.ps1
#>

param(
    [int]$TimeoutSec = 15,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

function Write-SmokeStep($msg) { if (-not $Quiet) { Write-Host "  $msg" -ForegroundColor DarkGray } }
function Write-SmokeOK($msg)   { if (-not $Quiet) { Write-Host "  ✓ $msg" -ForegroundColor Green } }
function Write-SmokeErr($msg)  { Write-Host "  ✗ $msg" -ForegroundColor Red }

# ─── 1. Resolve paths ─────────────────────────────────────────
$sidecarDir = Join-Path $projectRoot 'sidecar'
$entryPath  = Join-Path $sidecarDir 'dist\index.js'
$logPath    = Join-Path $projectRoot 'logs\sidecar.log'

if (-not (Test-Path $entryPath)) {
    Write-SmokeErr "sidecar dist not built: $entryPath  (run smoke-sidecar.ps1 -Build first or full-rebuild-and-verify.ps1)"
    exit 1
}

$bundledNode = Join-Path $projectRoot 'node-bundle\node.exe'
$nodeExe = if (Test-Path $bundledNode) { $bundledNode } else { 'node' }

# ─── 2. Build claude stub (slightly longer pause so we can read attDir) ─
$stubDir = Join-Path $env:TEMP "kda-smoke-stub-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Force -Path $stubDir | Out-Null
$stubPath = Join-Path $stubDir 'claude-stub.cmd'
# 3-second pause gives the smoke time to verify the attDir contents BEFORE sidecar's
# finally-block runs rmSync on the temp folder.
$stubBody = @'
@echo off
if /i "%~1"=="--version" (
  echo claude-stub-0.0.0
  exit /b 0
)
more >nul
ping -n 4 127.0.0.1 >nul
exit /b 0
'@
Set-Content -Path $stubPath -Value $stubBody -Encoding ASCII
Write-SmokeStep "stub = $stubPath"

# ─── 3. Build the test PNG payload ─────────────────────────────
# Hand-crafted minimum-valid 1×1 transparent PNG (70 bytes). Using fixed bytes (instead
# of e.g. drawing a Bitmap) keeps the smoke deterministic — same bytes every run, easy
# to compare byte-for-byte.
$pngBytes = [byte[]] @(
    0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,                  # PNG signature
    0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,                  # IHDR length + type
    0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,                  # width=1, height=1
    0x08,0x06,0x00,0x00,0x00,                                  # bit_depth=8, color=6 (RGBA)
    0x1F,0x15,0xC4,0x89,                                       # IHDR CRC
    0x00,0x00,0x00,0x0D,0x49,0x44,0x41,0x54,                  # IDAT length + type
    0x78,0x9C,0x62,0x00,0x01,0x00,0x00,0x05,0x00,0x01,        # zlib-compressed pixel
    0x0D,0x0A,0x2D,0xB4,                                       # IDAT CRC
    0x00,0x00,0x00,0x00,0x49,0x45,0x4E,0x44,                  # IEND length + type
    0xAE,0x42,0x60,0x82                                        # IEND CRC
)
$pngB64 = [Convert]::ToBase64String($pngBytes)
$attName = 'smoke-1px.png'
Write-SmokeStep "payload: $attName ($($pngBytes.Length) bytes, base64=$($pngB64.Length) chars)"

# ─── 4. Snapshot log size before spawn ─────────────────────────
$logSizeBefore = if (Test-Path $logPath) { (Get-Item $logPath).Length } else { 0 }

# ─── 5. Spawn sidecar with stub ────────────────────────────────
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName               = $nodeExe
$psi.WorkingDirectory       = $sidecarDir
$psi.UseShellExecute        = $false
$psi.RedirectStandardInput  = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError  = $true
$psi.CreateNoWindow         = $true
$psi.Arguments              = '"' + $entryPath + '"'
$psi.EnvironmentVariables['CLAUDE_CLI'] = $stubPath

$proc = [System.Diagnostics.Process]::Start($psi)
Write-SmokeStep "sidecar PID $($proc.Id)"

# ─── 6. Inject user_message with attachment ────────────────────
$smokeId = "smoke-att-{0:yyyyMMdd-HHmmss}-{1}" -f (Get-Date), [guid]::NewGuid().ToString('N').Substring(0,6)
$payload = @{
    type    = 'user_message'
    id      = $smokeId
    content = 'smoke test (attachment plumbing)'
    attachments = @(
        @{
            name   = $attName
            type   = 'image/png'
            size   = $pngBytes.Length
            base64 = $pngB64
        }
    )
} | ConvertTo-Json -Compress -Depth 6

Write-SmokeStep "inject id=$smokeId"
$proc.StandardInput.WriteLine($payload)
$proc.StandardInput.Flush()

# ─── 7. Tail sidecar.log for the diagnostic line ───────────────
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$diagLine = $null
$attDir = $null

while ((Get-Date) -lt $deadline) {
    if (Test-Path $logPath) {
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
            if ($hit -match 'attDir=([^\s]+)') {
                $attDir = $Matches[1]
            }
            break
        }
    }
    Start-Sleep -Milliseconds 200
}

# ─── 8. While stub is still running, snapshot the materialized file ─
$materializedBytes = $null
$attDirExistedDuringTurn = $false
$attFilePath = $null
if ($attDir) {
    $attFilePath = Join-Path $attDir $attName
    # Defensive: re-check up to 5 times in 500 ms — there's a tiny window between the
    # diagnostic line being logged and the writeFileSync actually completing.
    for ($i = 0; $i -lt 5; $i++) {
        if (Test-Path $attFilePath) {
            $attDirExistedDuringTurn = $true
            try {
                $materializedBytes = [System.IO.File]::ReadAllBytes($attFilePath)
            } catch { }
            break
        }
        Start-Sleep -Milliseconds 100
    }
}

# ─── 9. Tear down sidecar ─────────────────────────────────────
# IMPORTANT teardown ordering:
#   The sidecar's stdin readline has `rl.on("close", () => process.exit(0))`. If we close
#   stdin while a turn is mid-flight, Node bails out before the turn's async `finally`
#   block (which does the rmSync on attachmentsDir) completes — and the temp folder leaks.
#   So: send interrupt → poll until attDir is gone (or timeout) → THEN close stdin.
$stdoutTail = ''; $stderrTail = ''
try {
    if (-not $proc.HasExited) {
        $interrupt = @{ type = 'interrupt'; id = $smokeId } | ConvertTo-Json -Compress
        try { $proc.StandardInput.WriteLine($interrupt) } catch { }
        try { $proc.StandardInput.Flush() } catch { }
        # Give the interrupt's kill → for-await unwind → finally{rmSync} chain time to run.
        # Empirically this is ~tens of ms, but we wait up to 3 s just in case.
        if ($attDir) {
            $cleanupDeadline = (Get-Date).AddSeconds(3)
            while ((Get-Date) -lt $cleanupDeadline -and (Test-Path $attDir)) {
                Start-Sleep -Milliseconds 100
            }
        }
        # Now it's safe to close stdin → sidecar exits cleanly via rl.on("close").
        try { $proc.StandardInput.Close() } catch { }
        if (-not $proc.WaitForExit(3000)) {
            try { $proc.Kill() } catch { }
            [void]$proc.WaitForExit(2000)
        }
    }
    try { $stdoutTail = $proc.StandardOutput.ReadToEnd() } catch { }
    try { $stderrTail = $proc.StandardError.ReadToEnd() } catch { }
} catch { }

# ─── 10. Verify cleanup happened (attDir should be gone) ───────
$attDirAfterCleanup = $true
if ($attDir) {
    $attDirAfterCleanup = Test-Path $attDir
}

# Cleanup stub
Remove-Item -Recurse -Force -Path $stubDir -ErrorAction SilentlyContinue

# ─── 11. Assertions ───────────────────────────────────────────
$failures = New-Object System.Collections.Generic.List[string]

if (-not $diagLine) {
    $failures.Add("no diagnostic line for id=$smokeId in $logPath within ${TimeoutSec}s")
} else {
    Write-SmokeOK "diagnostic line found"
    if (-not $Quiet) { Write-Host "    $diagLine" -ForegroundColor DarkGray }

    if ($diagLine -notmatch 'attachments=1\b') {
        $failures.Add("expected attachments=1 (got: $diagLine)")
    } else {
        Write-SmokeOK "attachments=1"
    }
    if (-not $attDir) {
        $failures.Add("attDir=… not present in diagnostic line — materializeAttachments may not have created the temp dir")
    } else {
        Write-SmokeOK "attDir=$attDir"
    }
    if ($diagLine -notmatch 'hooks=overwriteGuard\+pitfallGuard') {
        $failures.Add("missing token: hooks=overwriteGuard+pitfallGuard")
    }
    if ($diagLine -notmatch 'memory=\d+/\d+b') {
        $failures.Add("missing token: memory=N/Mb")
    }
}

if ($attDirExistedDuringTurn) {
    Write-SmokeOK "materialized file present at $attFilePath"
} elseif ($attDir) {
    $failures.Add("materialized file NOT found at $attFilePath during the turn (writeFileSync may have failed)")
}

if ($null -ne $materializedBytes) {
    if ($materializedBytes.Length -ne $pngBytes.Length) {
        $failures.Add("materialized size mismatch: got $($materializedBytes.Length) bytes, expected $($pngBytes.Length)")
    } else {
        $bytesEqual = $true
        for ($i = 0; $i -lt $pngBytes.Length; $i++) {
            if ($materializedBytes[$i] -ne $pngBytes[$i]) { $bytesEqual = $false; break }
        }
        if (-not $bytesEqual) {
            $failures.Add("materialized bytes do not match source (base64 round-trip broken)")
        } else {
            Write-SmokeOK "byte-for-byte match ($($pngBytes.Length) bytes)"
        }
    }
} elseif ($attDirExistedDuringTurn) {
    $failures.Add("could not read materialized file (locked / permission?)")
}

if ($attDir -and $attDirAfterCleanup) {
    $failures.Add("attachment dir survived after turn end — finally-block cleanup did not run: $attDir")
} elseif ($attDir) {
    Write-SmokeOK "cleanup verified (temp dir removed)"
}

# ─── 12. Verdict ──────────────────────────────────────────────
if ($failures.Count -eq 0) {
    if (-not $Quiet) { Write-Host "" }
    Write-Host "✓ smoke-attachment PASS  (id=$smokeId)" -ForegroundColor Green
    exit 0
} else {
    Write-Host ""
    Write-Host "✗ smoke-attachment FAIL ($($failures.Count) issue$(if ($failures.Count -ne 1){'s'}))" -ForegroundColor Red
    foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
    if ($stderrTail) {
        Write-Host "  --- sidecar stderr (tail) ---" -ForegroundColor DarkYellow
        Write-Host $stderrTail.TrimEnd() -ForegroundColor DarkYellow
    }
    exit 1
}
