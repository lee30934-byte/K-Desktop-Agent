# WebView2 본체 통합 잔여 작업 — 2026-09-15

## 현재 결론

별도 OAuth 앱에서 실제 BrowserHost 모듈의 로그인 후 텍스트 응답 경로를 검증했다. 본체 엔진 통합 완료나 설치본 검증을 의미하지 않는다.

- 기준 작업트리: `evidence/webview2-integration-20260911`, 기준 버전 0.7.34.
- 빌드 증거: `../evidence/browser-host-integration/oauth-harness-build-v2/result.json` — 4개 단계 exit 0. 이전 턴에서 입력 7개와 exe SHA-256 일치를 확인했다.
- 실행 증거: `../evidence/browser-host-integration/oauth-postlogin-1789431199601.json` — 2026-09-15 00:13:19–00:13:39 UTC, passed=true, 완료 마커 exitCode=0.
- 새 임시 창과 재개방 창에서 authenticated=true/ready/temporary=true 확인.
- 숨김 뒤 실제 응답 문자열 일치, 중복 send 거부, 완료와 중단 각각 destroyed 기록 및 해당 owner의 windows=[] 확인.
- 로그인 유지 측정은 같은 앱 프로세스에서 창 재개방 기준이다. 이번 결과로 앱 재시작·PC 재부팅 후 유지까지 주장하지 않는다.
- 이전 Google 인증 정체는 원인 미확정이다. 이번 성공이 이전 차단 원인을 설명하지 않는다. 보고서의 oauthVerified=false, productionSidecarVerified=false를 유지한다.

## 코드와 증거의 차이

| 영역 | 현재 코드/증거 | 남은 완료 조건 |
|---|---|---|
| BrowserHost | Rust 모듈을 별도 앱에 직접 포함해 검증 | 실제 sidecar stdout → Rust → 원래 sidecar stdin 왕복 검증 |
| 통신 계약 | BrowserHostClient 수신 연결, request ID/owner 대응 | diagnostics action, authenticated:null, authState 및 진단 응답의 명시적 타입; 잘못된 상태 객체 검증 |
| Provider | index.ts의 Provider/handleUserMessage에 BrowserHost 분기 없음 | 대화별 provider 설정 → 메시지 → 시작/출력/종료 이벤트, 취소 전파 연결 |
| Responses | 현 검증은 파일 inbox/outbox 사용 | 필요한 요청/스트림/오류/취소 계약을 먼저 정의하고 라우팅 검증; 기존 REST provider와 동일시하지 않음 |
| Full 권한·MCP | BrowserHost는 텍스트 송수신만 수행 | 기존 권한·프로젝트 범위 검사 경로로만 도구 요청 연결; 거부 시 실행 0회 확인 |
| 모델·effort | BrowserHost Request에 해당 필드 없음 | 선택 가능 항목의 실제 상태 확인, 미지원 조합을 명시적으로 거부; UI 선택값만으로 성공 판정 금지 |
| 첨부 | BrowserHost Request는 prompt만 수용 | 파일 수용/업로드 완료/전송 시점 검증, 실패한 첨부를 성공으로 취급하지 않음 |
| 큐·동시성 | owner별 lease, 최대 5개; 종료 lease는 close 필요 | 대화 혼선 없음, 용량 회수, 대기 중 취소, sidecar 종료·교체 및 늦은 응답 검증 |
| resume·compaction | 매번 임시 대화, 이번 검증은 독립 턴 | KDA 대화 문맥 전달 정책과 길이 제한, 중복 전송 방지, 요약 이후 문맥 유지 검증 |
| 배포 | 격리 작업트리의 수정·미추적 파일 존재 | 변경 파일 선별, 타입 검사·회귀·release gate, 별도 설치본 검증 후 릴리즈 판단 |

## 권장 적용 순서와 통과 기준

1. **계약과 실제 sidecar 연결**
   - 타입를 Rust의 실제 응답과 맞춘다. 인증 미확인을 false로 강제 변환하지 않는다.
   - 격리 앱에서 실제 sidecar 프로세스를 연결하고 왕복 응답, 종료 시 창 정리, 늦은 응답 거부를 측정한다.
   - 단위 테스트와 실제 IPC 증거가 함께 있어야 통과한다. 파일 mailbox 검증만으로 대체하지 않는다.
