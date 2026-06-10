# Changelog

모든 주요 변경사항을 여기에 기록합니다.
형식: [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/)

## [Unreleased]

## [0.7.8] - 2026-06-10

### Removed
- **PDF 첨부 텍스트 추출 기능 전체 제거 (K 요청)**. 이 기능은 K님 회사 업무용 스캔-PDF OCR 작업(별도 프로젝트)을 KDA로 검증하던 과정에서 곁가지로 파생돼 v0.7.7에 동봉됐으나, K님이 원치 않아 다시 떼어냄.
  - 삭제: `sidecar/src/pdfText.ts`, `sidecar/src/pdf-extract-cli.ts`, `scripts/extract-pdf-text.ps1`, `scripts/smoke-pdf-extraction.ps1`.
  - 사이드카 `materializeAttachments`에서 PDF 텍스트 추출/프롬프트 주입 경로 제거 — 첨부 파일은 이전처럼 temp 경로 전달만(이미지 vision·텍스트 본문은 그대로). `pdf2json` 의존성 제거.
  - CI: release.yml / smoke.yml 의 PDF 스모크 스텝과 release-confidence 파이프라인(`full-rebuild-and-verify.ps1`)의 PDF 스모크 단계 제거. v0.7.5~v0.7.7을 괴롭힌 PDF 스모크 CI hang 이슈도 함께 소멸.
- Fable 5 모델 지원(v0.7.7) 및 그 외 기능은 그대로 유지.

## [0.7.7] - 2026-06-10

### Added
- Claude Fable 5 (`claude-fable-5`) is now available in both Claude Code (Max OAuth) and Anthropic API provider model pickers.
- Existing Claude Max default/Opus 4.8 selections are migrated once to Fable 5 so the new release uses the latest model immediately; Opus 4.8 and Claude CLI auto remain selectable.
- Context meter handling now treats Fable 5 as a 1M-token model, matching Anthropic's current model documentation.
- PDF attachments are now text-extracted in the sidecar before Claude/Codex launch. Extracted text is appended to the prompt while the original file path remains available for manual Read checks.
- Added `scripts/extract-pdf-text.ps1` and `sidecar/src/pdf-extract-cli.ts` for standalone PDF text extraction.
- Added `scripts/smoke-pdf-extraction.ps1`, covering two different PDF layouts and verifying extracted prompt text plus temp attachment cleanup. The release confidence pipeline now runs this smoke.

### Fixed
- **PDF smoke가 CI에서만(특히 release.yml) 멈춰 릴리스를 차단하던 근본 버그**: 스모크 하니스가 사이드카 stdout/stderr를 redirect만 해두고 턴이 끝날 때까지 읽지 않았다. Windows에서 redirect된 자식 stdout 파이프는 **동기(synchronous)** 라, 부모가 비워주지 않으면 OS 파이프 버퍼가 차는 순간 사이드카의 `process.stdout.write`가 이벤트 루프를 통째로 블록한다. 그러면 stdin에 이미 도착한 라인의 `rl.on("line")`조차 못 돌려 PDF 처리가 멈췄다(진단 라인·프롬프트 마커 0, 20초 타임아웃). 시작 시점에 나가는 stdout 양(MCP 리스팅·rate-limit polling·statusline)이 타이밍에 따라 버퍼를 채우기 전후로 갈려 CI-only flaky로 보였다. 하니스가 `BeginOutputReadLine`/`BeginErrorReadLine`으로 stdout/stderr를 시작 즉시 백그라운드에서 계속 drain하도록 수정 → 파이프가 절대 차지 않아 사이드카가 블록되지 않는다. v0.7.5/v0.7.6 릴리스 빌드 실패의 진짜 근본 원인이었다.

---

## [0.7.4] - 2026-06-09

사이드바 헤더의 버전 표기가 실제 앱 버전을 따라가도록 고친 패치 + 누적된 사이드카/UI 수정 묶음. KDA 자체 스케줄러 하트비트(실험)도 함께 포함.

