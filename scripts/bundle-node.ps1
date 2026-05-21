# Node.js 번들링 스크립트
# 설치파일에 Node.js를 포함시켜 완전 독립 실행 가능하게 합니다.

param(
    [string]$NodeVersion = "20.18.0"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $ProjectRoot) { $ProjectRoot = (Get-Location).Path }

$NodeDir = Join-Path $ProjectRoot "node-bundle"
$NodeZip = Join-Path $NodeDir "node.zip"
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"

Write-Host "=== Node.js 번들링 스크립트 ===" -ForegroundColor Cyan
Write-Host "Node.js 버전: $NodeVersion"
Write-Host "프로젝트 루트: $ProjectRoot"

# 1. node-bundle 폴더 생성
if (-not (Test-Path $NodeDir)) {
    New-Item -ItemType Directory -Path $NodeDir | Out-Null
    Write-Host "[1/4] node-bundle 폴더 생성됨" -ForegroundColor Green
} else {
    Write-Host "[1/4] node-bundle 폴더 이미 존재" -ForegroundColor Yellow
}

# 2. Node.js 다운로드 (없으면)
$NodeExe = Join-Path $NodeDir "node.exe"
if (-not (Test-Path $NodeExe)) {
    Write-Host "[2/4] Node.js 다운로드 중... ($NodeUrl)" -ForegroundColor Cyan

    # 다운로드
    Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip -UseBasicParsing

    # 압축 해제
    Write-Host "     압축 해제 중..." -ForegroundColor Cyan
    Expand-Archive -Path $NodeZip -DestinationPath $NodeDir -Force

    # 파일들을 node-bundle 루트로 이동
    $ExtractedDir = Join-Path $NodeDir "node-v$NodeVersion-win-x64"
    if (Test-Path $ExtractedDir) {
        Get-ChildItem $ExtractedDir | ForEach-Object {
            Move-Item $_.FullName $NodeDir -Force
        }
        Remove-Item $ExtractedDir -Force -Recurse
    }

    # zip 파일 삭제
    Remove-Item $NodeZip -Force

    Write-Host "[2/4] Node.js 다운로드 완료" -ForegroundColor Green
} else {
    Write-Host "[2/4] Node.js 이미 존재" -ForegroundColor Yellow
}

# 3. 불필요한 파일 제거 (용량 최소화)
$FilesToRemove = @(
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "node_etw_provider.man",
    "install_tools.bat",
    "nodevars.bat"
)

foreach ($file in $FilesToRemove) {
    $filePath = Join-Path $NodeDir $file
    if (Test-Path $filePath) {
        Remove-Item $filePath -Force
        Write-Host "     제거됨: $file" -ForegroundColor DarkGray
    }
}

Write-Host "[3/4] 불필요한 파일 정리 완료" -ForegroundColor Green

# 4. tauri.conf.json의 resources에 node-bundle 추가 확인
$TauriConf = Join-Path $ProjectRoot "src-tauri\tauri.conf.json"
$conf = Get-Content $TauriConf -Raw | ConvertFrom-Json

$nodeResource = "../node-bundle/**/*"
if ($conf.bundle.resources -notcontains $nodeResource) {
    $conf.bundle.resources += $nodeResource
    $conf | ConvertTo-Json -Depth 10 | Set-Content $TauriConf -Encoding UTF8
    Write-Host "[4/4] tauri.conf.json에 node-bundle 리소스 추가됨" -ForegroundColor Green
} else {
    Write-Host "[4/4] tauri.conf.json에 이미 node-bundle 포함됨" -ForegroundColor Yellow
}

# 크기 확인
$NodeSize = (Get-ChildItem $NodeDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ""
Write-Host "=== 완료 ===" -ForegroundColor Cyan
Write-Host "Node.js 번들 크기: $([math]::Round($NodeSize, 2)) MB" -ForegroundColor White
Write-Host "위치: $NodeDir" -ForegroundColor White
Write-Host ""
Write-Host "다음 단계:" -ForegroundColor Yellow
Write-Host "  1. npm run tauri:build 실행"
Write-Host "  2. 설치파일에 Node.js가 포함됩니다"
