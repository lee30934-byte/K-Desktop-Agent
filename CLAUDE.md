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

## 현재 상태 (2026-05-07)

**완료된 Phase:**
- ✅ **Phase 0**: 스캐폴드, Rust-React 왕복
- ✅ **Phase 1 + UI 재디자인**: 실제 Claude 연결, P3Torrent 스타일
- ✅ **Phase 2**: 트레이 + 자동시작 + 리로드 + 바로가기 (2026-04-21)
- ✅ **Phase 3**: K-Personal MCP 통합 (스크린샷 등 검증 완료)
- ✅ **Phase 4**: SQLite 대화 히스토리 + resume (2026-04-22 latest-ref 버그 수정 포함)
- ✅ **Phase 4.5**: 권한 게이트 v0.4.1 (2026-04-29) — default-allow + 카테고리 토글(8개) + 정밀 잠금(도구 단위 체크박스) + PreToolUse Hook(`sidecar/hooks/preToolUse-overwriteGuard.mjs`)으로 Write/Edit/MultiEdit 덮어쓰기 갭 차단. `ALWAYS_BLOCKED_BYPASS`(Task/Monitor/Skill/NotebookEdit) + `HIGH_RISK_BUILTINS`(Bash) 정책 상시. 회귀 테스트 13/13 통과 (`sidecar/test-perm-gate.mjs`, `sidecar/test-hook-overwriteGuard.mjs`).
- ✅ **Phase 12 — Context Meter v2** (2026-05-06): "100턴 진행해도 컨텍스트 표시 20% 안 올라감" 사고 근본 대책. sidecar 가 SSE `message_start` 의 usage 들 중 (input + cache_creation + cache_read) **턴별 최댓값**을 별도 필드(`maxTurnUsage`)로 emit → 클라이언트는 sub-agent 누적 부풀음을 회피한 정확한 윈도우 점유율 표시. 모델별 분모 동적 적용 (Claude default = 1M, 그 외 = 200K). 회귀 테스트 10/10 (`sidecar/test-context-meter.mjs`) + sidecar.log 에 `displayCtx=`/`rawCtx=` 동시 박혀 갭 추적.
- ✅ **Phase 13 — Headless Automation** (2026-05-06): K 가 RDP/콘솔로 같은 PC 를 동시 사용 시 cc_* (pyautogui SendInput) 가 K 마우스/키보드를 점유해 충돌하던 문제 해소. K-Personal MCP 에 신규 모듈 2개 — `modules/uia_control.py` (uiautomation, 9 도구 `ui_*`) + `modules/web_automation.py` (Playwright 헤드리스 chromium, 9 도구 `web_*`). cc_* (pyautogui) 와 별도 카테고리 (`ui_automation`, `web_automation`). 시스템 프롬프트 자동화 우선순위: web_* > ui_* > cc_*. 외부 패키지 미설치 환경에서도 import 살아남는 지연 로드. 회귀 테스트 11/11 (`sidecar/test-headless-mcp.mjs`) + perm-gate Phase 13 케이스 4개 추가.
- ✅ **Phase 15 — Codex CLI + 외부 사용량 페이지** (2026-05-07): K 가 ChatGPT Pro 구독을 K-Desktop-Agent 안에서 사용 + 사용량 페이지 외부 브라우저 진입. (a) **15.1** Settings 에 외부 사용량 진입 — `lib.rs` 의 `open_external_webview` 가 `tauri-plugin-opener` 의 `open_url` 로 시스템 기본 브라우저에 URL 흘림 (Google OAuth 가 embedded webview 차단해서 외부 브라우저 폴백 필수 — 2021 정책). URL 매핑: Anthropic Max 구독자 = `claude.ai/settings` (console.anthropic.com 은 API 키 사용자 전용 — Max 구독자에겐 무관). (b) **15.2~15.4** Codex CLI provider 분기 — `sidecar/src/index.ts` 의 `provider="codex"` 케이스가 `codex exec --json --skip-git-repo-check` spawn + JSONL 이벤트(`turn.started`/`item.completed`/`turn.completed`) 파싱. `~/.codex/auth.json` OAuth 토큰을 codex CLI 가 관리. `lib.rs` Tauri commands: `codex_login` (background spawn), `codex_login_status`, `codex_register_mcp` (`codex mcp add k-personal -- python <K-Personal-MCP/server.py>`). 회귀 테스트 41/41 (`sidecar/test-codex-integration.mjs`).
- ✅ **Phase 15.5 — Rate Limit Dashboard** (2026-05-07): "5h+주간 한도 사용량 + reset 까지 남은 시간" K 명시 요구. **Anthropic path = ccusage 통합** (`npx ccusage@latest blocks --active --json` + `weekly --json` 5분 간격 polling, statusLine 으로 못 받음 — 이 함정의 자세한 내용은 작업 시 주의사항 섹션 참조). **Codex path = `chatgpt.com/backend-api/codex/usage`** Bearer 토큰으로 polling — `lib.rs` 의 `codex_fetch_usage` Tauri command (reqwest + rustls-tls). UI: `MetricsPanel` 의 `RateLimitCard` 가 시간 진행률 % bar + 누적 토큰 + ⏱ reset countdown + burn rate 위험 시 자동 warn 색. used% 는 Anthropic 비공개라 시간 진행률 fallback (⏳ 아이콘으로 "한도 % 아님" 시각 표시). localStorage 영속 (provider 별 분리). 회귀 테스트 41/41.
- ✅ **Phase 16 — Settings 5탭 분리 + NSIS 바로가기 중복 차단** (2026-05-07): Settings 의 15개 섹션을 AI/에이전트/외관/시스템/안전장치 5탭으로 그룹핑. `src-tauri/installer-hooks.nsh` 의 `NSIS_HOOK_PREINSTALL` 매크로로 `$DESKTOP\${PRODUCTNAME}.lnk` 존재 시 `$NoShortcutMode=1` 박아 update/reinstall 시 바탕화면 바로가기 중복 생성 차단.
- ✅ **Phase 17 — Sidecar cwd pinning + resume 자동 회복 + Update UX** (2026-05-07): **K 의 v0.5.1 인앱 업데이트 후 "이전 대화창에서 작업 표시 2-3초 뜨다 사라짐" 사고**. 원인: Claude CLI 의 transcript 저장소가 `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` 로 **cwd 기반 sharded** 인데, 인앱 업데이트가 sidecar 의 cwd 를 `Documents/...` → `AppData/...\_up_\...` 로 옮겨버려 옛 session ID 의 `--resume` 이 `"No conversation found"` 로 즉사. **3단 대책**:
  1. **cwd pin** (`lib.rs` `spawn_sidecar`): sidecar 를 항상 `~/.kda/cwd/` 에서 실행 → 어떤 버전이든 같은 sharded 폴더로 모임. 영구 면역.
  2. **자동 마이그레이션** (`lib.rs::migrate_legacy_claude_sessions`): spawn 1초 후 `~/.claude/projects/` 에서 `*K-Desktop-Agent*sidecar*` 패턴 옛 sharded 폴더들의 `*.jsonl` 을 새 sharded 폴더로 머지 (`.kda-migrated` sentinel 로 idempotent).
  3. **명시적 회복 흐름** (`sidecar/src/index.ts` + `App.tsx`): stderr `"No conversation found with session ID"` 감지 → `resume_session_missing` 에러 코드 + agentId=null emit → frontend 가 자동으로 그 conversation 의 agent_id 클리어 + 토스트 안내 → 다음 메시지부터 새 session 으로 자연 회복 (사용자 액션 불필요).
  - **추가 UX**: Settings 의 "최신 버전입니다" 표시 옆에 "다시 확인" 버튼 (`update-latest-section`) — 한번 클릭 후 다시 누를 수 없던 K 불편 해소.
  - 회귀 테스트: `check.ps1` Phase 17 블록 — `lib.rs` cwd pin + migration + sidecar `resume_session_missing` emit + App.tsx 자동 회복 분기 + Settings 다시 확인 버튼 5종 grep.
  - **Phase 126 (v0.6.81) — Codex 경로 대칭 회복**: 위 Claude 회복(③)의 Codex 판. Codex 는 resume 대상 rollout 이 없으면 graceful 하게 새로 시작하지 않고 `no rollout found for thread id (-32600)` 로 **exit 1 크래시** → 그 대화가 매 turn 영구 실패 (옛 Codex 버전의 UUIDv4 thread_id vs 최신 UUIDv7 불일치가 전형). `sidecar/src/index.ts` 3중 회복: ① preflight `codexRolloutExists()` — `~/.codex/sessions` **전체 트리** 스캔 (14일 한정 `findCodexSessionFileById` 는 정상 old 세션을 false-positive 로 끊으므로 별도 함수) → 없으면 resume 차단 + 새 세션 + prior_conversation 재주입 ② reactive 안전망 — stderr `no rollout found`/`thread/resume failed` 감지 시 `_codexResumeRetried` 가드로 새 세션 1회 자동 재시도(무한 재귀·중복 long_task 차단) ③ `done` 의 새 agentId 로 frontend 가 고아 id 자동 교체. 자세한 진단은 `pitfall_codex_resume_orphan_thread_crash.md`.
