<#
.SYNOPSIS
  K-Desktop-Agent 비상 복구 스크립트
  — LLM 통신 불능 시 K 가 단독 실행하는 마지막 보루.

.DESCRIPTION
  .backups\latest.txt 가 가리키는 마지막 백업 시점으로 모든 것을 되돌립니다.
  • k-desktop-agent.exe (release 바이너리)
  • sidecar/dist/index.js
  • conversations.db (+ WAL/SHM)
  복원 전 현재 상태는 *.broken 접미사로 별도 보존하므로
  롤백 후에도 사고 진단 가능합니다.

.NOTES
  - 더블클릭만으로 동작 (5초 카운트다운 후 자동 진행, 실수 클릭 시 Ctrl+C 로 취소).
  - 실패해도 .broken 들이 남아 K 가 수동 복원 가능.
  - 새 백업을 만들거나 추가 .bak 파일을 만들지 않음 — 기존 latest 만 사용.

.PARAMETER Yes
  카운트다운/대기 없이 즉시 진행. Settings UI 의 [복구] 버튼이 호출할 때 사용.

.PARAMETER NoLaunch
  복원 후 K-Desktop-Agent 자동 재기동 스킵. 디버깅용.
#>
param(
  [switch]$Yes,
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot  # scripts/ 의 상위 = 프로젝트 루트
$backupsDir = Join-Path $root '.backups'
$latestFile = Join-Path $backupsDir 'latest.txt'

function Write-Title($t) { Write-Host ""; Write-Host "════════════════════════════════════════" -ForegroundColor Cyan; Write-Host "  $t" -ForegroundColor Cyan; Write-Host "════════════════════════════════════════" -ForegroundColor Cyan }
function Write-Step($t) { Write-Host "▸ $t" -ForegroundColor Yellow }
function Write-OK($t)   { Write-Host "  ✅ $t" -ForegroundColor Green }
function Write-Err($t)  { Write-Host "  ❌ $t" -ForegroundColor Red }

Write-Title "K-Desktop-Agent 비상 복구"

# 1. 백업 위치 확인
if (-not (Test-Path $latestFile)) {
  Write-Err "백업 정보 없음: $latestFile"
  Write-Host "이 PC 에는 아직 백업이 만들어지지 않았습니다."
  Write-Host "Settings → 안전장치 → '지금 백업하기' 를 한 번 눌러주세요."
  Read-Host "엔터를 누르면 종료"
  exit 1
}
$label = (Get-Content $latestFile -Raw).Trim()
$backupDir = Join-Path $backupsDir $label
if (-not (Test-Path $backupDir)) {
  Write-Err "백업 폴더가 사라졌습니다: $backupDir"
  Read-Host "엔터를 누르면 종료"
  exit 1
}
Write-OK "복원 대상 백업: $label"
$manifest = $null
$manifestPath = Join-Path $backupDir 'manifest.json'
if (Test-Path $manifestPath) {
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  Write-OK "manifest 로드 (생성 시각: $($manifest.timestamp))"
}

# 2. 카운트다운 (실수 클릭 방지) — -Yes 면 스킵
if ($Yes) {
  Write-Host ""
  Write-Host "▸ -Yes 모드: 카운트다운 없이 즉시 진행" -ForegroundColor Magenta
} else {
  Write-Host ""
  Write-Host "5초 후 복원이 시작됩니다. 취소하려면 지금 Ctrl+C 를 누르세요." -ForegroundColor Magenta
  for ($i = 5; $i -gt 0; $i--) {
    Write-Host -NoNewline "  $i... "
    Start-Sleep -Seconds 1
  }
  Write-Host "진행!" -ForegroundColor Green
}

# 3. 실행 중인 K-Desktop-Agent 종료
Write-Step "실행 중인 K-Desktop-Agent 종료"
$procs = Get-Process k-desktop-agent -ErrorAction SilentlyContinue
if ($procs) {
  $procs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Write-OK "$(($procs).Count) 개 프로세스 종료"
} else {
  Write-OK "이미 종료 상태"
}
# sidecar (node.exe) 도 별도 정리 (release 가 죽으면 자동으로 같이 죽지만 안전상)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*K-Desktop-Agent*sidecar*dist*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 4. 복원 대상 매핑
$plan = @(
  @{ Backup='k-desktop-agent.exe';    Target="$root\src-tauri\target\release\k-desktop-agent.exe" },
  @{ Backup='sidecar-dist-index.js';  Target="$root\sidecar\dist\index.js" },
  @{ Backup='conversations.db';       Target="$env:APPDATA\com.k.desktop-agent\conversations.db" },
  @{ Backup='conversations.db-shm';   Target="$env:APPDATA\com.k.desktop-agent\conversations.db-shm" },
  @{ Backup='conversations.db-wal';   Target="$env:APPDATA\com.k.desktop-agent\conversations.db-wal" }
)

# 5. 현재 상태를 *.broken 으로 보존 (롤백 진단용)
Write-Step "현재 상태 *.broken 으로 보존"
foreach ($p in $plan) {
  if (Test-Path $p.Target) {
    $brokenPath = "$($p.Target).broken"
    try {
      if (Test-Path $brokenPath) { Remove-Item $brokenPath -Force }
      Move-Item $p.Target $brokenPath -Force
      Write-OK "$(Split-Path $p.Target -Leaf)  →  *.broken"
    } catch {
      Write-Err "보존 실패 ($(Split-Path $p.Target -Leaf)): $_"
    }
  }
}

# 6. 백업에서 복원
Write-Step "백업에서 복원"
$failures = 0
foreach ($p in $plan) {
  $src = Join-Path $backupDir $p.Backup
  if (-not (Test-Path $src)) {
    Write-Host "  · $($p.Backup) 백업에 없음 — 스킵 (정상 케이스)" -ForegroundColor DarkGray
    continue
  }
  try {
    # SHA256 검증 (manifest 가 있으면)
    if ($manifest) {
      $expected = ($manifest.files | Where-Object { $_.name -eq $p.Backup }).sha256
      if ($expected) {
        $actual = (Get-FileHash $src -Algorithm SHA256).Hash
        if ($actual -ne $expected) {
          Write-Err "체크섬 불일치 ($($p.Backup)) — 복원 중단"
          $failures++
          continue
        }
      }
    }
    # 대상 폴더 보장
    $targetDir = Split-Path $p.Target -Parent
    if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
    Copy-Item $src $p.Target -Force
    Write-OK "$($p.Backup)  →  $($p.Target)"
  } catch {
    Write-Err "복원 실패 ($($p.Backup)): $_"
    $failures++
  }
}

# 7. 결과 + 재기동
Write-Host ""
if ($failures -eq 0) {
  Write-Title "복원 완료"
  if (-not $NoLaunch) {
    $exe = "$root\src-tauri\target\release\k-desktop-agent.exe"
    if (Test-Path $exe) {
      Start-Process $exe
      Write-OK "K-Desktop-Agent 시작됨"
    } else {
      Write-Err "복원된 바이너리를 찾을 수 없음: $exe"
    }
  } else {
    Write-Host "  · -NoLaunch 모드: 자동 재기동 스킵" -ForegroundColor DarkGray
  }
} else {
  Write-Title "일부 복원 실패 ($failures 개)"
  Write-Host "실패 항목은 *.broken 으로 그대로 남겨뒀습니다." -ForegroundColor Yellow
  Write-Host "복원 가능한 부분만 적용된 상태입니다." -ForegroundColor Yellow
}

Write-Host ""
if ($Yes) {
  Write-Host "(-Yes 모드: 자동 닫힘)" -ForegroundColor DarkGray
} else {
  Write-Host "이 창은 30초 후 자동 닫힙니다." -ForegroundColor DarkGray
  Start-Sleep -Seconds 30
}
