# KDA 비서 패널 — 2026-11-05

상태: 로컬 구현 후보. UI 14개 항목 PASS, 전체 release:gate 11 PASS. 설치·릴리스·실제 음성통화 연결은 미실행.

K의 두 DOT 화면 예시와 오른쪽 배치·이동·최소화 요청을 반영했다. 별도 OS 창이 아닌 앱 내부 플로팅 카드이며, 오른쪽 위가 기본 위치다. 색상은 기존 KDA 디자인 토큰을 사용한다.

- 프로필 → 통화하기·Telegram → 연결 컴퓨터 → 최근 활동 → 결과물 순서. 결과물은 현재 대화의 최근 완료 답변이며, 생성 파일을 탐색·검증한 목록은 아니다.
- 상단 드래그로 이동, −로 작은 단축창, ↗로 복원. 작은 단축창도 이동 가능. 위치와 최소화 상태는 `kda_assistant_widget_v1`에 저장한다.
- 이동 영역에 키보드 포커스 후 방향키 이동, Shift+방향키 40px 이동, Home 기본 위치. 하단 위치 복원 버튼 제공. 화면 크기 변경 시 경계 안으로 보정하며 카드 본문 스크롤 유지.
- 최소화는 DOT 연결기 마운트·폴링·지정 대화를 유지한다. 기존 승인·정지·다른 대화 차단 경로는 그대로 사용한다.
- 통화하기는 기존 native URL 열기로 ChatGPT를 연다. 통화 시작은 ChatGPT에서 수행하며, 통화 연결 여부나 음소거 상태를 KDA에서 추정 표시하지 않는다.
- Telegram은 기존 전용 대화가 있으면 선택하고 없으면 설정을 연다. 메시지를 자동 전송하지 않는다. 연결 컴퓨터 표시는 기존 MCP 연결 상태이며 ChatGPT 연결 PC의 접근 허용 상태와는 구분한다.
- 최근 활동은 최근 대화 세 개와 실행 여부. 항목 선택은 기존 대화 선택 경로를 사용한다.

실제 컴포넌트: `src/components/AssistantWidget.tsx`, `AssistantWidget.css`. App의 기존 DOT 핸들러를 새 카드가 내장한 `DotBridgePanel`에 전달한다. Portal로 그려 기존 메인 그리드 행·열을 추가하지 않는다.

증거: `evidence/assistant-widget-20261105/status.json`, `gate.done.json`, `ui-verification.json`, `release-gate.log`, `expanded.png`, `minimized.png`, `small-viewport.png`. `review.html`은 실제 컴포넌트를 예시 데이터와 native 호출 대역으로 표시하는 독립 검토 화면이다. 설치 앱 캡처가 아니다.

검증: headless Edge UI 14개, sidecar TypeScript·프런트 TypeScript/Vite·cargo check, 기존 회귀 317/317 assertions와 node:test 218/218 PASS. 기존 DOT 핸들러 테스트는 새 카드의 JSX에서 실제 핸들러를 추출해 검증한다. UI 테스트는 개인 화면·마이크·실제 DOT 계정에 접근하지 않는다.

태그 push·설치·실제 DOT 통화 왕복 및 정지 지연 검증은 남아 있다. 완료된 로컬 검증을 이유 없이 재실행하거나 기존 연결기·컴퓨터 제어 변경을 초기화하지 않는다.