- ✅ **Phase 18 — 의존성 자동 셋업 + Python detect fallback + First-run 마법사** (2026-05-07): K 의 "다른 PC 에서 setup.exe 만 깔고도 한 번에 사용 가능" 요구. **5단 대책**:
  1. **Python detect fallback** (`sidecar/src/index.ts::resolvePython`): Claude/Codex CLI 와 동일 패턴. 후보 6개 순차 probe — `py.exe` → `py` → `python3.exe` → `python3` → `python.exe` → `python`. K PC 처럼 `python` 명령이 PATH 에 없는 환경 (Python 인스톨러의 "Add to PATH" 가 기본 OFF) 도 `py.exe` (Windows Python Launcher) 로 자동 fallback. health check 에러 메시지에 시도한 6개 후보 노출. module 초기화 직후 `resolved python: py.exe tried=[...]` 진단 로그.
  2. **install-deps.ps1** (`scripts/install-deps.ps1`): winget 으로 Node.js LTS / Git / Python 3.11 자동 설치 + `npm i -g` 로 Claude/Codex CLI + K-Personal-MCP 폴더 detect + Python 의존성 자동 설치. idempotent (이미 있으면 skip). `-DryRun` 모드는 검사만 (Settings 가 호출 시 사용). `-AsJson` 으로 결과 JSON stdout (사람용 메시지는 stderr). UTF-8 BOM 인코딩 (PS 5.1 한글 깨짐 회피).
  3. **First-run sentinel** (`~/.kda/first-run-completed.flag`): NSIS 가 안 박음 — 신규 PC / 신규 user 면 자연스럽게 없음. K 가 [첫 셋업 완료 표시] 누르면 박힘. 업데이트 시점엔 이미 sentinel 있어서 마법사 안 뜸.
  4. **Tauri commands + Settings UI** (`lib.rs`: `is_first_run` / `mark_first_run_complete` / `check_dependencies` / `run_install_deps`): 4개 command + `Settings.tsx` 의 system 탭 첫 섹션에 "필수 도구" UI ([상태 새로고침] / [자동 설치 실행] / [Claude 로그인] / [Codex 로그인] / [첫 셋업 완료 표시] 버튼). Settings 가 열릴 때마다 `check_dependencies` 자동 호출 → 단계별 status 표시.
  5. **App.tsx first-run 자동 감지**: 앱 시작 시 `is_first_run` 호출 → true 면 한 번만 (localStorage `kda_firstrun_wizard_seen_v1` guard) Settings 모달을 system 탭으로 자동 오픈.
  - **자동화 안 하는 것**: Claude / Codex 의 OAuth 로그인 (K 계정 정보 필요 — 보안상 자동화 불가). 옛 PC 데이터 이주 (K 요청에 따라 제외).
  - 회귀 테스트: `check.ps1` Phase 18 블록 — `resolvePython` + `py.exe` fallback + init log + install-deps.ps1 함수 4종 + UTF-8 BOM + lib.rs 4 command + Settings invoke + first-run guard 7종 grep.

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

