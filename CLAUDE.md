# K Desktop Agent — Project Context for Claude Code

이 파일은 Claude Code CLI가 자동으로 읽어 프로젝트 컨텍스트를 파악하는 용도입니다. 이 프로젝트에서 작업할 때 이 파일의 지침을 우선 따라주세요.

## 프로젝트 개요

**K Desktop Agent**는 K님 개인 Windows 컴퓨터를 자동화하는 Claude 기반 채팅 앱입니다.

- **아키텍처**: Tauri (Rust backend + React TypeScript frontend) + Node.js sidecar (Claude Agent SDK)
- **MCP 통합**: K-Personal MCP (Python, 42개 도구) — 화면/마우스/키보드/파일/앱/DB
- **디자인**: P3Torrent 인스파이어드 HUD 다크 스타일 (시안 네온 + 모서리 L자 브래킷)
- **창 크기**: 1200×800 데스크톱 3분할 (사이드바 + 메인 + 하단 미터)

## 파일 구조

```
K-Desktop-Agent/
├── CLAUDE.md                  ← 이 파일 (Claude Code 자동 인식)
├── ROADMAP.md                 ← Phase 목록 및 상태
├── HANDOFF.md                 ← Cowork에서 전환해오는 가이드
├── docs/
│   ├── PHASE-2-TRAY.md        ← 트레이·자동시작·리로드 설계 (완료)
│   ├── PHASE-4-SQLITE.md      ← 대화 히스토리 DB (예정)
│   ├── PHASE-5-POLISH.md      ← 마크다운·인스톨러 (예정)
│   ├── APPLY-PHASE2-UPDATE.md ← Phase 2 적용 절차 (Claude 실행용)
│   └── DEPLOYMENT.md          ← 배포/실행 방식 가이드
├── src/                       React 프론트엔드
│   ├── App.tsx                이벤트 핸들러, 상태 관리
│   ├── App.css                P3Torrent 스타일
│   ├── index.css              디자인 토큰
│   ├── types.ts               공유 TS 타입
│   └── components/
│       ├── Sidebar.tsx        좌측 사이드바, Settings 진입
│       ├── MainChat.tsx       중앙 채팅
│       ├── Composer.tsx       입력창
│       ├── Message.tsx        메시지 렌더러
│       ├── MetricsPanel.tsx   하단 미터
│       ├── Settings.tsx       설정 모달 (Phase 2)
│       └── CornerBrackets.tsx L자 장식
├── src-tauri/                 Rust 백엔드
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs            --minimized 플래그 처리
│       └── lib.rs             트레이·sidecar 관리·IPC·reload
├── sidecar/                   Node.js 사이드카
│   └── src/index.ts           Claude Agent SDK + MCP 연결
└── scripts/                   PowerShell / VBScript 편의 스크립트
    ├── setup.ps1              최초 환경 설치 (Rust, Node, VS BT)
    ├── run-dev.ps1            개발 모드 실행
    ├── build-msi.ps1          릴리즈 빌드 (Phase 5)
    ├── setup-shortcuts.ps1    바탕화면·시작메뉴·자동시작 등록
    └── launch.vbs             창 없이 앱 실행 (바로가기 Target)
```

## 현재 상태 (2026-04-22)

**완료된 Phase:**
- ✅ **Phase 0**: 스캐폴드, Rust-React 왕복
- ✅ **Phase 1 + UI 재디자인**: 실제 Claude 연결, P3Torrent 스타일
- ✅ **Phase 2**: 트레이 + 자동시작 + 리로드 + 바로가기 (2026-04-21)
- ✅ **Phase 3**: K-Personal MCP 통합 (스크린샷 등 검증 완료)
- ✅ **Phase 4**: SQLite 대화 히스토리 + resume (2026-04-22 latest-ref 버그 수정 포함)

**남은 Phase:**
- ⬜ **Phase 5**: 마크다운 렌더링 + MSI 인스톨러 (`docs/PHASE-5-POLISH.md`)

