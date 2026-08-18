# Changelog

모든 주요 변경사항을 여기에 기록합니다.
형식: [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/)

## [Unreleased]

## [0.7.22] - 2026-08-18

### Fixed
- **자동 주입 turn 이 폴더 프로젝트 지침(권한 경계)을 통째로 못 받던 결함**: 폴더 지침(`folderSystemPrompt`)·프로젝트 프로필·폴더 첨부 결정 로직이 `handleSendMessage` 안에만 인라인으로 있었다. 그래서 **사람이 직접 입력한 turn 만** 지침을 받았고, 자동 주입 4경로(task-watch·텔레그램·예약/remote trigger·resume 재시도)는 지침 없이 실행됐다 — 에러도 경고도 없이 조용히. 실제 피해(2026-08-18, cae-automation): task-watch 로 주입한 실행자 turn 이 폴더의 권한 경계(수정 금지 경로, git 금지 목록, 판정 권한 없음)를 못 받아 그 turn 이 무권한 상태로 굴러갔다. 회피책은 "프롬프트에 경계를 손으로 매번 동봉" 이었고 한 번만 빠뜨려도 재발하는 구조였다. 이제 결정 로직을 DOM/React/Tauri/DB 비의존 순수 모듈 `src/folderContext.ts` 한 곳으로 모으고, 5개 send 경로가 전부 `buildFolderContext(convId)` 를 거치게 배선했다. 지침과 프로필은 **경로를 가리지 않고 매 turn** 실린다.
- **주입 turn 이 화면에 없는 대화를 겨냥해도 지침을 찾는다**: 폴더 상태를 in-memory `conversations` state 가 아니라 DB(`getConversationFolderState`)에서 읽는다. 자동 주입은 열려 있지 않은 대화로도 나가므로 state 조회로는 폴더를 못 찾는 경우가 있었다.
- **지침 로드 실패가 turn 자체를 죽이지 않는다**: 폴더/DB 조회가 어떤 이유로 실패해도 빈 컨텍스트로 폴백하고 turn 은 계속 나간다(경고 로그만). 첨부는 파일 읽기라 비용·실패 위험이 있어, sentinel 을 갱신할 수 없는 자동 주입 경로는 지침만 싣고 첨부는 싣지 않는다(토큰 절약, 기존 동작 보존).

### Changed
- task-watch FIRE 로그에 `folderInstructions=yes|no` 를 기록한다. 같은 결함이 재발하면 증상이 아니라 로그 한 줄로 즉시 판별된다.

### Tests
- `sidecar/test-folder-instructions.mjs` 추가 (48 assertions). 정적 배선 검사에 더해 **행위 테스트**(`sidecar/folderContextBehavior.mjs`, 21 assertions)를 spawn 해 `src/folderContext.ts` 를 실제 import 하고, 사고를 그대로 재현한 픽스처(지침 안에 권한 경계 문구)로 **첨부 비허용(=자동 주입) 옵션에서도 권한 경계가 실리는지**를 확인한다. 5개 send 경로 개별 확인, `getFolderById` 인라인 재유입 감시, `[A0]` 로더 런타임 비의존 잠금(node 20 CI 대응)을 포함한다. 실제로 task-watch 경로에서 `folderSystemPrompt` 한 줄을 빼는 뮤테이션으로 ❌ 가 뜨는 것을 확인했다(47/48).

## [0.7.21] - 2026-08-18

### Added
- **대화별 엔진(provider) 고정 — Claude 와 Codex 동시 사용**: 종전엔 provider 가 전역 토글(`localStorage.kda_active_provider`) 하나뿐이라 "대화 A 는 Claude, 대화 B 는 Codex" 가 원천적으로 불가능했다. 동시에 두 대화를 돌리려면 매 turn 마다 토글을 바꿔야 했고, 텔레그램·예약·task-watch 처럼 **사람이 없는 시점에 나가는 turn** 은 "그 순간 전역에 켜져 있던" 엔진으로 실행되는 오배송이 났다. 이제 `conversations` 테이블에 `provider`/`model` 컬럼을 두고, 대화 목록의 컨텍스트 메뉴 `🤖 엔진: …` 에서 대화별로 엔진을 고정한다. **NULL 은 "전역 따름"** 으로 기존 동작을 100% 보존하며, 고정된 대화에만 배지가 표시돼 폴백 상태가 눈에 보인다. 결정 로직은 DOM/React 비의존 순수 모듈 `src/providerResolve.ts` 한 곳으로 모아, 5개 send 경로(직접 입력·텔레그램·예약·task-watch·resume 재시도)가 전부 `buildSendSettings(convId)` 를 거치게 배선했다. 확정 provider 와 전역 provider 가 다르면 전역 model 을 상속하지 않는다(Claude 모델명이 Codex turn 에 실려 죽는 것을 차단). API 키도 전역이 아니라 **확정된 provider** 기준으로 읽는다.

