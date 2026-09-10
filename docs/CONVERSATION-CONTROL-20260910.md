# 대화별 실행 제어 보강 — 2026-09-10

## GitHub 릴리즈 통합 — v0.7.33

최종 게시 버전은 **v0.7.34**다. 0.7.33 Actions run `34441116726`은 빌드 후 라우팅 검사에서 35/36으로 차단되어 설치 asset을 게시하지 못했다. 새 terminal 규약은 실패 시 error 한 번이며, 예전 테스트의 error + done 이중 이벤트 기대를 수정해 36/36으로 재검증했다. 전체 로컬 게이트도 빌드 후 회귀 실행 순서로 변경했다. 아래 초기 전체 게이트 보고의 0 SKIP은 상위 그룹 집계였고, 실제로는 dist 생성 전 런타임 스탬프 6건이 생략됐으므로 최종 증거로 사용하지 않는다. 0.7.34 결과는 `evidence/gate-0.7.34-full.log`에서 확인한다. 추가 Windows 프로세스 정지 재검증은 `evidence/conversation-smoke-2JAA0W/result.json`의 8/8 PASS다.

초기 구현은 0.7.21 기반이었다. GitHub 최신 0.7.32에 통합하면서 대화별 provider·세션 컬럼, 이벤트의 conversation_id, 폴더 지침과 기존 메시지 소속 보호를 보존했다. 정지 후 agentId 저장과 새 세션 시작은 원래 대화의 provider 컬럼을 사용한다. 예약 시점의 대화별 설정 스냅샷을 실제 전송에도 적용한다.

무응답 타이머는 종료 증거가 아니므로 작업 잠금을 유지한다. task-watch의 오래된 항목 회수도 현재 실행 소유자가 있으면 보류한다. CI의 기존 라우팅 검사가 강제 잠금 해제를 요구하던 부분을 변경된 정책에 맞춰 수정했다.

릴리즈에는 KDA 소스·테스트·문서만 포함한다. 로컬 evidence, 모의 사용자 홈, 설치 파일과 외부 프로젝트 산출물은 커밋하지 않는다. 기존 v0.7.4 태그가 원격과 달라 전체 태그 fetch가 거부된 상황에서는 태그를 이동하지 않고 `git fetch --no-tags origin main`으로 최신 소스를 확인했다.

0.7.33 통합본 사전 검증: 전체 release gate 9 PASS / 0 WARN / 0 FAIL / 0 SKIP. 회귀 24개 파일(집계 형식을 제공한 검사 263/263), frontend tsc·Vite build, sidecar tsc, cargo check 통과. 모의 CLI 실제 Windows 프로세스 검사 8/8(`evidence/conversation-smoke-D2p9sq/result.json`), 정적 UI 6/6, SQLite 메시지 소속 검사 통과. 해당 경로는 릴리즈 통합 worktree 기준이다. 실행 중 설치본은 게시 전 실측 0.7.32이며 설치본 교체·인앱 업데이트는 별도로 확인해야 한다.

K의 요청: 작업 중 추가 지시·방향 변경, 정지 버튼 신뢰성, 여러 대화 동시 실행 시 오염 방지와 필요한 UI 변경.

## 적용한 동작

- 입력창은 작업 중 `추가 지시 · 질문`과 `완료 후 예약`을 구분한다. 기본은 추가 지시다.
- 추가 지시는 접수 안내 → 기존 실행 정지 요청 → 실제 종료와 대화 저장 확인 → 기존 대화의 맥락·도구 결과를 포함한 새 실행 순서다. 고정 200ms 타이머를 제거했다.
- 추가 지시가 처리되기 전에 사용자가 다시 정지하면 실행 세대 번호로 뒤늦은 재개를 차단한다. 정지 확인 실패 시 추가 지시를 보관하고 자동 재시도하지 않는다.
- 일반 예약은 대화별 FIFO로 보관한다. 두 번째 입력이 첫 예약을 덮지 않는다. 엔진·권한 설정은 예약 시점의 스냅샷을 사용한다.
- 현재 대화 정지는 해당 대화의 실행과 자동 이어가기를 보류한다. 전체 정지는 모든 실행과 자동 발화를 보류한다. 예약은 취소하거나 명시적으로 이어서 전송할 수 있다.
- 대화 전환 후에도 실행 소유자로 정지 대상을 찾는다. 프로세스 종료가 확인되지 않으면 실행 잠금을 유지하고 정지 재요청을 제공한다.
- 상단 작업 현황에서 대화별 진행, 최근 갱신, 예약 개수, 정지·재개를 확인한다. 입력 초안과 첨부 초안도 대화별로 분리한다.

## 격리와 종료 보장

