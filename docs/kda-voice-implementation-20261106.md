# KDA 구독 음성통화 구현

최신 대상 규칙: `kda-voice-routing-20261106.md`. K의 후속 승인에 따라 v0.7.73은 현재 대화 따라가기·발화 시작 대상 고정·이름 전환을 사용한다. 아래 시작 대상 고정 설명은 v0.7.72 이력이다. GitHub 릴리스까지 승인됐으며 설치는 K가 직접 한다.

후속 상태: v0.7.72 릴리스의 완료 검증은 `evidence/release-v0772-20261106/final-verification.json`에 있다. 아래 v0.7.71·미배포 표기는 최초 구현 시점의 이력이다. 이후 장치 안내·음성 증폭 및 UI 단순화는 로컬 수정이며, 현재 상태는 `evidence/voice-device-fix-20261106/status.json`, `evidence/voice-output-20261106/audio-verification.json`, `evidence/simple-ui-20261106/status.json`을 따른다.

KDA 비서 카드의 `통화하기`는 내부 음성통화 영역을 연다. 별도 OpenAI API 키를 받지 않고 설치된 Codex 로그인으로 WebRTC 음성을 연결한다. 제품 소스 구현과 실제 구독 서버를 사용하는 합성 음성 시험을 수행했다. 설치본 v0.7.71에는 아직 적용하지 않았다.

## 동작

- 시작한 대화를 통화 종료까지 고정. 대화 탭 전환으로 제어 대상 변경 없음.
- 통화와 작업은 별도 수명. 상태 질문은 기존 작업을 유지하고 조회. 신규 명령은 기존 KDA 대기열, 명시적 방향 변경만 기존 steer 경로 사용.
- 현재 작업 정지와 전체 작업 정지는 기존 App 제어 경로 사용. 명확한 정지 발화는 최종 전사 후 같은 제어 게이트로 바로 접수하고, 뒤늦은 native 정지 위임은 실제 보류 상태를 조회해 중복 정지를 합친다. `말 그만해`는 음성만 중지. 접수·확인된 정지·완료·확인 불가를 구별. 분리 프로세스 종료를 추정하지 않음.
- 음소거, 말하기 중지, 현재/전체 작업 정지, 통화 종료, 입력/출력 장치 선택, 한국어 최종 자막. 새 통화는 기본 장치로 연결하고 종료 후 다른 장치로 재연결 가능.
- 통화 중 마이크 VAD와 서비스 전사 이벤트로 재생 음소거. 말하기 중지는 음성 출력에만 적용. 자연스러운 끼어들기·AEC와 실제 음향 지연은 실장치 시험 전까지 미검증.
- 확인된 상태 변경·새 최종 답변·Codex 승인 대기를 짧게 음성 전달. 코드·URL·키 형태·민감 필드가 있는 줄을 제거하고 본문 140자로 제한. 원음 파일과 통화 자막은 제품에서 저장하지 않음. 작업으로 접수된 명령과 결과는 기존 KDA 대화 저장 정책 적용.
- 한 번에 한 통화, 최대 5분. 종료·연결 실패·권한 거절·늦은 권한 응답에서 입력 트랙·오디오·데이터 채널·리스너·타이머 해제. 재연결에서 명령 자동 재전송 없음. 통화 중 idle 자동 업데이트 대기.

## 확인된 프로토콜과 실행 소유권

설치 CLI 0.164.0의 ChatGPT 인증 WebRTC는 **v3**를 사용한다. 실험한 v2 WebRTC는 `AVAS realtime calls require realtime v1 or v3`, v2 WebSocket은 `realtime conversation requires API key auth`로 거절됐다. 초기 v2 연결 시도는 성공한 구현으로 취급하지 않는다. 실제 v3 연결은 SDP 응답·`session.started`·입출력 전사·RTP 음성 수신으로 확인했다.

