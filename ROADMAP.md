# ROADMAP — K Desktop Agent

## 완료된 Phase

### ✅ Phase 111 — 작업 중 다른 대화창 이동 + 백그라운드 turn 진행 — 2026-06-01

**문제:** K 명시 — "작업시 다른 대화창으로 이동이 불가능한데 작업중에도 다른 대화창 이동이 가능하게 해줘 물론 작업은 그대로 진행중 상태에서". 옛 동작은 `if (isStreaming) return` 차단 5곳으로 conv 전환 / 새 대화 생성 모두 막혀있음.

**핵심 (정공법, 옵션 2b 선택):**
- **`turnToConvMap: useRef<Map<turnId, convId>>`** — send 시점에 set, done/error 시점에 delete. emit handler 들이 ev.id (turn id) 로 그 turn 의 원래 conv 를 lookup.
- **`streamingConvIds: useState<Set<convId>>`** — 어느 conv 들이 background 진행 중인지. Sidebar spinner 배지 + handleSelectConversation 의 isStreaming 동기화 source.
- **emit handler 4종 (assistant_delta / tool_use / tool_result / done / error) routing patch:**
  - `convForTurn = turnToConvMap.get(ev.id) ?? activeConvId`
  - `isActiveConv = convForTurn === activeConvId`
  - active 면 기존 setMessages / setMetrics 그대로
  - 다른 conv 면 setMessages skip (UI 안 오염), DB save 는 `queueMessageSave(msg, convForTurn)` 으로 그 turn 의 원래 conv 에 박음. done 시 사이드바 메타 refresh 만.
- **`queueMessageSave(msg, convIdOverride?)` 시그니처 확장** — `pendingSaveRef` 키를 `"convId|msgId"` 로 박아 다른 conv 의 save 가 섞이지 않음.
- **차단 5곳 제거:**
  - `handleSelectConversation` — `if (isStreaming) return` 삭제 + 전환 시 새 conv 의 `streamingConvIds.has(id)` 로 isStreaming 동기화
  - `handleNewConversation` — `if (isStreaming) return` 삭제 + setIsStreaming(false) + setCurrentTurnId(null) 동기화

**UI — 사이드바 streaming dot 배지:**
- `streamingConvIds` prop 신설 (Sidebar.tsx)
- 트리 모드 conv 제목 옆 + Explorer 모드 conv 항목 우측 끝에 **● dot** (pulse animation)
- App.css 에 `@keyframes kda-pulse` 추가

**Trade-off (의도적 v1 단순화):**
- background turn 의 partial assistant chunks 가 UI 의 in-memory cache 에 없음. K 가 그 conv 로 돌아오면 turn 완료 후 DB load 으로 봐야 함 (DB save 는 매 chunk 마다 박힘).
- background turn 의 메트릭 갱신은 active conv 일 때만. 다른 conv 의 메트릭은 다음 phase 에서 정밀화.
- done 시 setMessages 의 streaming=true → false 마킹이 다른 conv 에선 안 박혀 일시적 잔재 가능. K 가 새 turn 시작하면 자동 정리.

**검증 — npm run build (3.16s) + test-codex-integration 41/41 + test-perm-gate 11/11**. K UI 검증 잔여.

### ✅ Phase 110 — 폴더 지침 수정 시 첨부 sentinel 자동 reset — 2026-06-01

**문제:** Phase 109 까지 박은 후 검증 단계에서 K 와 함께 발견한 잠재 함정 #3. 폴더의 첨부 파일을 K 가 추가/제거해도 그 폴더 안 **기존** 대화는 lastAttachedFolderId 가 여전히 같은 폴더 ID → 다음 send 에서 skip → "지침 파일 바꿔도 옛 conv 는 옛 파일만 기억" 증상.

**핵심:**
- `db.ts::resetFolderConvAttachmentSentinel(folderId)` 신규 — `UPDATE conversations SET last_attached_folder_id = NULL WHERE folder_id = ?`. rowsAffected 반환 (로깅용).
- `App.tsx::handleSaveFolderInstructions` 가 `updateFolderInstructions` 성공 후 즉시 `resetFolderConvAttachmentSentinel` 호출 + `setConversations` 로 in-memory state 도 동기화. 다음 handleSendMessage 가 옛 값 안 봄.
- reset 실패해도 save 자체는 성공 (catch + console.warn) — 다음 dialog open 시 재시도 가능.