### Fixed
- **provider 별 세션 id 분리 (`agent_id` 혼선)**: 세션 id 가 `conversations.agent_id` 한 칸에 저장돼, 한 대화를 Claude 로 쓰다 Codex 로 바꾸면 Claude session id 가 Codex resume 에 그대로 넘어가 고아 thread 크래시로 이어졌다. `agent_id_claude`/`agent_id_codex`/`agent_id_gemini` 컬럼을 추가하고, 레거시 `agent_id` 는 **claude 일 때만** 폴백으로 읽는다(마이그레이션 무손실). sidecar 의 done 이벤트는 provider 를 싣지 않으므로 프론트에 `turnProviderMap`(turn id → provider) 을 둬 어느 엔진이 만든 세션인지 확정한 뒤 저장한다.
- **`resume_session_missing` 회복이 백그라운드 turn 에도 적용**: 종전엔 활성 대화가 아니면 에러 핸들러가 조기 return 해, 텔레그램·예약·task-watch 대화는 세션이 깨져도 영원히 자가회복하지 못했다. 이제 회복(해당 provider 컬럼만 NULL 로 비움)이 조기 return 보다 먼저 실행된다.
- **task-watch 오배송 가드 (W3)**: 마커의 `conversationId` 가 지정한 대화의 provider 로 turn 이 나가도록 잠갔다. 라우팅은 이미 대화별이었는데 provider 만 전역이던 불일치를 닫은 것.

### Tests
- **행위 테스트를 런타임 비의존으로 (CI 전용 실패 근본 수정)**: 행위 테스트가 `src/providerResolve.ts` 를 정적 import 했는데, TS 직접 import(타입 스트리핑)는 Node ≥22.6 에만 있다. 로컬(22.x)은 59/59 통과인데 CI(Node 20.18)에선 이 테스트만 죽어 36/37 이 되고 릴리스가 게이트에서 차단됐다. 이제 로더가 2단계다 — ①타입 스트리핑을 지원하면 `.ts` 를 그대로 import, ②미지원 런타임이면 `typescript` 로 transpile 후 import. 어느 쪽이든 검사 대상은 원본 `.ts` 하나뿐이라 사본이 생기지 않으며, Node 20/22 양쪽에서 행위 22개가 **실제로 실행**된다(SKIP 아님). `[A0]` 잠금 검사가 이 폴백 제거와 정적 import 재유입을 차단한다.
- `sidecar/test-conversation-provider.mjs` 추가 (61 assertions). 정적 배선 검사뿐 아니라 **행위 테스트**를 포함한다 — `providerResolveBehavior.mjs` 를 `node --experimental-strip-types` 로 spawn 해 `src/providerResolve.ts` 를 실제 import 하고, **전역 provider 를 대화별 값과 정반대로 세팅한 상태**에서 대화별 값이 이기는지 확인한다(둘이 같으면 no-op 테스트가 되므로). 인자 없는 `buildSendSettings()` 호출 0건, send 경로별 개별 확인, 전역 localStorage 직접 읽기 재유입 감시로 "한 경로만 조용히 전역으로 되돌아가는" 회귀를 잠근다.
## [0.7.20] - 2026-07-27

### Added
- **Claude Opus 5 모델 선택 추가**: 신규 공개된 Opus 5 를 KDA 에이전트 모델로 선택 가능하게 했다. 모델 slug `claude-opus-5` 는 추측하지 않고 실제 Claude Code CLI 호출(`claude --model claude-opus-5 -p` → OK/EXIT 0)로 유효성을 검증했다(`codex_gpt56_model_slug_cli_version` 함정 회피). Claude(Max OAuth) provider 와 Claude API(직접) provider 양쪽 model picker 최상단에 추가하고, context 미터 분모(1M)·상태바 표시명("Opus 5")도 함께 반영. sidecar 는 `--model` 로 값을 그대로 전달(화이트리스트 없음)하므로 별도 변경 불필요. 기본 선택 모델은 기존(Fable 5) 유지 — K 가 Settings 에서 직접 선택.

## [0.7.19] - 2026-07-21