### ⭐ 운영 원칙: Release 와 Dev 분리
K 가 일상적으로 사용하는 앱은 **release 바이너리**. Claude 가 코드 수정할 때만 dev 모드 띄움.
이유: dev 모드는 Rust 파일 변경 시 자동 full rebuild 하면서 창이 40~60초 사라짐.
Release 는 watcher 가 없어 **절대 안 꺼짐**. 성능도 더 빠름.

Tauri identifier (`com.k.desktop-agent`) 가 같아서 **대화 DB/설정은 양쪽이 공유**.

### 일상 사용 (Release)
바탕화면 아이콘은 `src-tauri/target/release/k-desktop-agent.exe` 직접 실행.
한 번 셋업:
```powershell
npm run tauri build -- --no-bundle        # 최초 release 빌드 (5~10분)
.\scripts\setup-shortcuts.ps1 -Release    # 바로가기를 release 로 교체
```

### 코드 수정 워크플로우 (Claude 가 주로 수행)
1. **dev 모드 띄우기**: `.\scripts\run-dev.ps1` — HMR 로 빠른 반복
2. **preflight**: `.\scripts\check.ps1 -SkipDeps`
3. **동작 확인**: dev 창에서 변경 검증
4. **release 반영**: `.\scripts\rebuild-release.ps1 -Launch` — 재빌드 후 새 바이너리로 교체
5. dev 세션은 Ctrl+C 또는 내버려둠 (release 와 동시 실행 가능)