## 기술 결정 사항

### 인증
- Claude Max 구독의 OAuth 인터랙티브 로그인 사용 (`claude login`)
- Refresh token 자동 갱신 → 수동 재로그인 불필요
- 환경변수 `CLAUDE_CODE_OAUTH_TOKEN` 은 사용하지 않음

### sidecar 통신 프로토콜

stdin/stdout JSON 라인 기반. 자세한 건 `sidecar/src/index.ts` 주석.

**Rust → Sidecar:**
- `user_message`, `interrupt`, `ping`, `recheck_mcp`

**Sidecar → Rust:**
- `ready`, `assistant_delta`, `tool_use`, `tool_result`, `done`, `error`, `log`, `mcp_status`, `pong`
- 주의: `assistant_delta` 의 `text` 는 **전체 내용** (델타 아님 — 프론트에서 replace)

### Rust → Frontend (Tauri 이벤트)
- `sidecar-event`: sidecar stdout JSON 을 그대로 중계
- `open-settings`: 트레이 메뉴에서 Settings 열기 신호

### Tauri Commands (프론트 ↔ Rust)
- `send_message(message, id)` — 사용자 메시지 전송
- `interrupt(id)` — 현재 응답 중단
- `reload_sidecar()` — sidecar 프로세스 재기동
- `show_main_window()`, `hide_main_window()`, `quit_app()` — 창 제어

### Windows 특이사항