### Fixed
- **task-watch 완료 전달 보장 근본 수정**: v0.7.18은 `KDA_CONVERSATION_ID`를 Claude CLI에만 주입해 Codex/Gemini가 만든 마커는 대상 대화 ID가 비었고, 완료 마커를 turn 주입 전에 삭제해 전송·DB 저장 실패 시 복구할 수 없었다. 이제 conversation ID를 Claude/Codex/Gemini 세 CLI 모두에 전달한다. 발화 마커는 주입 전 durable claim으로 소유권을 기록하고, 사용자 메시지와 최종 assistant 응답이 DB에 저장된 뒤 일치하는 turn만 ACK 삭제한다. 실패는 30초부터 최대 8분까지 exponential backoff로 재시도하며, 앱 중단으로 남은 claim은 10분 뒤 회수한다. 마커의 최초 라우팅 대화 ID도 claim에 보존해 자동 후속 턴에서 다른 대화로 바뀌지 않는다.
- **존재하지 않는 대화 ID 검증 수정**: `getMessages()`는 없는 대화에도 빈 배열을 반환하므로 기존 검사가 모든 ID를 유효하다고 오판했다. 실제 conversations row를 확인하는 `getConversationMetrics()` 기반 검증으로 교체했다.

### Tests
- task-watch wiring 회귀를 35개 불변식으로 확장하고, 실제 `claim → release/backoff → reclaim → ACK` 파일 상태 전이 Rust 테스트를 추가했다.

## [0.7.18] - 2026-07-20

### Fixed
- **task-watch 완료 turn 오배송 수정 (`taskwatch_no_conversationid_misroute`)**: v0.7.17 의 task-watch 가 장기작업 완료 시 turn 을 항상 전용 `⏳ 작업감시` conv 로만 떨궈, 작업을 시작했던 원래 대화창으로 돌아오지 않았다. 감지→발화→주입→완료 메커니즘은 정상이었고(로그 FIRE→DONE 확인), 원인은 설계 갭이었다 — `claude -p` 에이전트는 자기 KDA conversationId 를 알 방법이 없어(turn 요청에 conv id 필드가 없고 conv id 는 프론트에만 존재) 마커의 `conversationId` 를 항상 생략 → 항상 ⏳ 폴백. 이제 프론트가 아는 conversationId 를 turn 파이프라인(App.tsx `send_message` invoke → Rust `send_message` `conversation_id` 파라미터 → sidecar payload)으로 흘려 claude 프로세스에 `KDA_CONVERSATION_ID` env 로 노출한다. 에이전트가 마커에 그 값을 넣으면 완료 turn 이 **원래 대화창으로 정확히 라우팅**된다. conversationId 없는 구형 마커는 여전히 ⏳ 폴백(하위호환). 회귀테스트 `test-task-watch.mjs` 에 라우팅 체인 불변식 5건 추가.

## [0.7.17] - 2026-07-20

### Added
- **장기 분리작업 완료 자동 이어가기 — task-watch (전 대화창 공통)**: KDA 는 Claude 를 `claude -p`(단발성)로 spawn 하므로 에이전트가 턴 안에서 띄운 감시자가 세션 경계에서 죽어(`background_killed_on_session_boundary`), "빌드·OCR 같은 장기 분리작업이 끝나면 에이전트가 혼자 이어가기"가 신뢰성 있게 안 됐다. 이를 조건 기반 하트비트로 해결 — 스케줄러 하트비트(X-4, 시간 기반)의 조건 기반 쌍둥이. 에이전트가 `~/.kda/task-watch/<id>.json` 마커(감시 대상 `.done` 파일 또는 PID, `timeoutMs` 안전망, 깨울 때 주입할 `prompt`, 대상 `conversationId`)를 남기고 턴을 끝내면, KDA 상주 프로세스가 `claude -p` 프로세스와 무관하게 20초 주기로 폴링해 조건 충족 시 해당 대화창에 새 턴을 자동 주입해 에이전트를 깨운다. Rust `task_watch_scan`/`task_watch_clear`/`task_watch_log`(PID 생존은 `OpenProcess`+`WaitForSingleObject`, ISO→epoch 파서는 외부 크레이트 없이 구현), 프론트 하트비트는 마커 삭제→주입 순서로 재발화 폭주를 막고 `taskWatchTurnsRef`/`taskWatchTickBusyRef` 로 동시 1턴·틱 중첩을 차단한다. SYSTEM_PROMPT 에 등록법을 심어 전 대화창에서 사용 가능. 회귀테스트 `sidecar/test-task-watch.mjs` 추가.

## [0.7.16] - 2026-07-10

