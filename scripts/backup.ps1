<#
.SYNOPSIS
  K-Desktop-Agent 새 백업 스냅샷 생성.

.DESCRIPTION
  현재 release 바이너리, sidecar dist, 대화 DB 를 .backups/<timestamp-label>/ 로 복사.
  manifest.json + latest.txt 갱신.

.PARAMETER Label
  백업 폴더 접미사. 기본값 'manual'.

.PARAMETER AsJson
  결과를 JSON 으로 stdout 에 출력 (lib.rs 의 backup_now Tauri command 가 호출 시 사용).
#>
param(
  [string]$Label = 'manual',
  [switch]$AsJson
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$folderLabel = "$ts-$Label"
$backupDir = Join-Path $root ".backups\$folderLabel"
$latestFile = Join-Path $root ".backups\latest.txt"

function Out-Status($msg, $color = 'Gray') {
  if (-not $AsJson) { Write-Host $msg -ForegroundColor $color }
}

New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

$targets = @(
  @{ Name='k-desktop-agent.exe';    Src="$root\src-tauri\target\release\k-desktop-agent.exe" },
  @{ Name='sidecar-dist-index.js';  Src="$root\sidecar\dist\index.js" },
  @{ Name='conversations.db';       Src="$env:APPDATA\com.k.desktop-agent\conversations.db" },
  @{ Name='conversations.db-shm';   Src="$env:APPDATA\com.k.desktop-agent\conversations.db-shm" },
  @{ Name='conversations.db-wal';   Src="$env:APPDATA\com.k.desktop-agent\conversations.db-wal" }
)

$manifestFiles = @()
foreach ($t in $targets) {
  $dst = Join-Path $backupDir $t.Name
  if (Test-Path $t.Src) {
    Copy-Item $t.Src $dst -Force
    $hash = (Get-FileHash $dst -Algorithm SHA256).Hash
    $size = (Get-Item $dst).Length
    $manifestFiles += [PSCustomObject]@{ name = $t.Name; size = $size; sha256 = $hash; src = $t.Src; missing = $false }
    Out-Status ("  OK  {0,-30} {1,9} bytes" -f $t.Name, $size) 'Green'
  } else {
    $manifestFiles += [PSCustomObject]@{ name = $t.Name; size = 0; sha256 = $null; src = $t.Src; missing = $true }
    Out-Status ("  SKIP {0}  (source missing)" -f $t.Src) 'DarkGray'
  }
}

$manifest = [PSCustomObject]@{
  timestamp = $ts
  label = $folderLabel
  createdBy = $Label
  files = $manifestFiles
}

$manifestPath = Join-Path $backupDir 'manifest.json'
# ⚠️ PS 5.1 의 Set-Content -Encoding UTF8 은 UTF-8 BOM (EF BB BF) 을 자동 주입함.
# lib.rs 의 read_to_string(latest.txt).trim() 은 BOM 을 trim 안 해서 label 이 "\u{FEFF}..." 가 됨 →
# .backups/<label> 폴더 못 찾아 "백업 없음" 으로 처리되는 회귀 (2026-05-06 발생).
# UTF-8 no BOM 강제하기 위해 .NET API 직접 사용.
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$manifestJson = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, $utf8NoBom)
[System.IO.File]::WriteAllText($latestFile, $folderLabel, $utf8NoBom)

# UI 편의 정보 추가
$totalSize = ($manifestFiles | Where-Object { -not $_.missing } | Measure-Object size -Sum).Sum
if (-not $totalSize) { $totalSize = 0 }

if ($AsJson) {
  $output = [PSCustomObject]@{
    timestamp = $ts
    label = $folderLabel
    createdBy = $Label
    files = $manifestFiles
    total_size = $totalSize
    dir_path = $backupDir
  }
  # ASCII-safe JSON (lib.rs 에서 안전하게 파싱)
  $json = $output | ConvertTo-Json -Depth 5 -Compress
  # PowerShell 5.1 의 BOM 회피 — Console.Out.Write 로 raw UTF-8 출력
  [Console]::Out.Write($json)
} else {
  Out-Status ""
  Out-Status "백업 위치: $backupDir" 'Cyan'
  Out-Status ("총 크기 : {0:N1} MB" -f ($totalSize/1MB)) 'Cyan'
}
