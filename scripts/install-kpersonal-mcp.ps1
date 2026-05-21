<#
.SYNOPSIS
  K-Personal-MCP 자동 설치 — KDA Settings 의 한 클릭으로 다른 PC 에서도 MCP 도구 셋업.

.DESCRIPTION
  Phase 66 (v0.6.1): K 가 여러 PC 에서 KDA + MCP 도구 (ui_*, web_*, fm_*, app_*,
  clip_*, db_*, cc_*) 를 그대로 쓰게 만들기.

  이 스크립트가 하는 일 (idempotent):
    1. ~/Documents/K-Personal-MCP/server.py 존재 확인 — 있으면 skip
    2. 없으면 git clone https://github.com/lee30934-byte/K-Personal-MCP.git
    3. install.bat 실행 (pip install -r requirements.txt + playwright install chromium)
    4. 결과 server.py 검증

  Tauri command install_kpersonal_mcp 가 이 스크립트 호출.

  사전 조건 (없으면 KDA Settings → 시스템 → 의존성 자동 셋업 먼저):
    - git (Git for Windows)
    - python (3.11+ 권장)

.PARAMETER AsJson
  결과를 JSON 으로 stdout 출력 (Tauri command 가 파싱).

.PARAMETER DryRun
  실제 설치 안 하고 상태만 detect.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-kpersonal-mcp.ps1 -AsJson
#>

[CmdletBinding()]
param(
    [switch]$AsJson,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Phase 66.6 (v0.6.7) — 한국어 Windows 의 PowerShell 5.1 출력 인코딩 fix.
# K 의 PC 가 한국어 Windows 면 PS 5.1 의 기본 OutputEncoding 이 CP949 (EUC-KR).
# Rust 의 sidecar 가 stdout 을 String::from_utf8_lossy 로 받으면 한글이 깨져 "오류" 가
# "����" 로 표시. K 의 toast / Settings UI 에서 진단이 어려워짐.
# Console + $OutputEncoding 둘 다 UTF-8 로 강제 — stdout 에 박히는 모든 한글 안전.
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    # 일부 환경 (Win10 LTSC, locked-down PS) 에선 OutputEncoding 변경 거부될 수 있음.
    # 그 경우는 한글 깨짐을 감수하고 진행 — 본 흐름엔 영향 없음.
}

$result = @{
    success = $false
    alreadyInstalled = $false
    target = ''
    serverPyExists = $false
    pythonAvailable = $false
    gitAvailable = $false
    steps = @()
    error = $null
}

function Add-Step {
    param([string]$msg)
    $script:result.steps += $msg
    if (-not $AsJson) { Write-Host $msg }
}