- 프론트엔드는 실행 ID의 원래 대화와 현재 소유권을 확인한다. 알 수 없거나 오래된 이벤트를 현재 열린 대화로 보내지 않는다. 소속 없는 이벤트는 내용 없이 종류·ID만 진단 로그에 기록한다.
- sidecar는 엔진의 `done` 이벤트만으로 실행 잠금을 풀지 않는다. 핸들러와 프로세스, 오케스트레이션 하위 실행이 끝난 뒤 터미널 이벤트를 보낸다.
- 실제 프로세스 테스트에서 기존 종료 이벤트 등록 순서의 결함을 재현했다. stdout 소비와 후처리 중 `close`가 먼저 발생하면 그 뒤 등록한 리스너는 영원히 기다릴 수 있었다. `observeProcessClose`를 세 CLI의 spawn 직후 연결해 해결했다.
- 안전 모드와 안전 알림의 실행 ID는 `AsyncLocalStorage`로 분리했다.
- 같은 프로젝트 기본 경로 또는 엔진 세션을 공유하는 실행은 자원 점유가 끝날 때까지 대기한다. 상위·하위 경로도 충돌로 취급한다. 다른 프로젝트는 병렬 실행한다.
- DB의 메시지 upsert는 기존 메시지의 대화 ID를 변경하지 않는다. 소속이 다르면 저장을 실패시킨다. 대화별 저장 순서도 직렬화해 늦은 부분 응답이 최종 응답을 덮는 것을 막는다.
- task-watch의 명시적인 원래 대화가 사라졌다면 다른 대화로 재귀속하지 않는다. 백그라운드 주입도 전송 직전 실행 소유권·프로젝트 지침을 확인한다.
- 자동 복구는 원래 대화에 전달하며 현재 화면으로 이동하지 않는다. 메모리 압력·무응답 타이머만으로 실행 잠금을 임의로 풀지 않는다.
- 실행 또는 예약이 있는 대화의 삭제·프로젝트 폴더 변경을 보류한다.

## 이번 구현의 경계

- 세 CLI에 실행 중 텍스트를 직접 주입하는 네이티브 steering은 구현하지 않았다. 이번 버전은 종료 확인 후 맥락을 보존해 재개하는 공통 방식이다. UI에도 이 방식을 표시한다.
- 이미 완료한 파일 변경·외부 요청을 자동으로 되돌리지 않는다. 새 실행은 진행 상태를 확인하도록 지시받지만 외부 서비스의 작업 중복까지 완전히 보장하지는 않는다.
- 분리된 작업 스케줄러·원격 SSH·렌더링 프로세스 등 KDA 프로세스 트리 밖 작업은 정지 완료의 범위에 포함하지 않는다. 별도 작업 소유권 등록·취소 API가 다음 단계다.
- 자원 충돌 제어는 전달된 프로젝트 기본 경로와 세션 기준이다. 선언 범위 밖 파일, 다른 KDA 인스턴스, 외부 앱의 공유 브라우저 탭까지 잠그지는 않는다.
- 실행 현황과 예약 내용은 현재 앱 세션 범위다. 수동 정지에 따른 대화별 자동 실행 보류 상태는 localStorage로 유지한다. 앱 재시작 후 예약 내용·첨부를 복원하는 영속 큐는 다음 단계다.
- 테스트는 소스·격리 프로세스·헤드리스 UI 기준이다. 설치본 교체, 릴리즈, 자동 업데이트, 실제 계정의 유료 모델 호출은 수행하지 않았다.

## 검증

- `node sidecar/test-conversation-control.mjs`: 실행 제어·대화 격리·종료 이벤트 순서·저장 순서 회귀 18개.
- `node sidecar/node_modules/tsx/dist/cli.mjs scripts/conversation-turn-gate.test.ts`: 기존 단일 실행 게이트.
- `node scripts/smoke-conversation-control.mjs`: 빌드된 sidecar와 모의 CLI/실제 Windows 프로세스 트리 검사 8개. 세 CLI의 정지 후 실제 PID 부재, 다른 대화 생존, 공유 경로 대기 취소, 조기 완료 이벤트, 후속 실행을 검증한다. 모의 홈·설정·메모리를 사용하며 실제 모델 API는 호출하지 않는다.
- `node scripts/build-conversation-control-preview.mjs` 후 `py scripts/verify-conversation-control-ui.py`: 프로덕션 UI 컴포넌트의 초안 복원·예약 분리·전송 모드·정지 표시·작업 현황·브라우저 오류 검사 6개. 정적 file 페이지를 헤드리스 Chromium으로 열며 개발 서버는 사용하지 않는다.
- `py scripts/verify-message-ownership.py`: 실제 production SQL을 메모리 SQLite에서 실행해 다른 대화로의 덮어쓰기를 거부하는지 확인한다.
- 프론트엔드·sidecar TypeScript, 프로덕션 Vite 빌드, `release:gate --fast`.
- 빠른 게이트는 환경 의존 MCP 검사와 cargo check를 생략한다. 이번 변경에 Rust 코드 수정은 없다.

검증 과정에서 발생한 실행기 문제: Windows Node `--import`에는 `pathToFileURL`이 필요하고, ESM의 `os.homedir`를 테스트용으로 대체할 때는 `syncBuiltinESMExports`까지 호출해야 namespace import도 격리된다. PowerShell의 긴 인라인 Node 코드도 `.mjs` 파일 실행으로 대체했다. 실패 산출물과 수정 후 증거는 `evidence/`에 보존한다.

초기 프로세스 테스트의 홈 격리 오류로 실제 사용자 홈 기준 statusLine 초기화와 기존 메모리 동기화가 실행됐다. 해당 로그는 `GitSync ... no-change`, `push 생략`을 기록했다. 사용자 런타임 파일이 전혀 쓰이지 않았다고 보장할 수는 없다. 이후 `syncBuiltinESMExports`를 적용하고 테스트가 격리 설정(`anthropicRatePollingEnabled=false`)을 실제로 읽었는지 단언하도록 추가한 뒤 전체 프로세스 테스트를 다시 통과했다.

최종 증거:
- 프로세스 8/8: `evidence/conversation-smoke-LfFt3b/result.json`
- UI 6/6: `evidence/conversation-control-ui/result.json`, `desktop.png`, `compact.png`
- 회귀 게이트: `evidence/conversation-control-gate-verified.log` — 6 PASS / 0 WARN / 0 FAIL / 3 SKIP
- 프로덕션 빌드: `evidence/conversation-control-build.log` — exit 0
