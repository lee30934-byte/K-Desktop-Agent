# KDA 고도화 로드맵 — Phase 149 ~ 157

작성 2026-09-23. K 승인: 스코프 **3 (전부)**, "추천한대로 진행".
근거 조사: Claude Code 확장 스택 / MCP 2026-07-28 스펙 / 에이전트 메모리 연구 / 앰비언트 에이전트 /
관측·평가 / 로컬 음성 / 자기개선 에이전트. (세부 출처는 각 Phase 하단)

## 0. 전제 — 작업 트리

**활성 트리 = `C:\Users\user\Documents\K-Desktop-Agent\evidence\webview2-integration-20260911`**
(브랜치 `feat/chatgpt-web-provider-v0.7.35`, HEAD == 태그 `v0.7.35`, package.json 0.7.36)

바깥 `C:\Users\user\Documents\K-Desktop-Agent` 는 `work/conversation-control-20260910` (0.7.21, 2026-09-10)
로 **릴리즈에 미포함된 stale 사이드 브랜치**다. 판정 근거와 재현 절차는
`pitfall_kda_active_tree_is_nested_clone_20260923.md` 참조.

> ⚠ 미결: 활성 트리가 `evidence/`(untracked 스크래치 디렉터리) 하위에 있는 것은 구조적 사고 위험이다.
> 이전 방식 = 정리 대상. K 결정 필요 (아래 "미결 결정" 참조).

## 1. 현재 상태 실측 (Phase 149 근거)

| 항목 | 실측값 | 측정 방법 |
|---|---|---|
| `~/.kda/memory/*.md` 파일 수 | **634** | `ls -1 ~/.kda/memory/*.md \| wc -l` |
| 메모리 디렉터리 총 용량 | **5.7 MB** | `du -sh ~/.kda/memory` |
| 턴당 주입 상한 | **40 KB** (`MEMORY_CONTEXT_HARD_CAP_BYTES`) | `sidecar/src/index.ts:1027` |
| 실제 주입 비율 | **≈ 0.7 %** | 40KB / 5.7MB |
| 관측된 drop | 턴마다 **84 ~ 90 섹션** | `[ℹ N개 메모리 섹션이 cap 초과로 생략됨]` |

### 기존 선택 로직의 한계 (index.ts:1766~1797)
- Phase 106 의 frontmatter `triggers:` 가 있는 파일만 관련도 취급 → **`MEMORY_PRIORITY_TRIGGERED`**.
- Phase 147 이 TRIGGERED 예산 하한(`MEMORY_TRIGGERED_RESERVE_MAX`)을 추가.
- **그러나 634개 중 대다수는 frontmatter 가 없다.** 이들은 "항상 full body" 그룹에 들어가
  `priority asc` greedy 로 채워지고, 같은 priority 안에서는 **현재 작업과 무관한 순서**로 잘린다.
- 결과: 잘려나가는 84~90개가 "지금 필요한 것"인지 아닌지가 **우연에 달려 있다.**
  → 기존 함정 `memory_injection_cap_dilutes_pitfall_recall` 이 구조적으로 재발 중.

**핵심 진단: cap 이 문제가 아니라 "cap 안에 무엇을 넣을지 고르는 기준"이 없는 게 문제다.**

---

## Phase 149 — 메모리 검색형 전환 (relevance-ranked injection) ★ 최우선

### 목표
전량 덤프 → **현재 턴과 관련된 것만** 주입. cap 은 유지하되 그 40KB 를 관련도로 채운다.

### 설계
1. **인덱서** `sidecar/src/memoryIndex.ts` (신규) — **신규 런타임 의존성 0**
   - `~/.kda/memory/*.md` + `team-memory/` 를 스캔, `mtime+size` 기반 증분 갱신.
   - ⚠ **sqlite 를 쓰지 않는다.** 실측: `sidecar/package.json` 의 dependencies 는
     `@anthropic-ai/claude-agent-sdk`, `tree-kill` 뿐 — sqlite 계열 **없음**.
     `better-sqlite3` 는 네이티브 모듈이라 Tauri 번들링 + 백신 차단 위험
     (`av_blocks_bundled_native_binary`)을 새로 끌어들인다. 채택 안 함.
   - 저장소: **순수 TS 인메모리 인덱스 + `~/.kda/memory-index.json` 캐시**.
     대상이 634 파일 / 5.7MB 라 메모리 부담이 없고, 콜드 스타트는 mtime 비교로 증분.
   - 레코드: `file, type(pitfall|feedback|skill|profile|team), title, body, tokens, mtime, hash`.
