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
  [switch]$AsJson,
  # Phase 25 (v0.5.11): K-Desktop-Agent 의 portable data root.
  # 비어있으면 옛 동작 유지 (project root 의 .backups + APPDATA 의 conversations.db)
  [string]$DataRoot = '',
  # 옵션 — DB 파일들 직접 경로 지정 가능. 안 주면 $DataRoot/conversations.db 우선 → APPDATA 폴백.
  [string]$DbPath = ''
)
$ErrorActionPreference = 'Stop'

# UTF-8 콘솔 인코딩 — pitfall_powershell_secret_bom 의 stderr 변종 방어 (v0.5.10 박힌 패턴)
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }

$projectRoot = Split-Path -Parent $PSScriptRoot
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$folderLabel = "$ts-$Label"

# 백업 base 결정: -DataRoot 우선, 없으면 옛 project root 동작
$backupBase = if ($DataRoot) { $DataRoot } else { $projectRoot }
$backupDir = Join-Path $backupBase ".backups\$folderLabel"
$latestFile = Join-Path $backupBase ".backups\latest.txt"

function Out-Status($msg, $color = 'Gray') {
  if (-not $AsJson) { Write-Host $msg -ForegroundColor $color }
}

New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

# DB 위치 결정: -DbPath > $DataRoot/conversations.db > APPDATA fallback
$dbCandidates = @()
if ($DbPath) { $dbCandidates += $DbPath }
if ($DataRoot) { $dbCandidates += (Join-Path $DataRoot 'conversations.db') }
$dbCandidates += "$env:APPDATA\com.k.desktop-agent\conversations.db"

$dbResolved = $null
foreach ($c in $dbCandidates) {
  if (Test-Path $c) { $dbResolved = $c; break }
}
if (-not $dbResolved) { $dbResolved = $dbCandidates[0] }  # missing 표시용

$dbDir = Split-Path -Parent $dbResolved
$dbBase = Split-Path -Leaf $dbResolved

$targets = @(
  @{ Name='k-desktop-agent.exe';    Src="$projectRoot\src-tauri\target\release\k-desktop-agent.exe" },
  @{ Name='sidecar-dist-index.js';  Src="$projectRoot\sidecar\dist\index.js" },
  @{ Name='conversations.db';       Src=$dbResolved },
  @{ Name='conversations.db-shm';   Src=(Join-Path $dbDir "$dbBase-shm") },
  @{ Name='conversations.db-wal';   Src=(Join-Path $dbDir "$dbBase-wal") }
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