1. **npx → npx.cmd**: Rust `Command::new()` 에서 Windows 면 `.cmd` 확장자 필요. `lib.rs` 에서 `cfg!(windows)` 분기.
2. **Git Bash 필수**: Claude CLI가 내부적으로 git-bash 사용. `CLAUDE_CODE_GIT_BASH_PATH` 환경변수로 지정.
3. **MS Store 앱 가상화**: Claude Desktop은 MS Store 패키지라 `AppData\Roaming\Claude` 가 `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\` 로 리다이렉션됨.
4. **PowerShell UTF-8 BOM**: `scripts/*.ps1` 파일은 BOM 필수 (한글 깨짐 방지).
5. **창 없는 실행**: 바탕화면 바로가기는 `wscript.exe scripts\launch.vbs` 타겟 → VBS 가 `cmd /c` 로 `npm run tauri:dev` 를 hidden 모드 실행.

### 디자인 토큰
`src/index.css` 의 `:root` 에 정의. **하드코딩 금지**, 항상 CSS 변수 사용.
- 색상: `--bg-0` ~ `--bg-4`, `--accent` (시안), `--warn` (오렌지)
- 폰트: `--font-display`, `--font-body`, `--font-mono`
- 간격: `--space-xs` ~ `--space-2xl`

## 개발 워크플로우

### 로컬 개발 (매일)
```powershell
cd C:\Users\user\Documents\K-Desktop-Agent
.\scripts\run-dev.ps1
```
TSX/CSS 수정은 HMR 자동 적용. Rust/sidecar 수정은 Ctrl+C 후 재시작.

### 릴리즈 빌드 (Phase 5)
```powershell
.\scripts\build-msi.ps1
```
MSI/NSIS 인스톨러가 `src-tauri/target/release/bundle/` 에 생성.

### 바탕화면 바로가기 / 자동시작
```powershell
.\scripts\setup-shortcuts.ps1             # 바탕화면 + 시작메뉴만
.\scripts\setup-shortcuts.ps1 -AutoStart  # + Windows 시작 시 자동 실행
.\scripts\setup-shortcuts.ps1 -Remove     # 모두 제거
```

### DevTools
평소엔 자동으로 안 열림 (Phase 2 에서 변경). 필요할 때만:
```powershell
$env:KDA_OPEN_DEVTOOLS="1"
.\scripts\run-dev.ps1
```

## 코딩 컨벤션

- **TypeScript**: strict mode. `any` 사용 시 주석으로 이유 명시.
- **React**: 함수형 컴포넌트 + hooks. 클래스 금지.
- **CSS**: 토큰 사용, BEM 풍. 인라인 스타일은 동적 값에만.
- **Rust**: `Result<T, String>` 반환, `.map_err(|e| e.to_string())` 패턴. async 커맨드는 `tauri::command` 매크로.
- **Node sidecar**: stdout 은 JSON 프로토콜 전용. 로그는 `log("info", ...)` 헬퍼.

## 작업 시 주의사항

- **파괴적 변경** (파일 삭제, 스키마 변경 등)은 반드시 K에게 확인.
- 새 의존성 추가 시:
  - 프론트 → `package.json`
  - Rust → `src-tauri/Cargo.toml`
  - sidecar → `sidecar/package.json`
- **CSP 정책** (`src-tauri/tauri.conf.json`): 외부 도메인 추가 시 `security.csp` 갱신.
- **Tauri 권한**: 새 API 사용 시 `src-tauri/capabilities/default.json` 에 permission 추가.
- **Windows 경로**: TS 리터럴에선 forward slash (`C:/Users/...`) 나 이중 백슬래시 사용.

## "Phase X 진행해줘" 라고 요청받을 때

### Phase 2 적용 (코드는 이미 있음, 설치만)
`docs/APPLY-PHASE2-UPDATE.md` 의 Step 1~6 순서대로.

### Phase 4, 5 신규 작업
1. `ROADMAP.md` 의 상태 확인
2. 해당 Phase의 `docs/PHASE-N-*.md` 읽기
3. 파일 변경 계획을 **요약 제시** → K 승인 후 실제 편집
4. Edit 도구로 파일 수정
5. **필수: `.\scripts\check.ps1` 통과 확인** (cargo check + tsc --noEmit + npm ls). 실패하면 Phase 완료로 넘어가지 말 것.
6. 변경 후 `.\scripts\run-dev.ps1` 재실행 요청 (sidecar/Rust 바뀌었으면)
7. 성공 기준 검증 (K-Personal MCP 의 screenshot 으로 UI 확인 가능)
8. 완료 시 `CLAUDE.md` "현재 상태" 업데이트 + `ROADMAP.md` 체크박스

### Preflight 검증 (`scripts/check.ps1`)
Phase 완료 전, 커밋 전, 새 의존성 추가 후에는 반드시 실행:
```powershell
.\scripts\check.ps1            # 전체 검사
.\scripts\check.ps1 -SkipDeps  # 빠른 반복 (타입/컴파일만)
```
검사 항목: Rust `cargo check`, 프론트 `tsc --noEmit`, sidecar `tsc --noEmit`, `npm ls` 누락 패키지.

### 런타임 로그 위치
문제 발생 시 아래 로그를 먼저 확인:
- `logs/launch.log` — `run-dev.ps1` 로 실행 시 stdout/stderr
- `logs/sidecar.log` — sidecar 기동/종료/재시작 이력
- `logs/shutdown.log` — 앱 생명주기 이벤트 (start, exit, window X, tray quit)
- `logs/crash.log` — Rust 패닉 스택트레이스

### 검증에 K-Personal MCP 활용
- UI 변경 후: `mcp__k-personal__cc_screenshot` 으로 스크린샷 찍어 렌더링 확인
- 파일 영향 범위: `mcp__k-personal__*` 로 로그/설정 파일 조회
- 프로세스: `mcp__k-personal__*` 로 실행 중인 프로세스 체크

## 참고 정보

- Claude Max 계정: kcppride@gmail.com
- 모델: Opus 4.7 (1M context) 기본 사용
- K-Personal MCP 경로: `C:\Users\user\Documents\K-Personal-MCP\server.py`
- Python: `python` (PATH에 있음)
- Git Bash: `C:\Program Files\Git\bin\bash.exe`
- Tauri 2 문서: https://tauri.app/v2/
- Claude Agent SDK 문서: https://docs.claude.com/en/api/agent-sdk/overview