**Trade-off (의도적):** systemPrompt 만 수정해도 reset 됨 (정확한 diff 비교 안 함). 시스템 프롬프트는 매 turn 박혀서 무관, 첨부도 K 가 명시적으로 dialog 열어 저장 누른 직후 1회 만 박혀 토큰 비용 acceptable. 단순함 우선.

### ✅ Phase 109 — 폴더 이동 후 첨부 자동 재박힘 — 2026-06-01

**문제:** Phase 107 의 첨부 inject 가 `messages.length === 0` (새 대화 첫 message) 분기였음. 기존 대화를 폴더로 이동해도 그 폴더 첨부는 모델에게 안 박힘 — K 의 "그 폴더에 있는건 전부" 의도와 미스매치.

**핵심:**
- `conversations` 테이블에 `last_attached_folder_id TEXT` 컬럼 추가 (마이그레이션).
- `Conversation` interface 에 `lastAttachedFolderId?: string | null` 추가 + `rowToConversation` 매핑.
- 신규 함수: `updateConversationLastAttachedFolder(convId, folderId)`.
- `App.tsx::handleSendMessage` 의 attach 분기 교체:
  - 옛: `isFirstMessageInConv = messages.length === 0`
  - 새: `shouldAttach = (conv.lastAttachedFolderId ?? null) !== conv.folderId` + attachments 존재
- attach 박은 직후 `updateConversationLastAttachedFolder` + `setConversations` 동기화.

**시나리오 cover:**
| 상태 | 동작 |
|---|---|
| 새 대화 첫 send (last=null, current=X) | ✅ 박음 |
| 같은 conv 재 send (last=X, current=X) | ❌ skip (모델 history) |
| 폴더 이동 후 첫 send (last=A, current=B) | ✅ 박음 (K 명시) |
| 폴더 빼기 후 send (last=A, current=null) | ❌ skip (current 없음) |
| 폴더 다시 들어가기 (last=null, current=A) | ✅ 박음 |

**시스템 프롬프트는 그대로 매 turn 박힘** (변화 없음 — Phase 107 동작 보존).

### ✅ Phase 108 — Sidebar Explorer 모드 (Windows 탐색기 패러다임) — 2026-06-01

**문제:** K 의 트리 모드 ("폴더 펼침/접힘, 전체 한 화면") 가 폴더 위계 시각화에 약함. K 의 명시: "폴더 안인지 밖인지 구분이 잘 안 간다 + 위로가기 기능"

**핵심:**
- `Sidebar.tsx` 에 `viewMode: "tree" | "explorer"` state + localStorage 영속 (`kda_sidebar_view_mode`). 기본값 = `"tree"` (K 의 명시 — 기존 동작 보존, Explorer 는 토글로 선택).
- 상단 토글 버튼: `[🌳 트리] / [📂 탐색기]` (Sidebar actions 아래).
- **Explorer 렌더:**
  - **breadcrumb 경로** — `📁 루트 / 폴더 / ...` (각 부분 클릭하면 그 폴더로 이동, 마지막=현재 강조)
  - **↑ 위로 가기 버튼** — currentFolderId 의 parentId 로 이동 (root 면 disabled)
  - **본문** — 현재 폴더의 직계 하위 폴더 + 직계 대화만 list (들여쓰기 X). 폴더는 `📁 (이름) — 📁N 💬M` 카운트 표시.
- **상호작용:** 폴더 **더블클릭 = 진입** (K 의 명시 — Windows 탐색기 traditional). 대화 단일 클릭 = 활성화 (기존). 우클릭 메뉴는 트리/탐색기 동일 (Phase 107 의 "📜 프로젝트 지침…" 포함).
- **단축키:** Backspace = 위로 가기 (입력 필드 안에선 trigger 안 됨).
- **dangling reference 방지:** currentFolderId 가 가리키는 폴더가 사라지면 (삭제 etc.) useEffect 가 자동 reset → 루트.
- **검색 호환:** 검색 active 면 현재 폴더 무관 검색 hit 만 표시. 빈 결과면 "검색 결과 없음".
- **DnD:** Explorer v1 엔 미지원. 폴더 간 대화 이동은 우클릭 메뉴 "📁 폴더로 이동…" path. 다음 phase 후보.