### Fixed
- **사이드바 헤더 버전이 릴리스해도 안 바뀌던 버그**: `Sidebar.tsx` 의 `PERSONAL CONSOLE // V0.1.0` 이 하드코딩이라 업데이트해도 그대로였다. `@tauri-apps/api/app` 의 `getVersion()` 으로 런타임 주입하도록 변경 → 이제 `tauri.conf.json` 버전을 자동으로 따라간다(Settings 의 "현재 버전" 표기와 동일 소스).
- **턴마다 CMD 콘솔 창이 깜빡이던 문제**: 사이드카의 `spawn(..., { shell: true })` 5곳(CLAUDE_CLI 턴 실행, CODEX_CLI 턴 실행, python/claude/codex `--version` 탐지)에 `windowsHide: true` 누락 → `cmd.exe /c` 콘솔이 매번 노출. 전부 `windowsHide: true` 추가로 해소.
- **WSL 경로 매핑 기본값 버그**: 환경설정 "openclaw 기본값 채우기" 가 distro 를 `Ubuntu` 로 넣어 접근 불가였던 것을 `Ubuntu-22.04` 로 교정.

### Added
- **X-4 — KDA 자체 스케줄러 하트비트(실험)**: harness 의 ScheduleWakeup 을 대체해, `personal.db` 의 schedules 테이블을 60s 주기로 직접 폴링 → 도래분을 ⏰ 예약 conv 로 turn 주입. 영속화(personal.db) + 시작 직후 catch-up + `schedule-heartbeat.log` 로깅 + busy gate/쿨다운으로 폭주 방지. Tauri 명령 `get_personal_db_path`/`append_schedule_log` 추가.

---

## [0.7.3] - 2026-06-09

Long-running Claude/Codex turns can now keep producing sidecar heartbeat evidence while tools are active, preventing the 480s idle watchdog from aborting legitimate work such as builds, smoke tests, or long MCP calls.

### Fixed
- Raised the default per-turn idle watchdog from 8 minutes to 1 hour, while keeping env overrides available.
- Added active tool tracking for Claude `tool_use/tool_result` and Codex `item.started/item.completed` events.
- Added `turn_heartbeat` and `long_task_evidence` events so the frontend and logs can distinguish active work from a stalled child process.
- Extended release preflight checks to require the new heartbeat/watchdog markers.

---

## [0.7.2] - 2026-06-06

환경설정 안전장치 탭의 상태 표시 배선 버그를 잡은 패치. 기능 자체는 정상 동작했고 표시만 어긋났던 문제입니다.

### Fixed
- **Memory Sync 칩이 항상 "비활성"으로 표시되던 버그**: `Settings.tsx` 의 sidecar 이벤트 listener 가 `sidecar_event`(언더스코어)로 구독하고 있었으나 Rust(`lib.rs:3158`)·`App.tsx` 는 `sidecar-event`(하이픈)으로 emit/listen — 한 글자 오타로 `git_sync_status`/`safety_stats_response`/`git_sync_log_response` 3개 이벤트가 Settings 에 전혀 도달하지 못했다. 실제 Git Memory Sync 는 정상 동작(주기적 자동 커밋 확인)했고 **상태 표시만** 초기값에 멈춰 있던 것. 이벤트 이름을 `sidecar-event` 로 교정 → Memory Sync 상태·안전 통계·커밋 히스토리 뷰어가 함께 정상화. 회귀 방지 주석 추가.

### Verified (no change needed)
- v0.7.1 신규 기능 전수 점검: 전체 listen↔emit 이벤트 이름 매칭(어긋난 건 위 1건뿐), 새 Tauri 명령 3종(get_agent_flags/set_agent_flag/agent_soul_status) 구현·등록·인자 매핑, 실험기능 토글 round-trip(optimistic+롤백), 상태 칩 직접 invoke 로딩 — 모두 정상 확인.

---

## [0.7.1] - 2026-06-06

v0.7.0 의 실험 기능 토글(`~/.kda/agent-flags.json`)을 환경설정 UI 에서 직접 켜고 끌 수 있게 한 패치. JSON 수동 편집이 더 이상 필요 없습니다.

