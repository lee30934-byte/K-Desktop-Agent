# 최소 승인 정책

2026-10-31 K 요청: “내가 전부 승인하는 방향으로 갈거야 진짜 꼭 반드시!!! 필요한 부분만 승인창 띄우는걸로 하자”. 기준 소스: v0.7.60 / 3e413eb.

작업 지시는 그 범위의 승인이다. 필요한 조회, 분석, 빌드, 테스트, 새 산출물 작성과 복구 가능한 코드 수정은 매 단계 되묻지 않는다. 이미 승인한 정확한 대상·행동과 상시 승인 조건도 재사용한다. 이 공통 지침은 Claude, Codex, Gemini, REST, BrowserHost에 전달한다.

새 파괴 작업, 외부 공개·배포, 결제, 권한 확대와 실제로 빠진 사용자 입력은 별도 확인 대상이다. 전원 조작과 사람 눈 검증에 관한 기존 규칙도 유지한다. 기존 권한 잠금은 자동 해제하지 않는다.

## Codex의 중복 읽기 확인

KDA가 `essentialApprovals: true`로 시작한 Codex bridge에서 아래 조건을 모두 만족하면 별도 폼을 표시하지 않고 같은 `confirm_read: true`를 반환한다.

- 기존 thread/turn 및 폼 스키마 검증 통과.
- 요청 서버가 `k-personal`이고 해당 서버의 진행 중 도구가 정확히 하나.
- 그 도구의 시작 이벤트가 현재 thread/turn과 일치.
- 도구가 명시한 읽기 도구 목록에 있고, 원래 인수에 boolean `confirm_read: true`가 존재.
- 폼은 필수 boolean `confirm_read` 하나만 요구.

한 요청 ID에는 한 번만 응답한다. 도구 완료 후에는 해당 문맥을 재사용하지 않는다. 일반 boolean `approve`, 추가 입력 필드, 쓰기·UI 동작·임의 evaluate, 미확인/새 도구, 복수 동시 호출은 기존 폼으로 전달한다. 명령·파일 승인 요청은 기존 처리대로 유지한다. 이는 모든 승인창을 자동으로 닫는 기능이 아니다.

`KDA_ESSENTIAL_APPROVALS=0`으로 KDA sidecar를 시작하면 중복 읽기 자동 응답을 끈다. bridge 직접 사용 시 `essentialApprovals` 생략도 자동 응답을 끈다.

## 검증 및 반영 상태

실제 설치 번들 Node v20.18.0에서 다음 검사 exit 0:

- `sidecar/test-essential-approvals.mjs`: 12사례 × 켜짐/꺼짐, 총 24사례. 일치한 읽기만 자동 응답; 미확인·다른 서버·새 질문·완료·복수·다른 문맥은 폼 유지. 요청 중복 응답 없음.
- `sidecar/test-codex-approval-bridge.mjs`: 명령 승인·거절 및 다른 항목의 승인 재사용 차단.
- `sidecar/test-codex-elicitation-bridge.mjs`: 기존 13종 요청 × 2결정 및 진단 개인정보 검사.
- `sidecar/test-elicitation-diagnostic-lifecycle.mjs`: 턴 완료·연결 종료 시 요청 정리.
- `sidecar/test-autonomy-policy.mjs`: 모든 엔진 공통 지침 경로.
- TypeScript: `tsc --project sidecar/tsconfig.json --noEmit`.

소스 수정과 오프라인 프로토콜 검증 완료. 설치된 v0.7.60 실행 파일은 변경하지 않았다. 실제 앱 UI와 신규 배포 검증은 미실행. 소스와 설치본의 동일성을 주장하지 않는다. 다음 배포는 별도 승인 범위다.

공식 프로토콜 참고: https://learn.chatgpt.com/docs/app-server (2026-10-31 조회). MCP 폼은 구조화 입력을 요구하므로 임의 필드나 기본값에서 새 동의를 추정하지 않는다.

## v0.7.61 릴리즈·설치 승인 (2026-10-31)

K의 후속 지시 “설치본까지 반영하자 깃허브 릴리즈까지 진행해줘”로 이 변경의 GitHub 릴리즈·설치까지 승인됨. 위의 별도 배포 승인 대기는 해소됐다.

- 릴리즈 기반: 원격 `v0.7.60`이 가리키는 `3e413eb1c3f6edc9f0a9f720d3ff4ec971c0045c`. 오래된 로컬 main의 미완성 변경은 포함하지 않는다.
- 로컬 검증: 설치 번들 Node v20.18.0에서 새 승인 시나리오 검사, 프런트·sidecar 타입 검사 및 빌드 exit 0. `scripts/check.ps1` 전체 검사 exit 0.
- 상세 실행 증거·후속 상태: `C:/Users/lee30/.kda/tmp/kda-v0761-release-20261031/`.
- 설치 조건: 정확한 커밋의 CI 성공, 설치 파일·서명·업데이터 메타데이터 확인 후 기존 서명 검증 인앱 업데이터로 요청 버전만 설치. 진행 중 턴 0개·90초 이상 유휴 조건 유지.
- 재시작 후 실제 버전·실행 경로와 설치된 bridge를 검증한다. 현재 문서는 GitHub 빌드 성공이나 설치 완료를 선행 주장하지 않는다.