### ✅ Phase 107 — 폴더 프로젝트 지침 + 첨부파일 (ChatGPT/Claude Projects 패턴) — 2026-06-01

**문제:** K 가 "공문 작성 폴더" 같은 프로젝트별로 지침과 참고 파일을 한 곳에 정리하고, 그 폴더의 새 대화는 자동으로 그 지침을 읽고 작성하도록.

**핵심:**
- **DB 마이그레이션:** `folders` 테이블에 `system_prompt TEXT` + `attachments_json TEXT` 컬럼 추가. `FolderRecord` 에 `systemPrompt`/`attachments: FolderAttachment[]` 노출. 신규 `getFolderById()` + `updateFolderInstructions()` 함수.
- **UI:** Sidebar 폴더 우클릭 메뉴에 "📜 프로젝트 지침…" 추가 → 신규 `FolderInstructionsDialog` (시스템 프롬프트 textarea + 첨부파일 picker — `tauri-plugin-dialog` 의 `open()` 으로 시스템 파일 선택).
- **App.tsx inject path:** `handleSendMessage` 진입 시 `messages.length === 0` 캡처 (이 conv 첫 message 검사). 활성 conv 의 folderId → `getFolderById()` → `folderSystemPrompt` (매 turn 박음) + `folderAttachmentPaths` (첫 message 만 박음, 토큰 절약). `invoke("send_message", { folderSystemPrompt, folderAttachmentPaths })`.
- **Rust IPC:** `lib.rs::send_message` 가 새 두 인자 받아 payload 의 `folderSystemPrompt`/`folderAttachmentPaths` 필드로 흘림.
- **sidecar inject:** `handleViaClaudeCLI` 의 `fullSystemPrompt = SYSTEM_PROMPT + folderInstructionBlock + askGuidance + manualGuidance`. 폴더 첨부는 `baseContent` 끝에 `[프로젝트 참고 파일]` 블록 + path list 박힘 → Claude CLI 의 Read 도구가 직접 읽음 (영구 파일이라 임시 폴더 복사 X — base64 첨부와 다름).
- **함정 회피:** `parseFolderAttachments` 에서 Array.isArray 양방향 방어 + filter ( `pitfall_js_arg_type_silent_throw` ).

### ✅ Phase 106 — Opus 4.8 명시 선택 + Claude CLI --model 전달 path — 2026-06-01

**문제:** Anthropic 의 Claude Opus 4.8 가 출시되어 K 가 명시적으로 4.8 모델 선택해 쓰고 싶음. 그런데 진단 결과 KDA 의 Claude (Max OAuth) provider 가 **sidecar 의 Claude CLI spawn args 에 `--model` 인자를 박지 않고 있었음** — Settings 의 model picker 가 사실상 무력화 (어떤 model 골라도 CLI 의 default 만 작동).

**핵심:**
- **Settings.tsx claude provider models 확장** — `default` 외에 `claude-opus-4-8` 옵션 추가 (Max OAuth provider 에만 — K 명시).
- **sidecar Claude CLI args 에 `--model` 전달 path 박음** — `msg.model && msg.model !== "default"` 면 `args.push("--model", msg.model)`. Claude CLI 가 alias (`opus`, `sonnet`) 또는 full ID (`claude-opus-4-8`) 둘 다 받음 (`claude --help` 로 확인). 종전 picker 무력화의 root cause fix.
- **분모 hardcode 의도적으로 건드리지 않음** — `currentModelMaxTokensInfo` 의 `id.includes("claude") → 200K` fallback 그대로 유지. K 의 실제 한도와 안 맞으면 추후 별도 patch (pitfall_codex_model_context_window_dynamic 함정 회피 — 추측 hardcode 박지 말 것).