**중요**: Rust 또는 sidecar 코드를 바꾼 뒤에는 **반드시 rebuild-release 제안** — 안 그러면 K 의 일상 앱은 옛날 코드로 동작.

### 인스톨러 빌드 (Phase 5 — 아직 미사용)
```powershell
.\scripts\build-msi.ps1
```
MSI/NSIS 인스톨러가 `src-tauri/target/release/bundle/` 에 생성.

### 바탕화면 바로가기 / 자동시작
```powershell
.\scripts\setup-shortcuts.ps1 -Release             # release 모드 (권장)
.\scripts\setup-shortcuts.ps1 -Release -AutoStart  # + Windows 시작 시 자동 실행
.\scripts\setup-shortcuts.ps1                      # dev 모드 (launch.vbs)
.\scripts\setup-shortcuts.ps1 -Remove              # 모두 제거
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
- **큰 컨텐츠는 인자 대신 stdin/파일로** (sidecar → Claude CLI 호출 시):
  Windows `cmd.exe` 의 명령행 길이 한계는 8191자. `--system-prompt` / `--settings` / `--mcp-config`
  같은 인자에 큰 텍스트(메모리·로그·다대수 hook JSON 등)를 박으면 spawn 자체가 실패한다
  (`명령줄이 너무 깁니다`). 새 큰 컨텐츠는 반드시 (1) prompt 본문(stdin) 의 `<...>` 블록으로 외화하거나
  (2) 임시 파일 + path 인자(`--system-prompt-file <path>` 등)로 전달. `sidecar/src/index.ts` 의
  `pushOrMaterialize` 헬퍼와 `LARGE_ARG_THRESHOLD`(1500자) 정책을 사용. 회귀는
  `sidecar/test-cmdline-limit.mjs` (preflight 에 결합) 가 거대 시나리오에서 검증.
- **컨텍스트 % 표시는 SSE message_start 기반** (Phase 12 — Context Meter v2):
  sidecar 의 `case "stream_event"` 안에서 `message_start.message.usage` 의 `(input + cache_creation +
  cache_read)` 를 turn 동안 캡처해 최댓값을 `done.maxTurnUsage` 로 emit. 클라이언트(MetricsPanel)
  는 이걸 우선 사용 — `result.usage` 는 sub-agent / iterative tool 호출이 누적 합산되어 1M~4M 로
  부풀어 윈도우 점유율로 부적절. 분모는 모델별 (Claude default = 1M, 그 외 = 200K). sidecar.log
  의 `displayCtx=`/`rawCtx=` 가 매 turn 박혀 추정/실측 갭 추적 가능. 회귀는
  `sidecar/test-context-meter.mjs` 가 검증.
- **자동화 도구 우선순위는 `web_* > ui_* > cc_*`** (Phase 13 — Headless Automation):
  K 가 RDP/콘솔로 같은 PC 를 동시 사용 중일 수 있어 `cc_*` (pyautogui SendInput, K 마우스/키보드
  점유) 를 함부로 호출하면 입력 충돌. 새 작업은 항상:
  1. **웹** → `mcp__k-personal__web_open` + `web_snapshot` + `web_click` / `web_fill`
     (Playwright 헤드리스 chromium, K 화면에 안 뜸)
  2. **데스크톱 앱** → `mcp__k-personal__ui_dump_tree` → `ui_click_by_name` / `ui_set_text`
     (Windows UI Automation, 마우스 커서 안 움직임, 백그라운드 창에도 동작)
  3. **위 둘이 안 먹는 캔버스/게임/DRM** → `cc_screenshot` + `cc_mouse_click` (K 입력 점유,
     호출 전 한 줄 고지). 새 도구 추가 시 `sidecar/src/index.ts` 의 `PERM_TOOL_MAP` +
     `Settings.tsx` 의 `TOOL_CATALOG` + `sidecar/test-headless-mcp.mjs` 의 `EXPECTED_*_TOOLS`
     **세 곳 모두** 동기화 (preflight 의 `test-headless-mcp.mjs` 가 이걸 강제 검증).
- **외부 사용량 페이지는 항상 시스템 기본 브라우저로** (Phase 15.1 — Google OAuth + Tauri webview 함정):
  Google OAuth 가 embedded webview (Tauri/Electron) 의 user-agent 를 disallowed 로 차단 (2021~).
  결과: anthropic.com / chatgpt.com 같은 OAuth 페이지를 `WebviewWindowBuilder` 의 새 창으로 열면
  "로그인 중 오류" 페이지에 막힘. → `lib.rs` 의 `open_external_webview` 가 `tauri-plugin-opener` 의
  `app.opener().open_url(&url, None::<&str>)` 로 K 의 시스템 기본 브라우저(Edge/Chrome) 에 흘림.
  K 평소 브라우저의 cookie 가 영속되어 다음 진입 시 자동 로그인 — bonus. URL 매핑 함정: **Anthropic
  Max/Pro 구독자는 `claude.ai/settings` 가 정답** (console.anthropic.com/usage 는 API 키 사용자 전용
  대시보드 — 정액 구독자 사용량은 거기에 안 나옴). `Settings.tsx` 의 `EXTERNAL_USAGE_PAGES`
  배열에서 새 페이지 추가 시 회귀 테스트 (`sidecar/test-codex-integration.mjs` 의 `claude.ai/settings`
  grep) 도 같이 갱신.
- **Rate Limit Dashboard 는 ccusage + Codex backend-api 두 path** (Phase 15.5):
  Anthropic 의 5h+주간 한도 used% 는 **공식 비공개** — `rate_limit_event` SSE 페이로드는
  `{status:"allowed", resetsAt, rateLimitType:"five_hour"}` 만 줌 (used% / 주간 누적 없음).
  Claude Code 의 `statusLine` JSON 에 정확한 `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`
  가 박혀 오지만 — **K-Desktop-Agent 가 spawn 하는 `claude -p` (non-interactive) 에서는 statusLine
  trigger 안 됨** (interactive REPL 전용). statusLine helper 자체는 `~/.kda/statusline.mjs` +
  `~/.claude/settings.json` 에 install 되어 있어서 K 가 별도 터미널에서 interactive `claude` 쓰면
  자동 작동 (dormant fallback). 실제 데이터 path: **(1) `npx ccusage@latest blocks --active --json` +
  `weekly --json` 5분 polling** — `~/.claude/projects/` session 파일 파싱이라 statusLine 무관, 정확한
  토큰 + reset 시간 받음. **(2) Codex 는 `chatgpt.com/backend-api/codex/usage` GET (Bearer from
  `~/.codex/auth.json`)** — 비공식 endpoint 라 OpenAI 변경 시 깨질 위험, sidecar 가 silently fail.
  Anthropic 의 한도값 자체가 비공개라 ccusage 도 used% 안 줌 → UI 는 **시간 진행률** (block_start ~
  block_end 사이 위치) 을 ⏳ 아이콘과 함께 표시 (한도 % 가 아님을 시각적으로 명시). burn rate 위험
  (`projection.remainingMinutes < block 남은 시간`) 시 카드 자동 warn 색 + 툴팁에 "이 페이스면 한도
  도달까지 X분". 새 provider 추가 시 `App.tsx` 의 `normalizeRateLimit` defensive parser 와 sidecar 의
  emit 형식 맞추기.

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
검사 항목: Rust `cargo check`, 프론트 `tsc --noEmit`, sidecar `tsc --noEmit`, sidecar 회귀 테스트 (perm-gate / overwriteGuard hook / cmdline-limit), `npm ls` 누락 패키지.

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
- 모델: Opus 5.7 (1M context) 기본 사용
- K-Personal MCP 경로: `C:\Users\user\Documents\K-Personal-MCP\server.py`
- Python: `python` (PATH에 있음)
- Git Bash: `C:\Program Files\Git\bin\bash.exe`
- Tauri 2 문서: https://tauri.app/v2/
- Claude Agent SDK 문서: https://docs.claude.com/en/api/agent-sdk/overview