2. **스코어링** — 외부 임베딩 API 의존 없이 시작 (오프라인·무비용·결정적):
   - `BM25(query, body)` — **직접 구현** (토크나이저는 한글/영문 혼용 대응: 공백+슬러그 분해).
   - `+ 파일명/슬러그 정확매칭 가산점` (예: 메시지에 `powershell` → `pitfall_powershell_*`).
   - `+ 최근성 가산점` (mtime 신선도, 로그 스케일).
   - `+ 직전 N턴 도구호출 이름`을 쿼리에 합류 (도구 실패 함정 회상률이 여기서 결정된다).
   - 쿼리 = 현재 사용자 메시지 + 활성 프로젝트 태그 + 최근 도구명.
3. **주입 예산 배분** (40KB 유지):
   - FIXED: `lee-profile` + pitfall **인덱스**(슬러그 목록) — 기존과 동일, drop 불가.
   - RELEVANT: top-k 본문 — 예산의 **60%**.
   - ALWAYS: `always: true` / 무조건 로딩 지정 파일 — 25%.
   - RECENT: 최근 7일 내 새로 기록된 pitfall/feedback — 15% (방금 배운 걸 잊지 않게).
4. **음성 대조 게이트** (공허한 테스트 금지 — `vacuous_gates_and_substring_state_checks` 회피):
   - 골든셋: 과거 턴에서 "이 함정을 봤어야 했다"가 명확한 케이스 20건을 수기 라벨링.
   - 측정: **recall@40KB**. 현행 로직 baseline vs 신규 로직.
   - **통과 기준: 신규 ≥ baseline + 0.30, 그리고 baseline 로직으로 되돌리면 테스트가 실제로 실패할 것.**
   - 테스트: `sidecar/test-memory-relevance.mjs`.

### 산출물
- `sidecar/src/memoryIndex.ts`, `index.ts` 의 `loadMemoryContext` 개편
- `sidecar/test-memory-relevance.mjs` (골든셋 + 음성 대조)
- Settings 에 "메모리 주입 진단" 패널 (이번 턴에 뭐가 들어갔고 뭐가 밀렸는지 가시화)

