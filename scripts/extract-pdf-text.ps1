<#
.SYNOPSIS
  Extract text from one or more PDF files using the KDA sidecar PDF extractor.

.EXAMPLE
  .\scripts\extract-pdf-text.ps1 -PdfPath .\sample.pdf

.EXAMPLE
  .\scripts\extract-pdf-text.ps1 -PdfPath .\a.pdf,.\b.pdf -OutDir .\extracted

.EXAMPLE
  .\scripts\extract-pdf-text.ps1 -PdfPath .\sample.pdf -Json -Limit 120000
#>

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string[]]$PdfPath,

    [string]$OutDir,

    [int]$Limit = 60000,

    [switch]$Json,

    [switch]$Build
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sidecarDir = Join-Path $projectRoot "sidecar"
$entryPath = Join-Path $sidecarDir "dist\pdf-extract-cli.js"

if ($Build -or -not (Test-Path $entryPath)) {
    Push-Location $projectRoot
    try {
        npm run sidecar:build
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path $entryPath)) {
    throw "PDF extractor CLI was not built: $entryPath"
}

$bundledNode = Join-Path $projectRoot "node-bundle\node.exe"
$nodeExe = if (Test-Path $bundledNode) { $bundledNode } else { "node" }

$argsList = @($entryPath, "--limit", [string]$Limit)
if ($Json) { $argsList += "--json" }
if ($OutDir) { $argsList += @("--out", $OutDir) }
$argsList += $PdfPath

$env:PDF2JSON_DISABLE_LOGS = "1"
& $nodeExe @argsList
exit $LASTEXITCODE