### ✅ Phase 0 — 스캐폴드
- Tauri + React + TypeScript 프로젝트 생성
- Rust-React 왕복 (`invoke("echo_message")`)
- PowerShell 편의 스크립트
- 임시 아이콘

### ✅ Phase 1 + UI 재디자인 — 실제 Claude 연결 + P3Torrent 스타일
- 창 크기 1200×800, 3분할 레이아웃
- Node sidecar + Claude Agent SDK
- stdin/stdout JSON 프로토콜
- 스트리밍 응답, 중단 지원
- P3Torrent HUD 스타일 (다크 + 시안 네온)
- 메시지 타입별 렌더링
- 토큰·턴 미터

### ✅ Phase 3 — K-Personal MCP 통합
- `mcpServers: { "k-personal": {...} }` 설정
- Python + server.py 헬스체크
- `mcp_status` 이벤트 → UI 반영
- `permissionMode: "bypassPermissions"` (개인용)
- **검증됨**: 스크린샷 캡처·분석 성공

### ✅ Phase 2 — 트레이 + 자동시작 + 리로드 + 바로가기 (2026-04-21)

구현 및 적용 완료:
- 시스템 트레이 아이콘 (`tauri-plugin-single-instance` + `tray-icon`)
- 창 X 버튼 → 트레이로 숨김 (프로세스 살아있음)
- 트레이 좌클릭 → 창 토글
- 트레이 우클릭 메뉴: Show / Reload Sidecar / Settings / Quit
- Settings 모달: 자동 시작 토글, Sidecar 재기동, 앱 종료, 정보
- `reload_sidecar` Tauri 커맨드 (sidecar 프로세스 재기동)
- `--minimized` 플래그로 창 숨긴 채 시작 (자동 실행용)
- `scripts/launch.vbs`: 창 없이 백그라운드로 앱 실행
- `scripts/setup-shortcuts.ps1 -AutoStart`: 바탕화면·시작메뉴·시작프로그램 3종 등록 완료
- `KDA_OPEN_DEVTOOLS` 환경변수로 DevTools 자동 오픈 (기본 off)

---

### ✅ Phase 4 — SQLite 대화 히스토리 (2026-04-22)

구현 및 적용 완료:
- `src/db.ts`: `@tauri-apps/plugin-sql` 기반 DB 헬퍼 (`initDB`, `getAllConversations`, `createConversation`, `getMessages`, `saveMessage`, `updateConversationAgentId`, `deleteConversation`, `generateTitleFromMessage`)
- 스키마: `conversations` (id, title, created_at, updated_at, agent_id) + `messages` (id, conversation_id, role, content, timestamp, streaming, level, tool_id/name/input/output/status) + 인덱스
- DB 파일: `%APPDATA%\com.k.desktop-agent\conversations.db`
- 첫 user 메시지에서 자동 제목 생성 (첫 줄 40자)
- 300ms 디바운스로 메시지 일괄 저장 (user/assistant/tool)
- Claude Agent SDK `resume` 지원: 대화별 `agent_id` 저장 후 전송 시 자동 전달 → 이전 컨텍스트 이어받기
- 사이드바: 대화 목록 실제 DB 연동, 선택 시 메시지 로드, 삭제(CASCADE) 버튼
- **버그 수정 (2026-04-22)**:
  - `handleSidecarEvent`의 `useCallback([])` 정적 클로저 문제 → `latest-ref` 패턴으로 교체하여 assistant/tool 메시지와 `agent_id`가 실제 저장되게 함
  - Sidecar가 SDK `result` 이벤트의 `session_id` 가 아니라 `agentId` 를 읽어 agent_id 가 항상 NULL 이던 것 수정
  - SDK `resume` 옵션만으로는 컨텍스트 복원이 안 돼 **수동 히스토리 주입** 도입: 프런트가 최근 20개 user/assistant 메시지를 `history` 로 함께 보내고, sidecar 가 `<prior_conversation>…</prior_conversation><current_message>…</current_message>` 구조로 묶어 prompt 전달. SYSTEM_PROMPT 에 해석 규칙 추가. 2-턴 기억 e2e 테스트 통과.
  - `done` 이벤트 중복 emit 방지 (`sawResult` 플래그)