### 근거
- [State of AI Agent Memory 2026 — mem0](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [Memanto: Typed Semantic Memory (arXiv 2604.22085)](https://arxiv.org/pdf/2604.22085) — 그래프 없이 벡터+타이핑만으로 SOTA
- 융합 검색(semantic+BM25+entity): temporal +29.6p, multi-hop +23.1p

> 주: 1단계는 **BM25+휴리스틱**으로 간다(무비용·결정적·게이트 가능).
> 임베딩은 recall 이 정체될 때 2단계로 추가 — 측정 없이 벡터부터 넣지 않는다.

---

## Phase 150 — Context editing + 선제 compaction + 체크포인트

- 자동 **tool-result clearing**: 오래된 대용량 도구 결과를 요약본으로 치환.
- **선제 compaction**: 단순 워크로드 5~20k / 복잡 50~100k 토큰 시점 발동 (꽉 찬 뒤 X).
- compaction 시 **git commit 체크포인트 + `PROGRESS.md`**(완료/진행중/막힘) 동시 기록
  → `compaction_summary_stale_state_caused_duplicate_upload` 재발 차단.
- 근거: [Anthropic — Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  (context editing 단독 +29%, memory tool 병용 +39%, 100턴 eval 토큰 −84%)

## Phase 151 — 엔진 무관 Hook 레이어

- 현재 pitfall 가드는 Claude `preToolUse` hook 전용. Codex/Gemini 는 **프롬프트 부탁** 수준(Phase 136).
- sidecar 레벨 결정적 훅으로 이전: `PreToolUse`(금지 경로 쓰기 차단) / `PostToolUse` /
  `Stop`(테스트 실행) / 모든 셸 명령 **secret redaction**.
- 프로젝트 규칙의 "금지 경로"(★업무★, PycharmProjects, SIGILFALL, .env)를 **코드로 강제**.
- `partial_env_redaction_leaks_prefixed_secrets` 를 훅으로 봉합.

## Phase 152 — MCP 2026-07-28 스펙 대응

- **Tasks 확장** — durable 핸들. 자작 `task-watch`(.done 폴링) 의 표준 대체.
  `taskwatch_*` 함정 8건이 전부 자작 프로토콜 취약점이었다.
- **Elicitation** — 구조화 질문 공식 경로. `ask_user_question_noninteractive_cli_race` 정공법.
- **MCP Apps** — 샌드박스 iframe UI. diff 승인 / 릴리즈 게이트 대시보드를 채팅 안에서.
- 부수: stateless core, `ttlMs`/`cacheScope` 캐시 → k-personal 도구목록 재조회 비용 감소.
- 근거: [MCP 2026-07-28 Specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

## Phase 153 — 관측 / 평가 (pitfall 을 회귀 케이스로)

- OTel **GenAI semantic conventions** 로 턴 계측 (버전 핀 필수 — 아직 Development 상태).
- 턴 trace 뷰어 + 리플레이.
- **pitfall 536개 → 자동 회귀 eval**. 릴리즈 게이트에서 "이 함정을 다시 밟았는가" 채점.
- 근거: [Agent observability 2026 — Braintrust](https://www.braintrust.dev/articles/agent-observability-complete-guide-2026)

## Phase 154 — 앰비언트 트리거 + Agent Inbox

- 현 트리거는 시간(스케줄) + 파일/PID(task-watch) 뿐. 이벤트 스트림 어댑터 추가
  (파일 변경 / 웹훅 / git push / 텔레그램).
- **Agent Inbox** — 에이전트가 승인 대기 항목을 쌓고 K 가 일괄 처리.
- 근거: [LangChain — Introducing ambient agents](https://www.langchain.com/blog/introducing-ambient-agents)

## Phase 155 — 스킬/메모리 정리·측정 + 서브에이전트 요약 계약

- pitfall → **실행 가능한 게이트/테스트로 승격** (SkillForge 패턴).
- 동시에 **skill rot 측정**: 스킬이 오히려 성능을 떨어뜨리는 케이스 A/B. 폐기·병합 루틴.
  (536개는 이미 위험구간 — "많을수록 좋다"는 반증됐다.)
- 서브에이전트 반환 **1,000~2,000 토큰 증류 요약 계약** (현행 8KB 캡은 자르기일 뿐 증류가 아님).
- 근거: [Your Agent Skill Library Is Quietly Rotting](https://lowpassfilter.substack.com/p/your-agent-skill-library-is-quietly),
  [SkillForge (arXiv 2604.08618)](https://arxiv.org/pdf/2604.08618)

## Phase 156 — 로컬 음성 I/O

- faster-whisper(STT) + Piper(TTS) + openWakeWord. 전부 오프라인·MIT.
- 미니PC(smm) 상시 웨이크워드, 무거운 STT 는 5080 WoL.
- 근거: [Local AI Voice Assistant Stack 2026](https://dev.to/kunal_d6a8fea2309e1571ee7/local-ai-voice-assistant-stack-2026-whisper-piper-ollama-wired-together-572l)

## Phase 157 — 권한 리스크 점수화 + 플러그인 호환

- 도구 × 경로 × 되돌릴 수 있는가 → 리스크 점수. 임계 이하 자동 승인, 초과 확인 + 세션 예산.
- Claude Code **plugin 포맷**(skills+hooks+subagents+MCP 번들) import, `db_skill_scan` 게이트 확장.

---

## 미결 결정 (K 승인 필요)

1. **활성 트리 위치** — `evidence/webview2-integration-20260911` 를 그대로 둘지,
   정식 경로로 옮길지(예: `C:\Users\user\Documents\KDA-active`), 아니면 바깥 repo 를
   이 브랜치로 맞출지. 디렉터리 이동/브랜치 전환이라 승인 없이 진행하지 않는다.
2. **Opus 5.5 패치(0.7.36) 커밋 여부** — 현재 활성 트리에 9개 파일 uncommitted.
   Phase 149 작업과 섞이지 않게 **먼저 커밋**하는 것을 권장.
