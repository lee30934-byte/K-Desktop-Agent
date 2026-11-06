# KDA 비서 아바타 / 통화 연장 — 2026-11-06

현재 변경은 Windows SMM의 `.worktrees/control-results-20261105`에서 기존 v0.7.75 후보와 500% 출력 검증 결과를 유지한다. 설치·태그 push·릴리스 미실행. 기존 비서 UI 설명의 K 문자 및 최대 5분 문구는 이 개정으로 대체된다.

## 동작

- 직접 작성한 SVG 로봇·고양이·새싹·구름. 안테나·꼬리·잎·별의 고유 대기 동작, 숨쉬기/부유·눈깜빡임·시선 이동. 기본 로봇.
- 클릭 순서: 인사 → 하트 → 갸웃 → 졸기. 대기 중에는 19초마다 짧은 리액션. 음성 연결·청취·생각·말하기·음소거·오류와 진행 중 작업을 실제 상태로 표시한다. 입 움직임은 발화 상태 기반이며 음소별 립싱크가 아니다.
- `아바타 꾸미기`에서 종류 및 모션 on/off. `kda_assistant_avatar_v1`에 저장하며 잘못된 저장값/저장 차단 시 기본값으로 복구. OS reduced-motion은 CSS 애니메이션을 제거하고 document hidden 시 움직임/자동 리액션을 멈춘다. 최소화에서도 아바타와 통화는 유지된다.
- 아바타 버튼은 드래그와 분리. 텍스트/빈 헤더 영역은 기존 이동·키보드 이동·경계 보정 유지.
- 기본 통화 5분. 남은 시간이 5분 이하일 때 `5분 연장` 가능. KDA 중계기의 만료 시간을 갱신하고, 동일 WebRTC/Codex 세션·마이크·대화 대상을 유지한다. 남은 시간은 최대 10분까지 확보하며 무제한 자동 연장은 하지 않는다.
- 고유 토큰에 대한 서버 `lease` 확인을 받은 뒤에만 시간 연장 성공 표시. 5초 내 미확인 시 기존 만료 시간을 유지하고 확인 실패 표시. 이때 같은 요청을 자동 재전송하지 않는다. 다른 세션/중복/만료 뒤 갱신은 수명 연장/세션 부활을 일으키지 않는다. 프런트가 사라져도 sidecar 만료 타이머가 정리한다.
- 외부 제공자의 연결 종료/서비스 한도까지 늘리는 기능은 아니다. 실제 구독 통화가 5분을 넘긴 실증 및 설치본 WebView2 검증은 별도이며 이번 검증은 synthetic media/native stubs 및 가상 시계 기반이다.

## 파일 및 증거

- `src/components/AssistantAvatar.tsx`, `.css`: 원본 벡터 및 모션. GPT/Codex가 코드로 작성. GPT 이미지 생성/기성 아바타/외부 모델 사용 없음.
- `AssistantWidget.tsx`, `VoiceCallPanel.tsx`, `voiceSession.ts`: 저장·상태 연결·카운트다운·확인된 갱신.
- `src-tauri/src/lib.rs`, `sidecar/src/codex-voice.mjs`: 기존 voice_control에 extend 추가, 세션별 만료 갱신.
- `scripts/voice.test.ts`: 기존 회귀 29개 + 갱신/중복/기존 만료시각/미확인/해제 검사 3개.
- `scripts/build-avatar-review.mjs`, `scripts/probe-avatar-motion.py`: 실제 컴포넌트 미리보기 및 headless Edge UI 검증.
- `evidence/avatar-motion-20261106/review.html`: 4종 대화형 미리보기. `ui/review.html`: 실제 비서 패널 fixture.
- 같은 폴더 `status.json`, `avatar-ui.json`, `ui/ui-verification.json`, 전체 release gate 로그가 현재 변경의 검증 근거. 실패한 초기 UI 시도는 별도 attempt JSON으로 보존한다.

기존 `evidence/voice-gain-500-20261106/status.json`은 당시 입력 해시의 역사 증거이며 새 `VoiceCallPanel.tsx` 해시까지 검증한 것으로 확대하지 않는다. 새 변경 전체는 본 개정 status 원장에 기록한다.