### Added
- **실험 기능 토글 UI**: 환경설정 → 🛡️ 에이전트 탭에 "🧪 실험 기능 (에이전트)" 섹션 신설. 5개 기능(턴경계 nudge / 실패 자동포착 / 자기수정 메모리 / 일정·리마인더 / 스킬 import)을 토글로 on/off. 각 토글에 설명·위험도 표시, 효과는 다음 turn 부터 적용(시스템 프롬프트/도구 게이트가 turn 시작 시 고정되는 기존 설계 그대로).
- **안전 상태 요약 칩**: 🆘 안전장치 탭 상단 요약 카드에 "🧪 실험 기능 (n/5 ON)"·"🪪 soul.md (존재/크기)" 상태 칩 추가.
- **Tauri 명령 3종** (`get_sidecar_config`/`set_sidecar_config_flag` 패턴 미러링): `get_agent_flags`(기본 전부 false), `set_agent_flag`(키 화이트리스트 검증 + merge-write, BOM 없는 UTF-8), `agent_soul_status`(soul.md 존재/크기/경로).

### Changed
- 토글은 optimistic update + 실패 시 자동 롤백. agent-flags.json 은 기존 키를 보존(merge)하며 허용된 5개 키만 수정.
- 프론트엔드 변경이 포함되지만 `index.html` 의 cache-busting meta(Phase 98.3)가 이미 있어 webview2 캐시 stale 함정은 자동 회피됩니다.

---

## [0.7.0] - 2026-06-06

Hermes 에이전트 연구 성과를 KDA 에 이식한 대형 패치 — 3계층 메모리(프롬프트 선택 로딩 / 에피소드 검색 / 스킬 메모리) + 함정 가드 데이터화. 백엔드/사이드카 전용이며 프론트엔드 UI 변경은 없습니다.

### Added
- **Phase 106 — 메모리 선택 로딩 일반화**: `~/.kda/memory/*.md` frontmatter 의 `triggers`/`always`/우선순위를 해석해 현재 메시지와 관련된 메모만 프롬프트에 주입. 32KB 초과 시 우선순위가 낮은 항목부터 한 줄 요약으로 축약하고 드롭 목록을 명시. mtime 캐시로 파일 재파싱 최소화.
- **Phase 107 — 스킬 메모리**: `skill_*.md`(agentskills.io 호환 frontmatter: name/description/triggers/allowed-tools/success_count 등) 를 트리거 매칭으로 선택 로딩. 90일 미사용 후보를 Curator 가 정리 후보로 표시.
- **Phase 108 — 에피소드 검색**: `db_convo_search` MCP 도구 추가. 과거 대화를 FTS5(external-content + trigram, 한글 부분검색 지원)로 검색하고, FTS5 미가용/짧은 질의 시 LIKE 폴백. bm25 + 최근성 정렬, 멱등 재인덱싱(rebuild 시그니처 게이트).
- **X-1 — 함정 가드 데이터화**: `preToolUse-pitfallGuard.mjs` 가 `pitfall_*.md` frontmatter 의 `guard_pattern`/`guard_tool`/`guard_field`/`guard_flags`/`guard_remedy` 를 자동 로드. 코드 수정 없이 .md 추가만으로 위험 명령을 차단 가능. 핵심 2개(powershell-secret-bom, tauri-key-rotation)는 하드코딩 fallback 으로 항상 보장.
- **X-2 — soul.md 외부화**: `~/.kda/soul.md`(에이전트 자신의 정체성/가치관, K 의 lee-profile.md 와 별개)가 있으면 시스템 프롬프트 최상단에 주입. 파일 존재만으로 게이트(플래그 불필요), 없으면 종전과 동일. Claude/외부 API 경로 모두 적용.
- **X-6 — 자기수정 메모리**: `db_memory_write` MCP 도구. `~/.kda/memory/*.md` 를 append/overwrite. 경로 traversal 차단(정규식 + parent-dir 검사), overwrite 시 `.bak` 자동 백업.
- **X-4 — 자연어 Cron-lite**: `db_schedule_add/list/due/done/delete` MCP 도구. 일정을 DB 에 저장하고 도래분을 `db_schedule_due` 로 조회(백그라운드 자동 실행 없음 — 재귀/AV 위험 회피). daily/weekly/monthly recur 시 완료 시 next_run 자동 전진.
- **X-7 — 실패 자동 포착(Reflexion)**: 도구 실패/K 지적 시 원인·회피책을 정리해 pitfall 기록을 제안하는 가이던스(자동 기록 금지, 승인 후에만).
- **X-9 — 스킬 레지스트리 import + 5겹 검증**: `db_skill_scan`/`db_skill_import` MCP 도구. ①소스 신뢰 ②정적 스캔(frontmatter 화이트리스트 + 위험 패턴 + allowed-tools 거부목록) ③에이전트 의미 검토 ④K 승인(번호 텍스트) ⑤provenance(sha256/source/date/verdict) + 재import 시 해시 diff. BLOCK 판정은 승인해도 설치 거부, 위험 권한은 설치 시 자동 제거. 네트워크 fetch 는 에이전트 web 도구가 담당(MCP 는 네트워크-free 유지).
- **Phase 109 — 턴경계 self-nudge**: 작업 미완 시 다음 행동을 한 줄로 스스로 제안(자동 실행 X, 제안만).

