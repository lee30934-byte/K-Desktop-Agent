# Phase 1 + UI 재디자인 업데이트 가이드

이 문서는 **Phase 0 동작 확인 후** Phase 1 (실제 Claude 연결) + P3Torrent 스타일 UI로 전환하는 절차입니다.

## 무엇이 바뀌었나

| 항목 | 변경 |
|---|---|
| 창 크기 | 480×720 → **1200×800** (사이드바+메인+하단 미터 3분할) |
| 디자인 | 라이트 모드 → **P3Torrent HUD 다크 모드** (시안 네온 + 모노스페이스) |
| 백엔드 | Rust echo → **Node sidecar + Claude Agent SDK** |
| 구조 | 단일 `App.tsx` → **`src/components/` 폴더로 분리** |

## 변경된 파일

**덮어쓰기:**
- `src-tauri/tauri.conf.json` — 창 크기 1200×800
- `src-tauri/src/lib.rs` — Node sidecar 기동/IPC 로직
- `sidecar/src/index.ts` — Claude Agent SDK 연결
- `src/App.tsx` — 3분할 레이아웃, 이벤트 기반 스트리밍
- `src/App.css` — 전체 재작성 (P3Torrent 스타일)
- `src/index.css` — 디자인 토큰 + 폰트 임포트

**새 파일:**
- `src/types.ts`
- `src/components/CornerBrackets.tsx`
- `src/components/Sidebar.tsx`
- `src/components/Message.tsx`
- `src/components/Composer.tsx`
- `src/components/MainChat.tsx`
- `src/components/MetricsPanel.tsx`

**제거된 파일:**
- `phase1-files/` 폴더 (더 이상 필요 없음. 있으면 삭제해도 됨)

## 전환 절차

### ⓵ 현재 돌아가는 dev 서버 중지

`Ctrl+C` 로 `run-dev.ps1` 종료. 창도 닫기.

### ⓶ 새 zip 받기

아래 순서대로 PowerShell에서:

```powershell
# Cowork outputs에서 새 zip 가져오기
$claudeRoot = "$env:LOCALAPPDATA\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\local-agent-mode-sessions"
$sessionDir = Get-ChildItem -Path $claudeRoot -Directory -Recurse -Filter "outputs" -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
$zipPath = Join-Path $sessionDir.FullName "K-Desktop-Agent.zip"

# 기존 Documents 폴더 백업
$existing = "$env:USERPROFILE\Documents\K-Desktop-Agent"
if (Test-Path $existing) {
    Move-Item $existing "$env:USERPROFILE\Desktop\K-Desktop-Agent-v0-backup" -Force
}

# 새 버전 압축 해제
Expand-Archive -Path $zipPath -DestinationPath "$env:USERPROFILE\Documents" -Force

cd "$env:USERPROFILE\Documents\K-Desktop-Agent"
Write-Host "✓ 새 버전 준비 완료" -ForegroundColor Green
```

### ⓷ Claude 로그인 확인 (최초 1회)

Claude Agent SDK가 Claude Code CLI의 OAuth 토큰을 씁니다.

```powershell
$claudeExe = Get-ChildItem "$env:LOCALAPPDATA\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code" -Recurse -Filter "claude.exe" -ErrorAction SilentlyContinue |
             Select-Object -First 1 -ExpandProperty FullName

if ($claudeExe) {
    Write-Host "✓ claude.exe:" $claudeExe
    & $claudeExe setup-token
} else {
    Write-Warning "claude.exe 못 찾음. Claude Desktop 앱이 설치돼 있는지 확인."
}
```

브라우저가 열리고 Claude Max/Pro 계정으로 로그인 → 토큰 저장.

이미 로그인돼 있으면 "Already logged in" 같은 메시지가 나옵니다.

### ⓸ npm 의존성 재설치

새 의존성 (`@anthropic-ai/claude-agent-sdk` 등) 설치:

```powershell
cd "$env:USERPROFILE\Documents\K-Desktop-Agent"
npm install
```

이때 **`E404` 에러가 나면** `@anthropic-ai/claude-agent-sdk` 패키지 이름이 다른 걸 수 있어요. 그때는 저한테 알려주세요 — 대체 구현(Claude Code CLI 직접 spawn)으로 교체해드립니다.

### ⓹ 개발 모드 실행

```powershell
.\scripts\run-dev.ps1
```

- **최초 실행**: Rust 의존성 다시 컴파일. 약간 걸림.
- 창이 뜨면 **1200×800 크기 + 다크 UI + 사이드바** 가 보여야 함.

### ⓺ Phase 1 성공 기준

- [ ] 상단 우측 상태 배지가 **"CONNECTING" → "LIVE"** (시안색) 로 바뀜
- [ ] 하단 미터 패널에 7개 카드 (Model, Turns, Tools Called 등) 렌더
- [ ] "안녕" 입력 → Claude가 **한국어로 자연스러운 응답** 스트리밍
- [ ] 응답 중 **STOP 버튼**으로 중단 가능
- [ ] 창 닫으면 Node 프로세스도 같이 종료

## 트러블슈팅

### ⚠ 창은 뜨는데 "CONNECTING" 에서 멈춤

Sidecar가 기동 실패. PowerShell 창 (dev 서버 돌린 터미널) 에서 `[sidecar:stderr]` 로그 확인:

- `Cannot find module '@anthropic-ai/claude-agent-sdk'` → `cd sidecar && npm install`
- `ENOENT: npx not found` → Node PATH 문제. 새 터미널 열고 재시도.
- `OAuth token not found` → ⓷ 로그인 단계 다시.

### ⚠ 메시지 보내면 에러 `{type: "error"}`

PowerShell의 stderr 로그 확인. Claude Agent SDK가 내부적으로 `claude` CLI를 찾으려는데 경로 못 찾는 경우일 수도.

### ⚠ Google Fonts가 안 로드됨 (폰트가 시스템 기본으로 보임)

CSP 문제일 수 있어요. `src-tauri/tauri.conf.json` 의 `security.csp` 에 `https://fonts.googleapis.com` 과 `https://fonts.gstatic.com` 이 포함돼 있는지 확인. 기본적으로 포함돼 있음.

### ⚠ 다크 테마 대신 흰 화면이 번쩍

페이지 최초 로드 시 간헐적 현상. `body { background: var(--bg-1) }` 가 적용되기 전 순간. 무시해도 됨 (Vite HMR 에서만 발생).

## 로드맵 상 위치

- [x] Phase 0: 스캐폴드 + 에코
- [x] **Phase 1 + UI 재디자인**: 실제 Claude 연결 + P3Torrent 스타일 ⭐ 지금 여기
- [ ] Phase 2: 시스템 트레이 + Windows 시작 시 자동 실행
- [ ] Phase 3: K-Personal MCP 자동 기동·등록
- [ ] Phase 4: SQLite 대화 히스토리
- [ ] Phase 5: 마크다운 렌더링, 인스톨러 빌드, 지인 배포