2. **텍스트 provider와 수명주기**
   - 대화별 provider 선택, 임시 대화 준비, 전송, 출력, 완료, 취소를 KDA turn lifecycle에 연결한다.
   - 서로 다른 두 대화, 중복 요청, 로그인 필요, 시간 초과, 용량 초과 시 결과 귀속과 자원 회수를 검증한다.
3. **Responses 및 Full 권한 계약**
   - 입력/출력/도구 요청 계약을 문서화한 뒤 기존 권한 검사 경로에 연결한다.
   - 일반 텍스트가 도구 실행으로 해석되지 않아야 한다. 허용·거부·프로젝트 범위 위반을 각각 검증한다.
4. **모델·effort·첨부·문맥**
   - 지원 여부를 실제 UI/응답 상태로 확인한다. 미지원은 조용히 무시하지 않는다.
   - 첨부 완료 전 전송 방지, 큐 순서, resume와 compaction 이후 대화 귀속을 검증한다.
5. **통합 회귀와 릴리즈 준비**
   - 관련 TS/Rust 검사, 기존 provider 회귀, 격리 앱의 실제 동작, release gate를 실행한다.
   - 별도 앱 재시작 후 로그인 유지와 OAuth 팝업 잔류 시나리오는 별도 증거로 남긴다.
   - 설치본·업데이터·자동시작·레지스트리·서명 작업은 이번 정리 범위에 포함하지 않는다.

## 이번 턴 산출물과 범위

기존 구현과 실행 보고서를 읽어 이 계획 문서만 추가했다. 코드 변경, 빌드, dev server, 설치, 공용 설정 변경은 수행하지 않았다. 문서 정리이므로 기존 테스트를 재실행하지 않았다.

다음 구현 단위는 1번이다. 전체 기능 완료와 각 단계의 부분 통과를 구분해서 보고한다.

---

## 진행 실측 (2026-09-15 갱신)

### 1번 계약·실제 sidecar 연결 — 통과
- 실제 Node IPC: `evidence/browser-host-integration/ipc-build-run-v1/result.json` (6단계 exit 0).
- 전체 sidecar 시작 경로: `full-startup-v2/result.json` (20개 항목 PASS, HEAD 기준본과 A/B).
  - v1 실패는 러너의 관측 창 결함이었다 → `memory/pitfall_probe_window_snapshot_taken_after_later_probes.md`.

### 2번 대화별 provider — 통과
- 구현: `sidecar/src/browserProvider.ts` (+ `index.ts` 의 `chatgpt-web` 분기), 프런트엔드 5개 지점.
- 격리 프로토콜 e2e: `provider-e2e-v4/result.json` (19개 항목 PASS).
- **실제 ChatGPT 왕복**: `fullstack-chatgpt-v4/result.json` (15개 항목 PASS).
  - 토큰 `KDA-FULLSTACK-387B74768948` 와 답변이 **정확히 일치**(26자, delta 1건), 14.0초.
  - 호출 순서 `open → status×3 → hide → send → status×8 → close`, 잔류 창 0, sidecar exit 0.

### 큐·동시성 — 통과 (2번의 마지막 빈칸)
- 동시 두 대화: `provider-concurrency-v1/result.json` (16개 항목 PASS).
  대화별 응답 지연을 다르게 줘 **실제로 겹치게** 만든 뒤 측정(`turns-actually-overlapped` 를 선행 게이트로).
  텍스트 격리(X/Y 상호 오염 0), owner 3개 분리, `send` 대화당 1회, lease 각각 close,
  용량 초과 대화는 자기 턴만 실패하고 나머지 두 대화는 정상 완료.
- native 상한: `capacity-v1/result.json` (14개 항목 PASS, 실제 WebView2 창).
  `opened-5 → 6번째 browser-capacity-reached(창 생성 0) → close 후 4 → 재개방 5 → shutdown 0 → 종료 후 요청 차단`.
  로그인 프로필은 사용하지 않았고 파일 수 1156 → 1156 으로 불변.