### Changed
- 모든 자동화 신규 동작은 기존 권한/토글 모델을 그대로 따르며 기본 안전값 유지. SYSTEM_PROMPT 에 `db_convo_search` 사용 안내 추가.
- **실험 기능 토글**: Phase 109/X-4/X-6/X-7/X-9 는 `~/.kda/agent-flags.json`(nudge/failureCapture/memoryWrite/schedule/skillRegistry, 전부 기본 false)로 게이트. 플래그 OFF 면 해당 MCP 도구가 `--disallowed-tools` 에 박히고 가이던스도 미주입 → 종전 동작과 100% 동일(zero-regression).

### Tests
- `sidecar/test-hook-pitfallGuard.mjs` 추가(8 케이스: fallback/동적 로드/비활성/잘못된 정규식 무시), check.ps1 게이트에 편입.
- K-Personal-MCP `test_phase_x.py` 추가(21 케이스: X-6 생성/append/.bak/traversal 차단, X-4 등록/거부/도래/전진/삭제, X-9 PASS/BLOCK/WARN/승인게이트/provenance/위험권한제거).

---

## [0.6.53] - 2026-05-30

### Added
- Added Settings toggles for long-task auto-resume and "continue until manual Stop".

### Changed
- Auto-resume now respects the Settings toggle and suppresses retries after the user presses hard Stop until the next user message starts a new turn.
- The previous three-attempt auto-resume cap now applies only when "continue until manual Stop" is disabled.

---

## [0.6.51] - 2026-05-29

### Fixed
- Hardened sidecar broken stdout pipe recovery: EPIPE/ERR_STREAM_DESTROYED now exits the Node sidecar so the Tauri parent can respawn it.
- Added startup timeout guard for cases where the sidecar never emits its first stdout event after spawn.
- Extended preflight markers so missing EPIPE/startup-timeout guards fail before release.

---

## [0.6.50] - 2026-05-29

### 추가
- sidecar heartbeat 이벤트와 Rust watchdog을 추가해 stdout/LLM stream 정지 시 sidecar를 자동 kill/respawn하도록 보강.

### 변경
- 릴리즈 기준을 원격 최신 v0.6.49 다음 버전인 v0.6.50으로 고정.

---

## [0.1.0] - 2025-01-XX

### 추가
- 기본 채팅 인터페이스
- Claude Agent SDK 통합 (대화 재개 지원)
- MCP 서버 연동 (k-personal)
- 대화 백업/복원 (JSON)
- 컨텍스트 압축 기능
- 다중 AI 프로바이더 설정 (Claude, GPT, Gemini)
- 에이전트 권한 토글 (자동/확인/수동)
- 6가지 UI 테마
- 한국어 UI

### 기술 스택
- Tauri 2.0 + React + TypeScript
- SQLite (대화 저장)
- Node.js Sidecar (Claude Agent SDK)

---
