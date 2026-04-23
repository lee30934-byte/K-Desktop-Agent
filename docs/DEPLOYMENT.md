# 배포 & 실행 가이드

K Desktop Agent 를 일상적으로 쓰기 위한 설치/실행 방식 정리.

## 실행 방식 3가지

| 방식 | 언제 쓰나 | 장단점 |
|---|---|---|
| **바탕화면 바로가기** (권장) | 평소 사용 | PS 창 안 뜸, 더블클릭 한 번으로 실행 |
| **시작 프로그램** | 부팅 시 항상 | 자동 실행 후 트레이에만, 창 없이 대기 |
| **PowerShell `run-dev.ps1`** | 개발/디버깅 | 빌드 로그 실시간 볼 수 있음 |

## 최초 설치 (K의 메인 PC 기준, 이미 돼 있음)

요약: `setup.ps1` (환경) → `run-dev.ps1` 1회 (빌드) → `setup-shortcuts.ps1 -AutoStart` (바로가기).

세부 절차는 `docs/APPLY-PHASE2-UPDATE.md` 참고.

## 지인 PC 에 배포하려면

> **주의**: 아직 MSI 인스톨러 빌드는 Phase 5 에서 구현 예정.
> 현재는 K의 PC 기반 "dev 모드 영구화" 방식.

1. 지인 PC 에 아래 사전 조건:
   - Node.js LTS
   - Rust + MSVC Build Tools (처음 빌드 시 필요)
   - Git for Windows (Claude CLI 동작용)
   - Python 3.10+ (K-Personal MCP 용 — 배포자 MCP 구성에 따라 생략 가능)

2. `K-Desktop-Agent` 폴더 통째로 USB/클라우드로 복사

3. 지인 PC에서:
   ```powershell
   cd D:\K-Desktop-Agent    # 배치한 경로
   .\scripts\setup.ps1       # 의존성 설치 (최초 1회)
   .\scripts\run-dev.ps1     # 첫 빌드 (3~5분)
   .\scripts\setup-shortcuts.ps1
   ```

4. 지인 Claude Max 계정 로그인:
   ```powershell
   & "C:\Users\$env:USERNAME\AppData\Local\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code\*\claude.exe"
   # 브라우저에서 로그인
   /exit
   ```

5. 이제 바탕화면 아이콘으로 사용.

## 일상 워크플로우

### 매일 시작
- (자동 시작 등록한 경우) 부팅 시 트레이에 K 아이콘 자동 생성 → 좌클릭해 창 복원
- (자동 시작 안 한 경우) 바탕화면 아이콘 더블클릭

### 대화 중
- X 버튼으로 닫으면 트레이로 숨김 (프로세스 살아있음)
- 다음에 창 열 때 이전 대화 세션 그대로 (Phase 4 구현 전까지는 메시지는 휘발)

### 문제 발생
- 응답 이상하면: Settings → Reload Sidecar (앱 재시작 없이 sidecar 재기동)
- 심각하면: 트레이 우클릭 → Quit → 바탕화면 아이콘 재실행
- 로그: `Documents\K-Desktop-Agent\logs\launch.log` (바탕화면 시작 기록)

## 업그레이드 (Cowork 세션에서 새 코드 받은 뒤)

1. Cowork 세션 outputs 에서 `K-Desktop-Agent.zip` 최신본 받기
2. 앱 종료 (트레이 → Quit)
3. Documents 의 기존 폴더에 **zip 덮어쓰기** (node_modules/target 은 보존됨)
4. `npm install` 실행 (새 의존성 있는 경우)
5. 다음 앱 실행부터 적용

**업그레이드 자동화 스크립트**는 `scripts/upgrade-from-cowork.ps1` (향후 작성).

## 설정 파일 위치

| 종류 | 경로 |
|---|---|
| Tauri 프론트 설정 | `src-tauri/tauri.conf.json` |
| Tauri 권한 | `src-tauri/capabilities/default.json` |
| Rust 의존성 | `src-tauri/Cargo.toml` |
| Node 프론트 의존성 | `package.json` |
| Sidecar 의존성 | `sidecar/package.json` |
| K-Personal MCP 경로 | `sidecar/src/index.ts` 의 `K_PERSONAL_PATH` |
| 사용자 설정 (자동 시작 등) | `%APPDATA%\K Desktop Agent\` (향후 Phase 4) |
| 실행 로그 | `logs/launch.log` |

## 자주 쓰는 명령

```powershell
# 개발 모드
.\scripts\run-dev.ps1

# 바로가기 재생성 (아이콘 깨지면)
.\scripts\setup-shortcuts.ps1

# 자동 시작 토글
.\scripts\setup-shortcuts.ps1 -AutoStart    # 등록
.\scripts\setup-shortcuts.ps1 -Remove       # 모두 제거 후 재실행

# 새 의존성 반영
npm install

# Rust 클린 빌드 (컴파일 꼬였을 때)
cd src-tauri; cargo clean; cd ..
.\scripts\run-dev.ps1

# Tauri 2 공식 문서
start "https://tauri.app/v2/"
```