try {
    # 1. 대상 경로 (사용자 Documents 폴더)
    $documents = [Environment]::GetFolderPath('MyDocuments')
    $targetDir = Join-Path $documents 'K-Personal-MCP'
    $serverPy = Join-Path $targetDir 'server.py'
    $result.target = $targetDir
    $result.serverPyExists = Test-Path $serverPy
    Add-Step "target: $targetDir"

    # 2. 이미 설치?
    if ($result.serverPyExists) {
        $result.alreadyInstalled = $true
        $result.success = $true
        Add-Step "OK 이미 설치되어 있음 — server.py 발견"
    } else {
        # 3. Git 확인 (clone 에 필요)
        try {
            $gitVer = git --version 2>&1
            if ($LASTEXITCODE -eq 0) {
                $result.gitAvailable = $true
                Add-Step "git: $gitVer"
            }
        } catch {}
        if (-not $result.gitAvailable) {
            throw "git 명령 없음 — 'winget install Git.Git' 또는 KDA Settings 의 '의존성 자동 셋업' 먼저 실행"
        }

        # 4. Python 확인 (install.bat 에 필요)
        foreach ($candidate in @('py.exe', 'py', 'python.exe', 'python', 'python3.exe', 'python3')) {
            try {
                $null = & $candidate --version 2>&1
                if ($LASTEXITCODE -eq 0) {
                    $result.pythonAvailable = $true
                    Add-Step "python: $candidate"
                    break
                }
            } catch {}
        }
        if (-not $result.pythonAvailable) {
            Add-Step "WARN Python 없음 — git clone 까진 가지만 install.bat 의 pip install 단계가 실패할 수 있음. KDA Settings 의 의존성 자동 셋업으로 Python 먼저 설치 권장."
        }

        if ($DryRun) {
            Add-Step "(DryRun) 실제 설치 안 함 — git/python 검사만 완료"
            $result.success = $true
        } else {
            # 5. git clone
            #
            # Phase 66.6 (v0.6.7) — PowerShell 5.1 의 native command stderr ErrorRecord 함정 회피.
            #
            # 이전 코드: `git clone ... 2>&1` + `$ErrorActionPreference='Stop'` 조합에서
            #   git 의 정상 진행 메시지 ("Cloning into '...'" 가 stderr 로 출력됨) 가
            #   NativeCommandError 로 wrap 되어 즉시 throw → catch 에서 "Cloning..." 자체를
            #   에러 메시지로 받음. clone 자체는 성공해도 실패로 판정.
            #
            # 회피: cmd /c 로 wrap. cmd 안에서 stderr 가 stdout 으로 merge → PS 가 단순
            # 문자열 array 로 받아 ErrorRecord wrap 안 함. $LASTEXITCODE 만 진짜 exit 검사.
            $repoUrl = 'https://github.com/lee30934-byte/K-Personal-MCP.git'
            Add-Step "git clone $repoUrl ..."
            # 경로에 공백 / 한글 (OneDrive 의 "문서") 가 있을 수 있어 인용 필수.
            $cmdLine = "git clone `"$repoUrl`" `"$targetDir`" 2>&1"
            $cloneOutput = & cmd /c $cmdLine
            $cloneCode = $LASTEXITCODE
            if ($cloneOutput) {
                $cloneOutput | ForEach-Object { Add-Step "  $($_.ToString())" }
            }
            if ($cloneCode -ne 0) {
                throw "git clone failed (exit $cloneCode) — 네트워크/권한/repo 접근 확인"
            }

            # 6. install.bat 실행 (있으면)
            $installBat = Join-Path $targetDir 'install.bat'
            if (Test-Path $installBat) {
                Add-Step "install.bat 실행 (pip install + playwright)..."
                Push-Location $targetDir
                try {
                    $batOutput = & cmd /c "install.bat" 2>&1
                    $batCode = $LASTEXITCODE
                    $batOutput | ForEach-Object { Add-Step "  $($_.ToString())" }
                    if ($batCode -ne 0) {
                        Add-Step "WARN install.bat exit=$batCode — 일부 단계 실패. 수동으로 'pip install -r requirements.txt' 시도 필요할 수 있음."
                    }
                } finally {
                    Pop-Location
                }
            } else {
                Add-Step "WARN install.bat 없음 — repo 구조 다름. 수동 pip install -r requirements.txt 필요"
            }

            # 7. 검증
            $result.serverPyExists = Test-Path $serverPy
            if ($result.serverPyExists) {
                Add-Step "OK 설치 완료 — server.py 확인됨"
                $result.success = $true
            } else {
                throw "설치 후에도 server.py 없음 — clone 결과 비정상"
            }
        }
    }
} catch {
    $result.success = $false
    $result.error = $_.Exception.Message
    Add-Step "ERR 오류: $($_.Exception.Message)"
}

# Phase 66.7 (v0.6.8) — 성공 시 sidecar 가 server.py 를 못 찾는 OneDrive redirect 함정 해결.
#
# 이 스크립트는 [Environment]::GetFolderPath('MyDocuments') 로 Windows KnownFolder API
# 통해 정확한 Documents 경로 (OneDrive 한글 "문서" redirect 포함) 를 받는 반면,
# sidecar 의 node `path.join(home, "Documents")` 는 redirect 무시 → server.py 못 찾음 →
# MCP 도구 0개 → Settings 탭이 빈 상태.
#
# 해결: 검증된 target 을 ~/.kda/kpersonal-mcp-path.txt 에 박음. sidecar / Rust 가
# 이 파일을 candidates 보다 우선 사용해 정확한 path 자동 발견.
# - UTF-8 no-BOM (외부 도구가 읽는 파일 — pitfall_powershell_secret_bom 회피책 D)
# - 성공 시에만 박음 (실패면 stale cache 남기지 않게 삭제)
if ($result.success -and $result.serverPyExists) {
    try {
        $kdaDir = Join-Path $env:USERPROFILE '.kda'
        if (-not (Test-Path $kdaDir)) {
            New-Item -ItemType Directory -Path $kdaDir -Force | Out-Null
        }
        $cacheFile = Join-Path $kdaDir 'kpersonal-mcp-path.txt'
        # UTF-8 no-BOM 으로 박음 — node / Rust 양쪽 모두 BOM strip 안전망 있지만 깔끔하게.
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($cacheFile, $targetDir, $utf8NoBom)
        Add-Step "OK cache 박음: $cacheFile"
    } catch {
        Add-Step "WARN cache 박기 실패 (sidecar fallback candidates 로 시도됨): $($_.Exception.Message)"
    }
}

if ($AsJson) {
    # stdout JSON 출력. PS 5.1 의 BOM 함정 회피: stdout pipe 는 BOM 안 박음 (Out-File 만 위험).
    $result | ConvertTo-Json -Compress -Depth 5
}