## 남은 Phase

### ✅ Phase 5 — 마크다운 렌더링 + 인스톨러 (2026-04-23)

구현 및 적용 완료:
- `react-markdown` + `remark-gfm` + `rehype-highlight` 적용
- **볼드**, *이탤릭*, ~~취소선~~ 렌더링
- 코드블록 신택스 하이라이팅 (highlight.js)
- 인라인 코드 `code` 스타일링
- 링크 클릭 → 기본 브라우저로 열기 (`@tauri-apps/plugin-shell`)
- 테이블(GFM) 렌더링
- MSI/NSIS 인스톨러 빌드 (`scripts/build-msi.ps1`)
- 컨텍스트 모니터링 + 80% 임계치 자동 세션 리프레시
- `computed_usage` 기반 정확한 토큰 카운팅 (modelUsage에서 계산)

---

### ⬜ Phase 6 — 전역 단축키 + UX 개선

**왜 필요한가**:
- 다른 앱 작업 중에도 빠르게 K Desktop Agent 호출
- 자주 쓰는 명령 원클릭 실행

**구현 포인트**:
1. `tauri-plugin-global-shortcut` 설치 및 설정
2. 기본 단축키: `Ctrl+Shift+K` → 창 토글
3. `Ctrl+Shift+S` → 스크린샷 캡처 후 분석 요청
4. 설정에서 단축키 커스터마이즈 UI
5. 빠른 명령 팔레트 (Ctrl+K 스타일)

**예상**: 2~3시간

---

### ⬜ Phase 7 — 음성 입력 (한국어 STT)

**구현 포인트**:
1. Web Speech API 또는 외부 STT 서비스
2. 마이크 버튼 UI
3. 실시간 음성→텍스트 변환
4. 한국어 최적화

---

### ⬜ Phase 8 — 프리셋/빠른 명령 버튼화

**구현 포인트**:
1. 자주 쓰는 프롬프트 버튼으로 표시
2. 커스텀 프리셋 추가/편집
3. 키보드 단축키 바인딩

---

### ⬜ Phase 9 — 개인화 스킬 (자가 학습 + 실패 회피)

**상세 설계: `docs/PHASE-9-PERSONALIZATION.md`** (2026-04-30 작성)

**왜 필요한가**:
- 같은 함정에 반복적으로 빠지는 걸 방지 (직전 BOM/키 로테이션 사고가 정확한 케이스)
- K 의 선호·자주 쓰는 패턴을 매 세션 자동 적용

**구현 포인트**:
1. 메모리 디렉토리 자동 로딩 (`feedback_*.md` / `pitfall_*.md` / `pattern_*.md`)
2. PostToolUse Hook 으로 실패 시그널 수집 → 세션 종료 시 K 승인 게이트로 저장
3. PreToolUse `pitfallGuard` Hook 으로 위험 패턴 사전 차단
4. Settings "Memory" 탭 — 토글·후보 검토·디렉토리 열기

**예상**: 6.5시간 (한 세션)

---

### ⬜ Phase 10 — 추가 MCP (Notion, Slack, GitHub)

**구현 포인트**:
1. MCP 서버 다중 연결
2. 서비스별 인증 관리
3. 통합 명령 팔레트

---

### 🟡 Phase 11 — OpenAI / Google 멀티 프로바이더 (G1 출하, G2~G5 미진행)

**상세 설계 + 진행 상황: `docs/PHASE-11-MULTI-PROVIDER.md`**

**왜 필요한가**:
- 모델별 강점 활용 (코드는 Claude, 이미지는 GPT, 검색은 Gemini 등)
- Claude OAuth 차단 시 폴백 안전망
- 진정한 멀티 프로바이더 = 같은 자동화 도구를 모든 모델이 쓸 수 있어야 함 (G1 핵심)

