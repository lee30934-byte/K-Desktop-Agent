#Requires -Version 5.1
<#
.SYNOPSIS
  Phase 11 G1 — REST tool-call regression smoke (mock HTTP + optional live MCP).

.DESCRIPTION
  Thin wrapper around `sidecar/scripts/smoke-rest-tools.mjs`:
    Layer 1 (mock HTTP, CI-safe, no network, no API keys):
      - In-process Node http server mimics OpenAI / Gemini SSE responses.
      - runOpenAIChatRound / runGeminiRound are exercised through them; assertions
        catch regressions in delta accumulation, fragmented JSON arg reassembly,
        parallel tool calls, message builders, namespacing helpers.

    Layer 2 (live MCP — auto-skips when K-Personal MCP isn't installed):
      - Spawns the real Python MCP server, lists tools, dispatches a read-only
        tool (cc_screen_size), and asserts the result text comes back.
      - Also exercises the negative paths (unknown tool, disallowed tool).

  CI sets nothing special — Layer 2 just skips on hosted runners (no Python /
  K-Personal-MCP repo there). Locally on K's box both layers run.

.PARAMETER Build
  Force a sidecar rebuild (npm run build) before running. Default off — assumes
  dist/ is fresh; full-rebuild-and-verify.ps1 already builds.

.PARAMETER Quiet
  Pass through to the harness (currently the harness ignores this — verbose by
  design — but the param is here for consistency with the other smoke scripts).

.EXAMPLE
  .\scripts\smoke-rest-tools.ps1
  .\scripts\smoke-rest-tools.ps1 -Build
#>

param(
    [switch]$Build,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$sidecarDir = Join-Path $projectRoot 'sidecar'
$harness    = Join-Path $sidecarDir 'scripts\smoke-rest-tools.mjs'
$distRest   = Join-Path $sidecarDir 'dist\restTools.js'

if ($Build -or -not (Test-Path $distRest)) {
    if (-not $Quiet) { Write-Host "  building sidecar (tsc)" -ForegroundColor DarkGray }
    Push-Location $sidecarDir
    try {
        npm run build 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "sidecar build failed (npm run build exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path $harness)) {
    Write-Host "✗ smoke-rest-tools FAIL — harness not found: $harness" -ForegroundColor Red
    exit 2
}

# Pick node — prefer bundled (matches release runtime), fall back to PATH.
$bundledNode = Join-Path $projectRoot 'node-bundle\node.exe'
$nodeExe = if (Test-Path $bundledNode) { $bundledNode } else { 'node' }
if (-not $Quiet) { Write-Host "  node = $nodeExe" -ForegroundColor DarkGray }

# Run harness, surface its stderr (where it prints assertions) directly.
& $nodeExe $harness
$rc = $LASTEXITCODE

if ($rc -eq 0) {
    Write-Host "✓ smoke-rest-tools PASS" -ForegroundColor Green
    exit 0
} elseif ($rc -eq 2) {
    Write-Host "✗ smoke-rest-tools SETUP-FAIL (harness couldn't start)" -ForegroundColor Red
    exit 2
} else {
    Write-Host "✗ smoke-rest-tools FAIL (harness exit $rc)" -ForegroundColor Red
    exit 1
}