### 이 과정에서 고친 제품 결함 두 가지 (둘 다 회귀 테스트로 고정)
1. **준비상태 오진** — 창을 연 직후의 `authState:"unverified"` 스냅샷을 로그인 만료로 단정했다(턴 시작 0.58초 만에 오판).
   → `waitForReady()` 로 ready 까지 대기하고, 마감 후에만 "측정된 미로그인"과 "측정 실패"를 구분한다.
2. **텍스트 오염** — 브라우저 텍스트는 append-only 가 아니다. "생각 중..." 자리표시자가 답으로 교체되자
   조립기가 안내문구까지 본문에 끼워 넣었다.
   → 다음 스냅샷이 접두사로 연장했을 때만 내보내는 **확정 후 전송**, 종료 시 최종본으로 잔여분 확정.
   이미 보낸 뒤 재작성되면 덧붙이지 않고 오류로 실패시킨다.

### 3번 도구·권한 계약 — 부분 통과 (도구 미지원을 계약으로 확정)

이번에 한 것은 "ChatGPT 웹에 도구를 붙였다"가 **아니다.** 반대로 **도구를 절대 실행하지 않는다**는 것을
코드로 강제하고, 그 사실을 사용자에게 숨기지 않게 만들었다.

- **이벤트 화이트리스트**: `BROWSER_PROVIDER_EVENTS = [assistant_delta, error, done, provider_notice]`.
  목록 밖 type 을 내보내려 하면 런타임에서 던진다. 관례가 아니라 실행 시점 강제다.
  → ChatGPT 가 `{"type":"tool_use","name":"Bash",...}` 같은 문자열을 답해도 그건 그냥 본문 텍스트다
  (회귀 테스트로 고정: 도구 이벤트 0건, 본문은 원문 그대로, action 은 open/hide/send/status/close 뿐).
- **명시적 고지**: 대화에 auto/ask 권한이 열려 있으면 턴당 **정확히 1회** `provider_notice` 로
  "도구 호출 0회 + 적용되지 않는 권한 목록"을 알린다. 열린 권한이 0개면 아무 것도 띄우지 않는다.
  거부가 아니라 고지인 이유: Settings 기본값이 이미 여러 카테고리를 열어두므로 거부하면 텍스트 대화조차 못 한다.
- **거부된 턴에는 고지를 붙이지 않는다**(첨부·모델 거부가 이미 원인을 설명한다).
- sidecar 로그에 `toolNotice=<bool> tools=0` 을 남겨 사후 감사 가능.
- 증거: `scripts/browser-provider.test.ts` 26/26 통과(신규 5개), sidecar tsc 0, 프런트엔드 tsc 0,
  release gate 10 PASS(아래 갱신 참조).

남은 3번: ChatGPT 웹이 실제로 도구를 **요청**하는 계약(텍스트 프로토콜 정의 → 기존 권한 검사 경로 연결 →
허용·거부·프로젝트 범위 위반 각각 검증)은 착수하지 않았다. 지금 계약은 "도구 없음"이 정답이라는 확정이다.

### 남은 경계 (미검증)
- 설치본(K 의 실제 KDA), 프런트엔드 UI 클릭 경로(사람 눈 확인 필요).
- 3번의 "도구 요청을 실제로 받아 권한 경로로 넘기는" 부분, 4번(모델·effort·첨부·문맥) 전체.
- **대화 문맥**: `msg.history` 는 지금 브라우저 provider 로 전달되지 않는다(임시 대화 + 단발 전송).
  즉 두 번째 턴은 앞 턴을 모른다. 이건 아직 고지도 없다 → 4번에서 정책과 고지를 함께 정해야 한다.
- OAuth 최초 로그인 플로우(이번엔 이미 로그인된 프로필 재사용).
- 정지 시 부분 응답은 sidecar 가 late output 을 차단해 사라진다(기존 설계, 이번에 계약으로 명문화).
