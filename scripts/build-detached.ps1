# v0.7.20 릴리스 빌드 — detached 실행용.
# 왜: 빌드는 수 분 걸리는데 에이전트 turn 은 단발성이라 turn 안에서 기다리면 안 된다.
# 이 스크립트는 별도 프로세스로 떠서 빌드하고, 끝나면 .done 마커를 남긴다.
# task-watch 가 그 마커를 보고 원래 대화창에 완료 turn 을 주입한다.
#
# [함정 기록 2026-08-18] 이전 판은 `& npm run tauri:build` 로 호출했는데,
# PowerShell 에서 `npm` 은 npm.ps1 (ExternalScript) 로 먼저 잡히고,
# npm.ps1 은 -Command 모드에서 문장 텍스트를 InvocationName 길이만큼 Substring 해서 인자를 만든다.
# 문장이 `& npm ...` 로 시작하면 앞 3글자("& n")가 잘려 `pm run tauri:build` 가 전달돼
# `Unknown command: "pm"` 으로 즉사한다. → npm.cmd 를 절대경로로 호출할 것.
param(
  [string]$Root = "C:\Users\lee30\Documents\K-Desktop-Agent",
  [string]$Log  = "C:\Users\lee30\.kda\build-0.7.21.log",
  [string]$Done = "C:\Users\lee30\.kda\build-0.7.21.done"
)

# 상속 환경을 믿지 않고 PATH 재구성 (MSYS/Git-bash PATH 오염 방지)
$env:PATH = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [Environment]::GetEnvironmentVariable("Path", "User")
$env:PATH = "C:\Users\lee30\.cargo\bin;$env:PATH"

$npmCmd   = "C:\Program Files\nodejs\npm.cmd"
$cargoExe = "C:\Users\lee30\.cargo\bin\cargo.exe"

Set-Location -LiteralPath $Root
if (Test-Path -LiteralPath $Done) { Remove-Item -LiteralPath $Done -Force }

function Write-Log([string]$Text) {
  Add-Content -LiteralPath $Log -Value $Text -Encoding UTF8
}

Set-Content -LiteralPath $Log -Value "=== v0.7.21 tauri build start $(Get-Date -Format o) ===" -Encoding UTF8

$exit = 1
try {
  foreach ($tool in @($npmCmd, $cargoExe)) {
    if (-not (Test-Path -LiteralPath $tool)) { throw "required tool is missing: $tool" }
  }
  Write-Log "npm   = $npmCmd"
  Write-Log "cargo = $cargoExe"

  & $npmCmd run tauri:build 2>&1 | ForEach-Object { Write-Log ([string]$_) }
  $exit = $LASTEXITCODE
} catch {
  Write-Log "EXCEPTION: $_"
  $exit = 99
}

Write-Log "=== end exit=$exit $(Get-Date -Format o) ==="
Set-Content -LiteralPath $Done -Value "exit=$exit" -Encoding UTF8
