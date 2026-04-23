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

### ⬜ Phase 9 — 자가 학습 (사용 패턴 기반 선제 제안)

**구현 포인트**:
1. 사용 패턴 분석
2. 시간대/상황별 제안
3. 자주 쓰는 명령 우선 표시

---

### ⬜ Phase 10 — 추가 MCP (Notion, Slack, GitHub)

**구현 포인트**:
1. MCP 서버 다중 연결
2. 서비스별 인증 관리
3. 통합 명령 팔레트