### Added
- **스트림 끊김/401 자동 회복 (Phase 143)**: 2026-07-10 K 실사고 — 긴 turn 도중 "Reconnecting... 5/5 (stream disconnected before completion: websocket closed by server before response.completed)" 로 turn 이 통째 유실되고 직후 "Failed to authenticate. API Error: 401" 이 여러 turn 연쇄. Claude/Codex CLI 경로 공통으로 stderr 에서 두 패턴을 감지해 **같은 세션 그대로 1회 자동 재시도** (스트림 끊김 3초 / 401 5초 대기 — 토큰 갱신 여유). 구 Phase 61 의 blocklist 방식(멀쩡한 세션까지 영구 차단, v0.7.0 에서 비활성)과 달리 세션을 차단하지 않아 대화 맥락이 그대로 유지된다. 재시도 후에도 401 이면 raw 에러 dump 대신 `codex login`/`claude /login` 재로그인 안내로 변환해 표시. `_streamRetried`/`_authRetried` 가드로 무한 재귀 방지, 재시도 턴은 long_task 중복 등록 안 함. 회귀테스트 `test-stream-auth-retry.mjs` (실사고 문자열 + 오탐 방지 + 구조 불변식 15건) 추가.

## [0.7.15] - 2026-07-10

### Added
- OpenAI GPT-5.6 model picker support: `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.
- Codex model picker support for the GPT-5.6 family.

### Changed
- OpenAI REST default model updated to `gpt-5.6`.
- Context meter fallback updated for GPT-5.6's 1.05M context window.

## [0.7.14] - 2026-06-29

### Added
- **검색증강 함정 주입 (`memory_injection_cap_dilutes_pitfall_recall` 근본 수정)**: 누적 메모리의 `pitfall_*.md` 본문 전체를 32KB cap 에 욱여넣다 대부분 잘려 회피책이 LLM 에 도달하지 못하던 문제(기록이 늘수록 회상이 약해지는 역설)를 구조적으로 해결. 매 턴 메시지와 관련된 함정만 trigger/태그/한글 토큰 매칭으로 골라 상위 N개(기본 8개) 본문 전체를 우선순위 주입한다(`buildTriggeredPitfallEntries`). 나머지는 기존대로 한 줄 요약. 한국어 메시지가 영어 슬러그와 매칭되지 않던 간극도 `extractHangulTokens` 로 description/triggers 의 한글 토큰을 대조해 메움. 함정 개수가 늘어도 회상 품질이 희석되지 않는 구조.

### Fixed
- **고아 claude 프로세스 누적 차단 (`kda_claude_subagent_tree_orphan_happy_path` 근본 수정)**: per-turn 종료 경로엔 이미 tree-kill 이 있었으나, sidecar(node.exe) 자체가 reload·기동타임아웃·heartbeat타임아웃·앱종료(`RunEvent::Exit`)·broken stdout pipe 로 죽을 때는 node.exe 만 죽고 손자 claude.exe 들이 고아로 남아 호스트 메모리가 단조 증가했다. Rust 4개 사이트에서 `SIDECAR_PID` 기반 `taskkill /F /T` 트리킬을 추가하고, sidecar 에 `reapActiveTurns()` 셀프-리퍼(broken pipe·SIGTERM/SIGINT/SIGHUP·process exit)를 더해 어느 경로로 sidecar 가 죽든 claude 손자가 함께 회수되도록 했다. 주기적 청소(KDA-MemReaper) 없이 고아가 구조적으로 불가능.

## [0.7.12] - 2026-06-11

### Added
- Windows system memory watchdog using `GlobalMemoryStatusEx`, exposed through the Tauri command `get_system_memory_status`.

### Fixed
- Block new turns immediately when system memory is at or above 92%, including while another stream is active, so queued input is not silently dropped later.
- Clear all stale streaming conversation state after a 12-minute no-event stall or 95% critical memory recovery, preventing other conversations from staying permanently locked as "responding".
- Harden Hard Stop cleanup when a turn-to-conversation map entry is missing by falling back to the active conversation before clearing streaming state.

## [0.7.11] - 2026-06-10

### Added
- **사이드바 대량 정리 (Phase 140)**: 기존 대화 여러 개를 선택해 한 번에 폴더로 이동할 수 있는 `대량 정리` 모드를 추가. 보이는 항목 전체 선택/해제와 기존 폴더 피커 기반 일괄 이동을 지원하고, 단일 우클릭 이동도 같은 다중 이동 경로를 재사용한다.

## [0.7.10] - 2026-06-10

### Added
- **대화별 프로젝트 모드 (#3, Phase 138)**: 폴더(프로젝트)마다 "프로젝트 프로필"을 붙여 스코프를 격리한다 — 금지 도구, 메모리 범위 태그, 기본 작업 경로, 프로젝트 이름. `설정 → 실험 기능 → 프로젝트 모드(#3)` 토글이 ON일 때만 작동(기본 OFF = 종전 동작 100% 동일, zero-regression). ① 금지 도구는 해당 대화에서만 Claude/REST `--disallowed-tools`로 하드 차단(Codex/Gemini는 시스템 텍스트로 명시 금지) ② 메모리는 `memory/*.md`의 `projects:` frontmatter와 교집합 있는 파일 + 공용(태그 없는) 파일만 로딩하고 타 프로젝트 메모리는 stub 처리 ③ 이름/경로는 `[프로젝트 모드]` 블록으로 시스템 텍스트에 주입. `workproject_bleeds_into_kda_core`(회사 작업이 KDA 코어로 새어 릴리스에 동봉된 v0.7.7 사건)를 사람 주의력이 아니라 시스템으로 차단. 배선: FolderInstructionsDialog → db(`project_profile_json` 마이그레이션) → App → Rust → sidecar.
- **릴리스 전 자동 게이트 (#8, Phase 139)**: `npm run release:gate` (빌드 생략 `release:gate:fast`)로 릴리스 직전 6단계를 한 번에 강제 — ① 버전 파일 동기화(기존 `release-version-guard` 재사용) ② webview2 캐시 stale 방지 메타 ③ 금지 의존성/삭제 기능(pdf2json·pdfText 등) 재유입 차단 ④ `sidecar/test-*.mjs` 회귀테스트 일괄 실행+집계 ⑤ CHANGELOG 현재 버전 엔트리 ⑥ sidecar tsc/frontend build/cargo check. CI(release.yml)도 빌드 전 fast 게이트를 돌린다. v0.7.7~0.7.9 세 번 연속 릴리스 사고(package-lock 불일치·secret BOM·webview 캐시 stale·PDF 재유입)가 전부 "사람이 체크리스트를 까먹어서"였던 것을 스크립트로 박았다.

## [0.7.9] - 2026-06-10

### Added
- **Gemini CLI 서드 엔진 + 구독 OAuth 내장 로그인 (Phase 134+135)**: provider `gemini-cli` 추가 (v1 stateless — 매 턴 bootstrap history 재주입). Settings → Gemini CLI 카드의 [🔑 Google 계정으로 로그인] 버튼으로 API 키 없이 구독 OAuth 인증 — 사이드카가 Google installed-app OAuth 플로우(loopback 서버 + 시스템 브라우저 + state CSRF 검증)를 직접 수행해 `~/.gemini/oauth_creds.json` 캐시를 생성한다 (Gemini CLI 에 `login` 서브커맨드가 없어 자체 구현). 인증 체인: API 키 → OAuth 캐시 → spawn 전 fail-fast 안내. Gemini REST provider 도 현행 모델로 갱신.
- **멀티 에이전트 오케스트레이션 v1 (Phase 137)**: Settings → "🤝 멀티 엔진 오케스트레이션" 토글 ON + 엔진 2개 이상(Claude/GPT(Codex)/Gemini) 선택 시, 매 메시지를 모든 엔진에 병렬 질의(fan-out)하고 메인 엔진(Claude 우선)이 답변들을 비교·종합(fan-in)해 최종 답변을 만든다. 엔진별 의견이 별도 카드로 스트리밍되고 종합이 마지막에 표시. sub-turn 은 `{turnId}#{engine}` id 로 격리 + 도구 호출 금지(동시 도구 충돌 방지) + 5분 타임아웃 + partial fan-in (일부 실패해도 성공한 답변만으로 종합). interrupt 시 모든 sub-turn process tree-kill. 기본 OFF — 명시적 opt-in.

### Fixed
- **GPT(Codex)/Gemini 모델이 KDA·헤르메스 룰을 안 따르던 근본 원인 (Phase 136)**: v0.7.0 헤르메스 기능(soul.md 정체성, 실험 기능 가이던스, agent-flags 도구 게이트)과 KDA 기본 응답 규칙(SYSTEM_PROMPT — 한국어/번호 선택지/파괴작업 확인)이 전부 Claude 경로의 `--system-prompt`/`--disallowed-tools`/hook 에만 배선돼 있었다. Codex CLI / Gemini CLI 는 해당 인자가 없어 시스템 지침을 한 글자도 못 받았고(메모리 블록만 수신, Codex resume 턴은 그조차 누락), flag OFF 도구도 게이트 없이 노출됐다. 수정: `buildEngineSystemText()` 가 동일 구성 요소를 stdin 프롬프트 최상단 `<kda_system>` 블록으로 주입 (Codex resume 턴은 context 보호를 위해 compact 리마인더만). REST 경로는 featureGuidance 주입 + flag OFF 도구를 카탈로그에서 하드 제거.

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