**G1 — MCP function calling 어댑터 ✅ 출하 (2026-04-30)**:
- OpenAI / OpenRouter / Gemini REST 경로가 K-Personal MCP 의 45개 도구를 직접 호출 가능
- 신규 모듈 3개: `sidecar/src/mcpClient.ts`, `toolSchema.ts`, `restTools.ts`
- `handleViaRestAPI` 가 single-shot → multi-round tool-call 루프로 리팩토링 (MAX_TOOL_ROUNDS=8)
- 신규 회귀 smoke `smoke-rest-tools.ps1` (Layer 1 mock HTTP 33 어설션 + Layer 2 live MCP 9 어설션) — CI 통합됨
- Anthropic-via-REST 는 별개 protocol → G1 범위 외 (Claude (Max OAuth) 경로 권장)

**남은 갭 (G2~G5, 미진행)**:
- G2 — API key 평문 localStorage → OS keyring (~0.5일)
- G3 — REST 경로 이미지 첨부 (현재 Claude CLI 만, ~1일)
- G4 — Strategy C 폴백 (Claude 실패 시 자동 GPT/Gemini 재시도, ~0.5일)
- G5 — 메시지별 모델 picker (현재 글로벌 1개, ~0.5일)

**핵심 제약**: ChatGPT Plus 구독 OAuth 의 API 외부 사용은 ToS 위반 → API key 입력이 정공법 (Gemini 도 동일).

---

### ✅ Phase 13 — Headless Automation (UIA + Playwright) — 2026-05-06

**왜 필요한가**:
K 가 RDP 로 같은 PC 를 쓰는 동안 에이전트가 `cc_*` (pyautogui SendInput) 로 자동화하면
K님 마우스/키보드/화면을 점유해 충돌. "나는 나대로 너는 너대로" 가 안 됨.
헤드리스 경로(UIA + Playwright)로 가면 K님 입력 0 점유, 화면 픽셀 캡처 0 → 충돌 없음.
스냅샷=문서 패턴(accessibility tree 텍스트화) 으로 컨텍스트도 더 효율적이고 좌표 추정도 불필요.

**구현 완료**:
- K-Personal MCP 신규 모듈 2개:
  - `modules/uia_control.py` — Windows UI Automation (uiautomation 패키지). 9개 도구
    (`ui_dump_tree` / `ui_find` / `ui_click_by_name` / `ui_click_by_id` / `ui_set_text` /
     `ui_get_text` / `ui_focus_control` / `ui_invoke` / `ui_list_windows`).
    InvokePattern → SelectionItem → Toggle → ExpandCollapse 폴백 체인. ValuePattern.SetValue
    로 IME 우회 한글 입력. 트리 dump 는 max_depth/max_nodes 로 컨텍스트 보호.
  - `modules/web_automation.py` — Playwright 헤드리스 chromium. 9개 도구
    (`web_open` / `web_snapshot` / `web_click` / `web_fill` / `web_get_text` / `web_screenshot` /
     `web_evaluate` / `web_url` / `web_close`). 브라우저는 K님 화면 안 뜸. accessibility
    snapshot 텍스트 자동 반환 (스크린샷 대신).
- `requirements.txt` 에 `uiautomation>=2.0.18`, `playwright>=1.40.0` 추가. 외부 패키지
  미설치 환경에서도 K-Personal MCP 자체는 살아남는 지연 import 패턴.
- sidecar `PERM_TOOL_MAP` / `PERM_LABEL` / `DEFAULT_PERMISSIONS` 에 `ui_automation`,
  `web_automation` 카테고리 신설 (cc_* 와 분리). 둘 다 기본 auto — K 입력 안 점유라 안전.
- 시스템 프롬프트에 자동화 우선순위 박힘: ① web_*  ② ui_*  ③ cc_* (마지막 수단).
- Settings UI (`src/components/Settings.tsx`) `TOOL_CATALOG` + `DEFAULT_PERMISSIONS` 에
  새 카테고리 2개 노출. 카테고리 토글 + 정밀 잠금(개별 도구 체크박스) 모두 지원.
- 회귀 테스트:
  - `sidecar/test-perm-gate.mjs` 11/11 (Phase 13 케이스 4개 추가)
  - `sidecar/test-headless-mcp.mjs` 11/11 (모듈 import + sidecar/Settings 동기화 검증)
- `scripts/check.ps1` 에 `test-headless-mcp.mjs` 결합. preflight 가 sidecar/MCP/UI 3곳의
  도구 이름 동기화를 매번 검증 → "한쪽만 바꾸고 다른 쪽 잊는" 패턴 사전 차단.

