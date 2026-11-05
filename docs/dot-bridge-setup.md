# 기존 DOT 구독으로 KDA 연결

이 문서는 구현 후보의 설정 절차다. 현재 설치본 및 실제 DOT 계정 연결은 검증 전이다. 음성통화는 ChatGPT DOT에서 사용하고, KDA는 지시·상태·정지 요청을 처리한다. 별도 음성 모델 API나 구독 토큰 추출을 사용하지 않는다.

## 준비와 연결

1. 이 연결기가 포함된 KDA 빌드에서 연결할 대화를 연다.
2. 오른쪽 위 `K 비서` 카드 하단의 `DOT 연결`을 펼쳐 `현재 대화 연결`을 선택한다. 최소화된 경우 ↗로 먼저 펼친다. 연결한 대화만 노출되며 탭을 바꿔도 대상은 고정된다. 기본은 꺼짐, KDA 프로세스를 재시작하면 재연결이 필요하다.
3. 표시된 `node ".../adapter.mjs" status --root ".../dot-bridge"` 명령을 DOT에 전달한다. 어댑터는 KDA 실행 파일에 내장되어 연결 시 새 세션 폴더에 생성된다. 개발 소스 폴더가 없어도 사용할 수 있다. Node는 KDA 설치의 기존 필수 도구다.
4. ChatGPT 데스크톱에서 DOT의 연결 PC가 **KDA가 실행 중인 PC**인지 확인한다. PC가 연결되지 않았으면 DOT 프로필 → Computers → 해당 PC → Allow access 절차가 필요하다. 이 권한은 기존 Codex/Work 권한과 별개다. 이번 개발 과정에서는 계정 연결이나 접근 권한을 변경하지 않았다.
5. DOT에게 아래 운영 지침과 명령을 전달한다. 먼저 무해한 상태 조회, 이후 승인한 짧은 명령, 실행 중 정지 순서로 실증한다. 실증 결과와 수신 확인을 남긴다.

## DOT에 전달할 지침

> KDA 연결 명령은 KDA가 실행되는 연결 PC의 로컬 작업에서 실행한다. 네 클라우드 컴퓨터에서 실행하지 않는다. 우선 KDA 화면에 표시된 상태 조회 명령을 실행한다. 반환된 session 및 result.conversationId를 사용하고, 요청마다 UUID request id를 하나 정해 보존한다. 지시의 내용이나 대상을 임의로 바꾸지 않는다. submitted는 작업 완료가 아니다. 결과는 status로 확인하고, latestAssistant가 이전 답변이거나 streaming이면 새 작업 완료라고 보고하지 않는다. 결과를 확인하지 못했으면 미확인으로 말한다. 타임아웃·끊김 때 새 UUID로 지시를 반복하지 말고 기존 session/id의 receipt와 실제 작업 상태를 확인한다. “멈춰”는 해당 대화의 stop 명령으로 전달하고 stopped 응답을 받은 후에만 정지 확인이라고 말한다. 분리된 외부 프로세스는 별도 확인이 필요하다. 연결과 작업 실행은 기존 승인 범위를 넓히지 않는다.

## CLI

아래 ADAPTER와 ROOT는 현재 KDA 연결 화면의 **정확한 절대 경로**, SESSION과 CONVERSATION은 status 반환값이다. 꺾쇠 값은 실제 값으로 대체한다.

```powershell
node "<ADAPTER>" status --root "<ROOT>"
node "<ADAPTER>" send --root "<ROOT>" --session "<SESSION>" --conversation "<CONVERSATION>" --id "<UUID>" --text-file "<UTF8_INSTRUCTION_FILE>" --mode steer
node "<ADAPTER>" stop --root "<ROOT>" --session "<SESSION>" --conversation "<CONVERSATION>" --id "<STOP_UUID>"
node "<ADAPTER>" receipt --root "<ROOT>" --session "<SESSION>" --id "<PREVIOUS_UUID>"
```

`steer`: 기존 KDA의 정지 확인→추가 지시 흐름. `queue`: 완료 후 예약. 정지는 대기 중인 send 뒤에 줄을 서지 않으며 오래된 미실행 지시는 취소된다. 단, 이미 발생한 파일 쓰기·클릭 등은 되돌리지 않는다. 새 지시로 작업을 명시적으로 재개할 때도 기존 승인/대화 잠금 규칙이 적용된다.

`pending` / `outcome_unknown`: 완료 응답 없음. 재실행 권고가 아니다. claim 기록은 재시작 후에도 같은 요청을 다시 실행하지 못하게 한다. 세션이 바뀌면 이전 세션 명령을 새 세션으로 자동 이관하지 않는다. 응답과 접수 기록은 보존하며 자동 정리하지 않는다.

## MCP 경로 — 선택적 후속 연동

같은 어댑터는 stdio MCP도 제공한다.

```text
node <ADAPTER> mcp --root <ROOT>
```

도구: `kda_status`, `kda_send`, `kda_stop`, `kda_receipt`. send/stop은 status에서 얻은 session·conversationId와 고정 requestId가 필수다. 발견/호출 프로토콜은 로컬 테스트했지만 실제 ChatGPT DOT이 이 서버를 직접 사용할 수 있는 계정별 등록 경로는 미검증이다. 사용자의 MCP 설정에 자동 등록하지 않았다. 공개 디렉터리의 로컬 MCP 플러그인 배포는 승인된 파트너 대상으로 제한되어 있으므로 단순 공개 설치를 약속하지 않는다.

## 동작 범위와 검증 한계

- 통신: 같은 Windows 사용자 안의 파일 IPC. 외부 포트/HTTP 서버·추가 클라우드 계정·모델 API 없음. 같은 사용자 권한의 프로그램까지 차단하는 보안 경계는 아니다.
- 노출: 연결한 대화의 실행/정지/예약 상태 및 마지막 AI 답변 최대 8,000자. 전체 대화 DB·다른 프로젝트 목록은 제공하지 않는다. 출력에는 시각·streaming 여부가 포함된다.
- 연결 끄기는 새 명령을 차단한다. 이미 실행 중인 작업의 취소와는 별개다. KDA가 꺼졌거나 heartbeat가 오래되면 새 명령을 접수하지 않는다.
- DOT→연결 PC 로컬 작업 위임에는 서비스 지연이 추가된다. 음성 끼어들기의 실제 응답 속도와 긴 작업 중 왕복은 아직 측정하지 않았다. 이 연결기만으로 음성 인식이나 즉시 정지를 검증했다고 하지 않는다.
- 설치·릴리스 전 승인은 별도다. 현재 소스의 기존 컴퓨터 제어 수정안도 설치본 적용 전이며, 외부 K-Personal-MCP 원본 수정은 이 연결기에 포함되지 않는다.

공식 근거: [DOT PC·앱 연결](https://learn.chatgpt.com/docs/dots/computers-and-apps), [사용량·작업 제어](https://learn.chatgpt.com/docs/dots), [로컬 MCP 배포 제한](https://developers.openai.com/plugins/deploy/desktop-only).