v3는 일반 Realtime의 `session.update {type: realtime, tools: ...}` 형식을 받지 않는다. 해당 형식은 `unknown_parameter: session.type`로 거절됐다. 최종 구현은 **Codex v3의 기존 위임 → 제한된 중계 스레드의 단일 dynamic tool `kda_control` → KDA 기존 제어 경로**다. 새 작업을 전사문으로 중복 실행하지 않는다. 명확한 정지·출력 중지 제어는 위의 최종 전사 제어를 사용한다. `clientManagedHandoffs`를 실행 소유권 이전 옵션으로 오해하지 않는다.

음성 중계 스레드는 ephemeral, read-only sandbox, untrusted approval 정책으로 만들고 응답 정책을 재확인한다. 해당 스레드에만 기존 MCP 비활성화·shell/patch/multi-agent 등 기능 비활성화를 요청한다. 전역 Codex 설정·인증 파일은 변경하지 않는다. 중계기가 직접 실행·파일변경·MCP 또는 승인 요청을 내면 실패 처리한다. 실제 일은 KDA의 기존 메시지·승인·프로젝트 제어에서 수행한다.

dynamic tool 요청은 임의의 UI 대화 ID를 받지 않는다. 세션·대상 대화·단일 사용 토큰·15초 유효기간으로 묶고 중복·만료·종료 뒤 명령을 폐기한다. 토큰 수신 영수증과 실제 작업 완료를 구별한다. 상태 데이터는 음성 백엔드에 결과로 반환하고 진행 메시지는 `appendSpeech`로만 전달한다. 계정 토큰·SDP·원음은 로그에 기록하지 않는다.

공식 근거: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Voice](https://learn.chatgpt.com/docs/features/voice), [GPT-Live 서버 제어](https://developers.openai.com/api/docs/guides/voice-server-controls). 설치 버전 스키마와 해당 버전의 실제 소스는 `evidence/voice-research-20261106/`에 보존했다. 일반 API 문서와 구독 CLI의 실제 프로토콜 차이는 위 실행 증거를 기준으로 처리했다.

## 검증 증거와 제한

`evidence/voice-implementation-20261106/`에 개별 실행 결과·로그·최종 상태를 보존한다.

- 실제 구독 서버 + 합성 한국어 입력 + fixture 작업 핸들러. 상태 질문을 인식하고 실제 status 호출. 시험 상태의 `37%·빌드 진행 중`을 반영한 한국어 응답과 RTP 음성 수신 확인.
- 같은 통화의 작업 예약·상태 조회·정지 호출, 새 작업 queue 모드, 의도하지 않은 steer 없음, 종료 후 입력 트랙 해제 확인. 시험 핸들러는 실제 문서·앱을 만들지 않음.
- 단독 정지 시험에서 AI가 정지 의향만 말하고 KDA를 호출하지 않은 사례를 확인했다. 최종 전사 제어 보강 후 `native-probe-014601.json`에서 실제 stop 호출 1회, `stopped` 영수증, “네, 지금 하던 건 멈췄어요” 응답과 RTP 음성 수신을 확인했다. 전체 결과는 `final-verification.json`에서 판정.
- 실행 코드 회귀검증: 상태 조회와 작업 수명 분리, 중복·대상·만료·정지·전체 정지·승인 보존, 잘못된 native 요청 거절, 마이크 권한 지연/거절/해제, 기존 streaming 답변의 최종 피드백.
- 실제 App JSX 핸들러를 추출해 대상 대화·조회·정지 실패·전체 정지·승인 대기 분리 검증. 내부 통화 UI 및 기존 카드 UI 14개 headless 검사.
- 전체 release gate에서 sidecar·frontend·cargo 및 기존 회귀검사 수행. 최초 App 테스트 의존성 실패는 수정 후 다시 전체 검증. 최초 실패 로그도 보존.

실제 마이크/스피커·한국어 자연발화·TV/스피커 에코·실제 음향 끼어들기 지연·설치된 WebView2의 마이크 권한 및 음성 왕복·실제 KDA 작업을 포함한 통화는 **미검증**이다. 합성 음성+시험 핸들러 성공을 DOT와 모든 면에서 동등한 사용성이나 p95 지연 통과로 확대하지 않는다.

태그 push·릴리스·설치·키 변경은 수행하지 않았다. 현재 설치본의 기존 ChatGPT 링크 동작은 다음 배포 적용 전까지 유지된다.
