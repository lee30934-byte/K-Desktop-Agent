# Changelog

모든 주요 변경사항을 여기에 기록합니다.
형식: [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/)

## [0.7.0] - 2026-06-06

Hermes 에이전트 연구 성과를 KDA 에 이식한 대형 패치 — 3계층 메모리(프롬프트 선택 로딩 / 에피소드 검색 / 스킬 메모리) + 함정 가드 데이터화. 백엔드/사이드카 전용이며 프론트엔드 UI 변경은 없습니다.

### Added
- **Phase 106 — 메모리 선택 로딩 일반화**: `~/.kda/memory/*.md` frontmatter 의 `triggers`/`always`/우선순위를 해석해 현재 메시지와 관련된 메모만 프롬프트에 주입. 32KB 초과 시 우선순위가 낮은 항목부터 한 줄 요약으로 축약하고 드롭 목록을 명시. mtime 캐시로 파일 재파싱 최소화.
- **Phase 107 — 스킬 메모리**: `skill_*.md`(agentskills.io 호환 frontmatter: name/description/triggers/allowed-tools/success_count 등) 를 트리거 매칭으로 선택 로딩. 90일 미사용 후보를 Curator 가 정리 후보로 표시.
- **Phase 108 — 에피소드 검색**: `db_convo_search` MCP 도구 추가. 과거 대화를 FTS5(external-content + trigram, 한글 부분검색 지원)로 검색하고, FTS5 미가용/짧은 질의 시 LIKE 폴백. bm25 + 최근성 정렬, 멱등 재인덱싱(rebuild 시그니처 게이트).
- **X-1 — 함정 가드 데이터화**: `preToolUse-pitfallGuard.mjs` 가 `pitfall_*.md` frontmatter 의 `guard_pattern`/`guard_tool`/`guard_field`/`guard_flags`/`guard_remedy` 를 자동 로드. 코드 수정 없이 .md 추가만으로 위험 명령을 차단 가능. 핵심 2개(powershell-secret-bom, tauri-key-rotation)는 하드코딩 fallback 으로 항상 보장.

### Changed
- 모든 자동화 신규 동작은 기존 권한/토글 모델을 그대로 따르며 기본 안전값 유지. SYSTEM_PROMPT 에 `db_convo_search` 사용 안내 추가.

### Tests
- `sidecar/test-hook-pitfallGuard.mjs` 추가(8 케이스: fallback/동적 로드/비활성/잘못된 정규식 무시), check.ps1 게이트에 편입.

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