**브라우저 바이너리 설치** (1회):
```powershell
python -m playwright install chromium
```

### ✅ Phase 15 — Codex CLI + 외부 사용량 페이지 — 2026-05-07

**문제:** K 가 ChatGPT Pro 구독 토큰을 K-Desktop-Agent 에서 사용 + 사용량 페이지를 앱 안에서 진입.

**핵심:**
- **15.1 외부 사용량 페이지** — 처음엔 Tauri `WebviewWindowBuilder` 새 창으로 `console.anthropic.com/usage`
  띄웠으나 Google OAuth 가 embedded webview 차단 (2021 정책) → `lib.rs` 의 `open_external_webview` 를
  `tauri-plugin-opener` 로 교체해서 K 시스템 기본 브라우저로 흘림. URL 도 정정: Anthropic Max 구독자는
  `claude.ai/settings` (console.anthropic.com 은 API 키 사용자 전용).
- **15.2~15.4 Codex CLI 통합** — `codex exec --json --skip-git-repo-check` non-interactive spawn,
  JSONL 이벤트 (`turn.started` / `item.completed` / `turn.completed`) 파싱. `~/.codex/auth.json`
  OAuth 토큰을 codex CLI 가 관리. Tauri commands: `codex_login` (background spawn, 콘솔 hidden),
  `codex_login_status`, `codex_register_mcp`. Settings.tsx 의 `API_PROVIDERS` 에 Codex 카드
  (`noKeyRequired`) + 외부 webview 섹션 + Codex 인증 섹션. Codex 도 MCP 표준 준수 → K-Personal MCP
  도구 (uia_*, web_*, fm_*, db_*) 그대로 사용 가능.
- **회귀 테스트** — `sidecar/test-codex-integration.mjs` 41/41 (Phase 15 + 15.5 모두 검증).

### ✅ Phase 15.5 — Rate Limit Dashboard — 2026-05-07

**문제:** "5h 한도 + 주간 한도 사용량 + 각각 reset 까지 남은 시간" K 명시 요구.

**경로 결정 과정 (시행착오 기록):**
1. 처음엔 SSE `rate_limit_event` 페이로드 사용 시도 → `{status:"allowed", resetsAt, rateLimitType:"five_hour"}`
   만 박혀 옴 (used% 와 주간 정보 없음).
2. Claude Code 의 `statusLine` JSON 에 `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`
   가 정확히 박힘을 발견 → `~/.kda/statusline.mjs` install + `~/.claude/settings.json` 등록.
3. 그러나 **K-Desktop-Agent 의 `claude -p` (non-interactive) 에서는 statusLine trigger 안 됨**
   (interactive REPL 전용). statusLine 은 dormant 로 남김 (K 가 외부 터미널에서 interactive 쓰면 자동 작동).
4. **최종 path: `npx ccusage@latest` 통합** — `blocks --active --json` (5h block) +
   `weekly --json` 5분 간격 polling. `~/.claude/projects/` session 파일 파싱이라 statusLine 무관.

**Codex 쪽:**
- `chatgpt.com/backend-api/codex/usage` GET (Bearer from `~/.codex/auth.json`).
- 비공식 endpoint — `lib.rs` 의 `codex_fetch_usage` Tauri command (reqwest + rustls-tls), silently fail.
- 응답 필드: `primary_window` / `secondary_window` 둘 다 `utilization_percent` + `reset_at` 정확히 박힘.

**UI:**
- `MetricsPanel` 의 `RateLimitCard` — 5h ⏳ + Week ⏳ 카드 (⏳ = 한도 % 아님 명시).
- Anthropic 은 한도 비공개라 **시간 진행률** (block_start ~ block_end 사이 위치) 을 % bar 로 표시.
- Codex 는 정확한 한도 % 표시.
- 토큰 누적 + ⏱ reset countdown + burn rate 위험 시 자동 warn 색.
- localStorage 영속 (provider 별 분리).

**회귀 테스트:** `sidecar/test-codex-integration.mjs` 41/41.
