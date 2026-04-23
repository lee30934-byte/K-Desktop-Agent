# ROADMAP — K Desktop Agent

## 완료된 Phase

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

### ⬜ Phase 5 — 마크다운 렌더링 + 인스톨러

**왜 필요한가**:
- 응답의 `**볼드**`, 코드블록이 raw 로 보임 (가독성↓)
- 지인 배포용 MSI 없음

**구현 포인트**:
1. `react-markdown` + `remark-gfm` + `rehype-highlight`
2. 코드블록 신택스 하이라이팅
3. 링크 → `tauri-plugin-shell` open()
4. MSI 빌드 (sidecar 번들링 전략 결정 필요)
5. Windows SmartScreen 대응

**예상**: 3~4시간. 상세: `docs/PHASE-5-POLISH.md`

---

## 장기 아이디어 (선택)

- **Phase 6**: 전역 단축키 (`tauri-plugin-global-shortcut`)
- **Phase 7**: 음성 입력 (한국어 STT)
- **Phase 8**: 프리셋/빠른 명령 버튼화
- **Phase 9**: 자가 학습 (사용 패턴 기반 선제 제안)
- **Phase 10**: 추가 MCP (Notion, Slack, GitHub)
