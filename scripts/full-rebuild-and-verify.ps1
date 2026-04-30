#Requires -Version 5.1
<#
.SYNOPSIS
  Phase 9.5 — one-shot: rebuild release binary + run all headless smokes.

.DESCRIPTION
  K-Desktop-Agent's "release confidence" pipeline. In one command:

    1. rebuild-release.ps1     — recompile + sync sidecar to install dir
    2. smoke-sidecar.ps1       — verify Phase 9 step 1 (memory) + step 4 (pitfall guard)
    3. smoke-attachment.ps1    — verify attachment plumbing (decode, write, cleanup)

  Designed so K can say "빌드해줘" and the assistant runs this in the background, then
  reports a single PASS / FAIL with all numbers.

  Exit codes:
    0 — everything passed
    1 — build failed (sidecar didn't even compile)
    2 — at least one smoke failed (build OK but regression detected)

.PARAMETER SkipBuild
  Skip rebuild-release.ps1 — useful when iterating only on the smokes themselves.

.PARAMETER SkipPreflight
  Forwarded to rebuild-release.ps1 — skip cargo check / tsc preflight.

.PARAMETER Launch
  Forwarded to rebuild-release.ps1 — launch the binary after build (note: if the install
  version is already running, Tauri's single-instance plugin focuses it instead).

.EXAMPLE
  .\scripts\full-rebuild-and-verify.ps1
  .\scripts\full-rebuild-and-verify.ps1 -SkipBuild        # only run smokes
  .\scripts\full-rebuild-and-verify.ps1 -Launch
#>

param(
    [switch]$SkipBuild,
    [switch]$SkipPreflight,
    [switch]$Launch
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

function Write-Phase($title) {
    Write-Host ""
    Write-Host "──────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host " $title" -ForegroundColor Cyan
    Write-Host "──────────────────────────────────────────────" -ForegroundColor DarkGray
}

$summary = New-Object System.Collections.Generic.List[object]
function Add-Summary($name, $passed, $elapsed) {
    $summary.Add([pscustomobject]@{
        Name    = $name
        Passed  = $passed
        Elapsed = $elapsed
    })
}

# ─── 1. Rebuild ───────────────────────────────────────────────
if (-not $SkipBuild) {
    Write-Phase "Step 1/3 — Rebuild release binary"
    $start = Get-Date
    $rebuildArgs = @()
    if ($SkipPreflight) { $rebuildArgs += '-SkipPreflight' }
    if ($Launch)        { $rebuildArgs += '-Launch' }
    & "$PSScriptRoot\rebuild-release.ps1" @rebuildArgs
    $code = $LASTEXITCODE
    $elapsed = [int]((Get-Date) - $start).TotalSeconds
    if ($code -ne 0) {
        Write-Host ""
        Write-Host "✗ rebuild-release failed (exit $code) — aborting smokes" -ForegroundColor Red
        Add-Summary 'rebuild-release' $false $elapsed
        Write-Host ""
        Write-Host "Summary:" -ForegroundColor Cyan
        $summary | Format-Table -AutoSize | Out-String | Write-Host
        exit 1
    }
    Add-Summary 'rebuild-release' $true $elapsed
} else {
    Write-Phase "Step 1/3 — Rebuild release binary  [SKIPPED -SkipBuild]"
    # Build the sidecar at minimum so smokes have a fresh dist/index.js — without this
    # SkipBuild can mask a TS regression.
    $start = Get-Date
    Push-Location "$projectRoot\sidecar"
    try {
        npm run build 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) {
            Write-Host "✗ sidecar build failed" -ForegroundColor Red
            Add-Summary 'sidecar build' $false ([int]((Get-Date) - $start).TotalSeconds)
            exit 1
        }
    } finally {
        Pop-Location
    }
    Add-Summary 'sidecar build (only)' $true ([int]((Get-Date) - $start).TotalSeconds)
}

# ─── 2. Smoke 1: sidecar diagnostic ───────────────────────────
Write-Phase "Step 2/3 — smoke-sidecar (Phase 9 step 1 + step 4)"
$start = Get-Date
& "$PSScriptRoot\smoke-sidecar.ps1"
$smoke1 = $LASTEXITCODE -eq 0
Add-Summary 'smoke-sidecar' $smoke1 ([int]((Get-Date) - $start).TotalSeconds)

# ─── 3. Smoke 2: attachment plumbing ──────────────────────────
Write-Phase "Step 3/3 — smoke-attachment (attachment plumbing)"
$start = Get-Date
& "$PSScriptRoot\smoke-attachment.ps1"
$smoke2 = $LASTEXITCODE -eq 0
Add-Summary 'smoke-attachment' $smoke2 ([int]((Get-Date) - $start).TotalSeconds)

# ─── 4. Verdict ───────────────────────────────────────────────
# (Pure ASCII status markers in this script — PowerShell 5.1 parses .ps1 files using the
#  system ANSI codepage; on a Korean Windows host UTF-8 ✓/✗ in single-quoted literals get
#  misread as multi-byte CP949 sequences and break the parser. Double-quoted strings in
#  the smoke scripts tolerate it; single-quoted assignments here did not.)
Write-Phase "Summary"
foreach ($row in $summary) {
    $mark  = if ($row.Passed) { '[OK]  ' } else { '[FAIL]' }
    $color = if ($row.Passed) { 'Green' }   else { 'Red'    }
    $line  = "{0,-22} {1} {2,3}s" -f $row.Name, $mark, $row.Elapsed
    Write-Host $line -ForegroundColor $color
}

$allPassed = ($summary | Where-Object { -not $_.Passed }).Count -eq 0

Write-Host ""
if ($allPassed) {
    Write-Host "[OK] all green - Phase 9 markers verified, attachment round-trips, cleanup runs" -ForegroundColor Green
    exit 0
} else {
    Write-Host "[FAIL] regression detected - see failures above" -ForegroundColor Red
    exit 2
}
