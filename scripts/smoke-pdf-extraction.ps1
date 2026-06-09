#Requires -Version 5.1
<#
.SYNOPSIS
  Headless smoke for sidecar PDF attachment text extraction.

.DESCRIPTION
  Creates two small PDFs with different text layouts, sends both as attachments to the
  sidecar, and uses a Claude CLI stub to capture the final stdin prompt. No LLM call is
  made. The smoke verifies:

    1. PDF attachments are materialized to a temp directory.
    2. sidecar extracts text from both PDFs before launching the CLI.
    3. extracted PDF text is appended to the prompt.
    4. attachment temp directory is cleaned up after the turn.

.EXAMPLE
  .\scripts\smoke-pdf-extraction.ps1
#>

param(
    [int]$TimeoutSec = 20,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
[Environment]::CurrentDirectory = $projectRoot

function Write-SmokeStep($msg) { if (-not $Quiet) { Write-Host "  $msg" -ForegroundColor DarkGray } }
function Write-SmokeOK($msg)   { if (-not $Quiet) { Write-Host "  OK $msg" -ForegroundColor Green } }
function Write-SmokeErr($msg)  { Write-Host "  FAIL $msg" -ForegroundColor Red }

function Escape-PdfString([string]$s) {
    return $s.Replace('\', '\\').Replace('(', '\(').Replace(')', '\)')
}

function New-PdfBytes([string[]]$ops) {
    $enc = [System.Text.Encoding]::ASCII
    $content = ($ops -join "`n") + "`n"
    $contentLen = $enc.GetByteCount($content)
    $objects = @(
        "1 0 obj`n<< /Type /Catalog /Pages 2 0 R >>`nendobj`n",
        "2 0 obj`n<< /Type /Pages /Kids [3 0 R] /Count 1 >>`nendobj`n",
        "3 0 obj`n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`nendobj`n",
        "4 0 obj`n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`nendobj`n",
        "5 0 obj`n<< /Length $contentLen >>`nstream`n$content`nendstream`nendobj`n"
    )

    $pdf = "%PDF-1.4`n"
    $offsets = New-Object System.Collections.Generic.List[int]
    $offsets.Add(0)
    foreach ($obj in $objects) {
        $offsets.Add($enc.GetByteCount($pdf))
        $pdf += $obj
    }

    $xrefOffset = $enc.GetByteCount($pdf)
    $xref = "xref`n0 $($objects.Count + 1)`n0000000000 65535 f `n"
    for ($i = 1; $i -lt $offsets.Count; $i++) {
        $xref += ("{0:D10} 00000 n `n" -f $offsets[$i])
    }
    $trailer = "trailer`n<< /Size $($objects.Count + 1) /Root 1 0 R >>`nstartxref`n$xrefOffset`n%%EOF`n"
    return $enc.GetBytes($pdf + $xref + $trailer)
}

function New-TextOp([int]$x, [int]$y, [string]$text) {
    $safe = Escape-PdfString $text
    return "BT /F1 12 Tf $x $y Td ($safe) Tj ET"
}

$sidecarDir = Join-Path $projectRoot 'sidecar'
$entryPath  = Join-Path $sidecarDir 'dist\index.js'
$logPath    = Join-Path $projectRoot 'logs\sidecar.log'

if (-not (Test-Path $entryPath)) {
    Write-SmokeErr "sidecar dist not built: $entryPath"
    exit 1
}

$bundledNode = Join-Path $projectRoot 'node-bundle\node.exe'
$nodeExe = if (Test-Path $bundledNode) { $bundledNode } else { 'node' }

$tmpRoot = Join-Path $env:TEMP "kda-pdf-smoke-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$stubDir = Join-Path $tmpRoot 'stub'
$pdfDir = Join-Path $tmpRoot 'pdf'
New-Item -ItemType Directory -Force -Path $stubDir, $pdfDir | Out-Null

$capturePath = Join-Path $tmpRoot 'captured-prompt.txt'
$stubPath = Join-Path $stubDir 'claude-stub.cmd'
$stubBody = @'
@echo off
if /i "%~1"=="--version" (
  echo claude-stub-0.0.0
  exit /b 0
)
more > "%KDA_SMOKE_CAPTURE%"
ping -n 3 127.0.0.1 >nul
exit /b 0
'@
Set-Content -Path $stubPath -Value $stubBody -Encoding ASCII

$pdfAPath = Join-Path $pdfDir 'two-column-layout.pdf'
$pdfBPath = Join-Path $pdfDir 'invoice-layout.pdf'

$pdfAOps = @(
    (New-TextOp 72 720 'LEFTCOLUMNALPHA first line'),
    (New-TextOp 72 700 'LEFTCOLUMNBETA second line'),
    (New-TextOp 320 720 'RIGHTCOLUMNGAMMA first line'),
    (New-TextOp 320 700 'RIGHTCOLUMNOMEGA second line')
)
$pdfBOps = @(
    (New-TextOp 72 740 'INVOICELAYOUTHEADER ACME TEST'),
    (New-TextOp 72 700 'ITEMALPHA quantity two'),
    (New-TextOp 360 700 'PRICEALPHA 4900'),
    (New-TextOp 72 676 'ITEMBETA quantity one'),
    (New-TextOp 360 676 'PRICEBETA 5000'),
    (New-TextOp 360 640 'INVOICETOTAL9900')
)

[System.IO.File]::WriteAllBytes($pdfAPath, (New-PdfBytes $pdfAOps))
[System.IO.File]::WriteAllBytes($pdfBPath, (New-PdfBytes $pdfBOps))
Write-SmokeStep "pdf A = $pdfAPath"
Write-SmokeStep "pdf B = $pdfBPath"

$logSizeBefore = if (Test-Path $logPath) { (Get-Item $logPath).Length } else { 0 }

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
$psi.EnvironmentVariables['KDA_SMOKE_CAPTURE'] = $capturePath
$psi.EnvironmentVariables['PDF2JSON_DISABLE_LOGS'] = '1'

$proc = [System.Diagnostics.Process]::Start($psi)
Write-SmokeStep "sidecar PID $($proc.Id)"

$smokeId = "smoke-pdf-{0:yyyyMMdd-HHmmss}-{1}" -f (Get-Date), [guid]::NewGuid().ToString('N').Substring(0,6)
$pdfABytes = [System.IO.File]::ReadAllBytes($pdfAPath)
$pdfBBytes = [System.IO.File]::ReadAllBytes($pdfBPath)
$payload = @{
    type    = 'user_message'
    id      = $smokeId
    content = 'smoke test (pdf text extraction)'
    attachments = @(
        @{
            name   = 'two-column-layout.pdf'
            type   = 'application/pdf'
            size   = $pdfABytes.Length
            base64 = [Convert]::ToBase64String($pdfABytes)
        },
        @{
            name   = 'invoice-layout.pdf'
            type   = 'application/pdf'
            size   = $pdfBBytes.Length
            base64 = [Convert]::ToBase64String($pdfBBytes)
        }
    )
} | ConvertTo-Json -Compress -Depth 6

Write-SmokeStep "inject id=$smokeId"
$proc.StandardInput.WriteLine($payload)
$proc.StandardInput.Flush()

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$diagLine = $null
$attDir = $null
[string]$capture = ''

while ((Get-Date) -lt $deadline) {
    if (-not $diagLine -and (Test-Path $logPath)) {
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
            if ($hit -match 'attDir=([^\s]+)') { $attDir = $Matches[1] }
        }
    }
    if (Test-Path $capturePath) {
        try { $capture = [string](Get-Content -Path $capturePath -Raw -ErrorAction Stop) } catch {}
    }
    if ($diagLine -and
        $capture.Contains('LEFTCOLUMNALPHA') -and
        $capture.Contains('RIGHTCOLUMNOMEGA') -and
        $capture.Contains('INVOICETOTAL9900')) {
        break
    }
    Start-Sleep -Milliseconds 200
}

$stdoutTail = ''; $stderrTail = ''
try {
    if (-not $proc.HasExited) {
        if ($attDir) {
            $cleanupDeadline = (Get-Date).AddSeconds(5)
            while ((Get-Date) -lt $cleanupDeadline -and (Test-Path $attDir)) {
                Start-Sleep -Milliseconds 100
            }
            if (Test-Path $attDir) {
                $interrupt = @{ type = 'interrupt'; id = $smokeId } | ConvertTo-Json -Compress
                try { $proc.StandardInput.WriteLine($interrupt) } catch {}
                try { $proc.StandardInput.Flush() } catch {}
                $cleanupDeadline = (Get-Date).AddSeconds(3)
                while ((Get-Date) -lt $cleanupDeadline -and (Test-Path $attDir)) {
                    Start-Sleep -Milliseconds 100
                }
            }
        } else {
            Start-Sleep -Milliseconds 500
        }
        try { $proc.StandardInput.Close() } catch {}
        if (-not $proc.WaitForExit(4000)) {
            try { $proc.Kill() } catch {}
            [void]$proc.WaitForExit(2000)
        }
    }
    try { $stdoutTail = $proc.StandardOutput.ReadToEnd() } catch {}
    try { $stderrTail = $proc.StandardError.ReadToEnd() } catch {}
} catch {}

$attDirAfterCleanup = $false
if ($attDir) {
    $cleanupDeadline = (Get-Date).AddSeconds(3)
    while ((Get-Date) -lt $cleanupDeadline -and (Test-Path $attDir)) {
        Start-Sleep -Milliseconds 100
    }
    $attDirAfterCleanup = Test-Path $attDir
}

$failures = New-Object System.Collections.Generic.List[string]

if (-not $diagLine) {
    $failures.Add("no diagnostic line for id=$smokeId in $logPath within ${TimeoutSec}s")
} else {
    Write-SmokeOK "diagnostic line found"
    if ($diagLine -notmatch 'attachments=2\b') {
        $failures.Add("expected attachments=2 (got: $diagLine)")
    } else {
        Write-SmokeOK "attachments=2"
    }
    if (-not $attDir) {
        $failures.Add("attDir missing in diagnostic line")
    } else {
        Write-SmokeOK "attDir=$attDir"
    }
}

foreach ($marker in @('two-column-layout.pdf', 'invoice-layout.pdf', 'LEFTCOLUMNALPHA', 'RIGHTCOLUMNOMEGA', 'INVOICETOTAL9900')) {
    if (-not $capture.Contains($marker)) {
        $failures.Add("captured prompt missing marker: $marker")
    } else {
        Write-SmokeOK "prompt contains $marker"
    }
}

if ($attDir -and $attDirAfterCleanup) {
    $failures.Add("attachment dir survived after turn end: $attDir")
} elseif ($attDir) {
    Write-SmokeOK "cleanup verified"
}

Remove-Item -Recurse -Force -Path $tmpRoot -ErrorAction SilentlyContinue

if ($failures.Count -eq 0) {
    if (-not $Quiet) { Write-Host "" }
    Write-Host "OK smoke-pdf-extraction PASS (id=$smokeId)" -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "FAIL smoke-pdf-extraction ($($failures.Count) issue$(if ($failures.Count -ne 1){'s'}))" -ForegroundColor Red
foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
if ($stderrTail) {
    Write-Host "  --- sidecar stderr (tail) ---" -ForegroundColor DarkYellow
    Write-Host $stderrTail.TrimEnd() -ForegroundColor DarkYellow
}
if ($stdoutTail) {
    Write-Host "  --- sidecar stdout (tail) ---" -ForegroundColor DarkYellow
    Write-Host $stdoutTail.TrimEnd() -ForegroundColor DarkYellow
}
exit 1
