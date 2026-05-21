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
            Add-Step "git clone https://github.com/lee30934-byte/K-Personal-MCP.git ..."
            $cloneOutput = git clone 'https://github.com/lee30934-byte/K-Personal-MCP.git' $targetDir 2>&1
            $cloneCode = $LASTEXITCODE
            $cloneOutput | ForEach-Object { Add-Step "  $($_.ToString())" }
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

if ($AsJson) {
    # stdout JSON 출력. PS 5.1 의 BOM 함정 회피: stdout pipe 는 BOM 안 박음 (Out-File 만 위험).
    $result | ConvertTo-Json -Compress -Depth 5
}
