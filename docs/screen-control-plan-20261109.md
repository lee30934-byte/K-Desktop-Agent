# KDA 화면 제어 신뢰성 계획 (Opus 5.5 토의 종합, 2026-11-09)

**KDA 화면 제어 최종 계획 (심판 판정)**

**사실 확인 결과**
- 실제 작업 코드는 worktree `C:/Users/lee30/Documents/K-Desktop-Agent/.worktrees/control-results-20261105`에 있다. 브랜치는 fix/control-results-20261105, 버전은 v0.7.81이다. main(a669e6a, 0.7.31)에는 `toolBridge.ts`가 아예 없다. 따라서 구현은 이 worktree 기준이고, main 병합 여부는 따로 정해야 한다.
- 양측 주장 중 코드와 맞는 것:
  - bundled-mcp 안에 isError가 하나도 없다.
  - `computer_control.py`는 162행에서 typewrite를 쓰고, 176행 except에서 오류를 평범한 텍스트로 돌려준다.
  - `server.py` 185행은 모르는 도구도 텍스트로 돌려준다.
  - `mcpClient.ts`의 기본 요청 타임아웃은 30초(62행)이다.
  - `toolBridge.ts`는 timeoutMs 없이 callTool을 부르고, 그 외 MCP 메서드는 "Unsupported MCP method"를 던지며, known 집합에 없는 도구는 거부한다.
  - Codex bridge는 101행에서 120초 뒤 자동 거부하고, 180~189행에서 on-request와 danger-full-access로 시작한다.
  - Claude는 `index.ts` 2052행 buildMCPConfig가 PYTHON_EXE로 server.py를 직접 띄운다. bridge를 거치지 않는다.
  - idle 상수는 둘 다 60분이다.
  - hooks는 overwriteGuard와 pitfallGuard 두 개뿐이다.
- A의 "bridge 큐에 타임아웃이 없다"는 틀렸다. A도 반론에서 철회했다.
- 프론트에는 `CodexElicitationDialog.tsx`와 `ApprovalRequests.tsx`가 있다. 승인 대화상자 UI 자체는 존재한다. 실제로 화면에 뜨는지는 확인하지 않았다.

**(1) 합의된 핵심 원칙**
1. 원인 계측이 먼저다. 멈춤 원인을 분류하기 전에는 watchdog 값과 approvalPolicy를 바꾸지 않는다.
2. 결과 판정은 모델이 쓴 문장이 아니라 실행 영수증으로 한다. 실패는 MCP 표준 신호(isError)로 보낸다.
3. 엔진과 무관한 불변식(잠금, 대상 창 확인, 사후 검증)은 맨 아래층 k-personal에 둔다. KDA의 Claude, Codex, 그리고 KDA 밖 플러그인 경로가 모두 같은 서버를 쓰기 때문이다.
4. "ui_*를 먼저 시도하라"는 순서 강제는 뺀다. 대신 "대상 확인 + 결과 검증"을 강제한다.
5. 셸 우회는 엔진마다 다르게 다룬다.
   - Claude: 실행 전 차단(PreToolUse 훅)
   - Codex: 탐지, 영수증 표시, 필요 시 중단
   - 완전 차단은 불가능하다고 명시한다.
6. 무진행 감지는 화면 작업 턴 전용 상수로 둔다. "승인 대기"와 "무응답"을 구분하고, kill은 사용자 확인 후에만 한다.

**(2) 최종 구조**
- **L0: k-personal (`server.py`와 modules)**
  - 모든 실패를 isError로 보낸다.
  - 입력 점유 도구(cc_mouse_*, cc_keyboard_*, clip_paste_at, cc_focus_window)를 한 실행 함수로 묶는다.
  - `Local\KDA-desktop-input` 뮤텍스를 2~5초 대기로 잡는다. abandoned 상태는 정상 획득으로 보고 로그만 남긴다.
  - target_window를 필수로 받고, 입력 직전에 GetForegroundWindow로 확인한다.
  - 실행 후 expect 인자로 사후 조건을 본다. expect가 없으면 포그라운드/포커스 자동 확인으로 대신한다.
  - 판정은 verified / unverified / failed다. failed는 isError로 보낸다.
  - 도구 계열별 내부 하드 타임아웃을 둔다. bridge가 30초에 포기해도 Python 쪽 고아 작업이 뮤텍스를 붙잡지 않게 하려는 것이다.
  - 한글 입력은 SendInput 유니코드나 클립보드 붙여넣기로 보낸다.
- **L1: toolBridge (KDA 턴 정책)**
  - Claude와 Codex가 모두 거치게 한다.
  - 계열별 timeoutMs, ledger.jsonl 기록, 도구 시작/종료 진행 이벤트를 넣는다.
  - 기존 denied 강제는 그대로 둔다.
- **L2: sidecar**
  - 화면 작업 턴의 무진행 감지와 대기 사유 표시
  - 턴 종료 시 ledger를 읽어 실행 영수증 카드를 모델 답변과 분리해 표시
  - Claude 셸 차단 훅(desktopGuard)
  - Codex commandExecution 탐지
  - desktop-input lease는 루트 턴의 보조 장치로만 쓰고, 오케스트레이션 하위 턴에는 걸지 않는다(교착 방지).

**(3) 단계별 구현 계획**

**0단계: 진단 (코드 변경은 로깅만)**
- 변경 파일: `codex-app-server-bridge.mjs` (수신 method와 시각 로깅, 이미 있는 diagnostic 이벤트 확장)
- 검증 방법: 같은 화면 제어 요청을 Codex로 5회 재현한다. 각 회차의 마지막 이벤트를 다음 중 하나로 분류한다.
  - tools/list에 k-personal 도구가 없음
  - 도구 호출 자체가 없음
  - elicitation/approval 대기 (대화상자가 실제로 떴는지 함께 기록)
  - app-server 정지
- 완료 기준: 5회 모두 분류가 끝난 표. 결과에 따라 1~4단계 순서를 조정한다.

**1단계: 정직한 실패**
- 변경 파일: `bundled-mcp/server.py`(185행 미지원 도구 경로), `modules/*.py`의 handle_tool except 경로, `computer_control.py`의 cc_keyboard_type
- 검증 방법: `test_modules.py`에 없는 창, 범위 밖 좌표, 잘못된 도구 이름 케이스를 넣고 isError=true를 단언한다. 메모장에 "안녕 abc"를 입력한 뒤 ui_get_text로 실제 값이 같은지 확인한다.
- 완료 기준: 실패 경로가 성공으로 나가는 경우 0건, 한글 입력 일치.

**2단계: 무진행 가시화**
- 변경 파일: `toolBridge.ts`(stderr 진행 이벤트, 계열별 timeoutMs: ui_ 20초, cc_ 15초, web_ 45초), `index.ts` heartbeat/idle(화면 작업 턴 전용 상수: 90초 경고, 180초에 사용자 확인 후 중단), 프론트 대기 사유 표시
- 검증 방법:
  - elicitation에 응답하지 않고 두면 "승인 대기"가 표시되는지 확인한다.
  - 일부러 무진행 상태를 만들면 90초 안에 경고가 뜨는지 확인한다.
  - 테스트용 sleep 도구를 넣었을 때 큐가 타임아웃 후 다음 요청을 처리하는지 확인한다.
- 완료 기준: 위 세 시나리오가 통과하고, 화면 작업이 아닌 턴에서는 오탐 0건.

**3단계: L0 거래 계층**
- 변경 파일: `computer_control.py`(공통 실행 함수: 뮤텍스, target_window, 포그라운드 확인, expect, 판정), `server.py`(내부 하드 타임아웃), `app_launcher` 안의 clip_paste_at
- 검증 방법:
  - 두 MCP 프로세스에서 동시에 입력하면 한쪽이 대기하거나 isError를 받고, 입력이 섞이지 않는지 확인한다.
  - 대상 창이 가려진 상태에서 failed가 나오는지 확인한다.
  - 프로세스를 강제 종료한 뒤 abandoned 뮤텍스를 다시 획득할 수 있는지 확인한다.
- 완료 기준: 위 세 테스트를 자동화하고 통과. 플러그인 경로에서도 같은 결과.

**4단계: 경로 통합과 영수증**
- 변경 파일: `index.ts` buildMCPConfig(createToolBridge의 launch로 교체), `toolBridge.ts`(필요한 비 tools 메서드 pass-through, ledger.jsonl), `index.ts` 턴 종료 시 영수증 이벤트, 프론트 영수증 카드
- 선행 조건: Claude가 resources, prompts, notifications, elicitation을 실제로 쓰는지 먼저 확인한다.
- 검증 방법:
  - Claude 턴 프로세스 트리에서 python의 부모가 node bridge인지 확인한다.
  - denied 도구가 Claude 턴에서도 거부되는지 확인한다.
  - ledger 호출 수와 엔진 쪽 tool 이벤트 수가 같은지 대조한다.
  - "완료했다"고 답했지만 expect가 실패한 시나리오에서 영수증이 failed로 표시되는지 확인한다.
- 완료 기준: 화면 작업이 아닌 Claude 턴(fm_*, db_*, web_*) 회귀 0건.

**5단계: 셸 우회**
- 변경 파일: 새 파일 `sidecar/hooks/preToolUse-desktopGuard.mjs`(기존 pitfallGuard 배선 재사용; 저렴하므로 1단계 직후로 당겨도 된다), `codex-app-server-bridge.mjs` item/started의 commandExecution 패턴 탐지 → 영수증 표시와 선택적 turn/interrupt
- 검증 방법: 다음 3건을 Claude와 Codex 각각으로 시도한다.
  - PowerShell SendKeys
  - Add-Type user32 SetCursorPos
  - python -c pyautogui

  추가로 -EncodedCommand 변형과 "Write로 파일을 만든 뒤 실행" 변형의 탐지 누락률을 기록한다.
- 완료 기준: Claude는 3건 모두 실행 전 거부, Codex는 3건 모두 영수증에 표시. 한계를 문서로 남긴다.

**(4) 버린 아이디어와 이유**
- **ui-first 상태 머신**: 형식적인 ui_find 한 번이면 통과된다. UIA를 지원하지 않는 앱에서는 왕복만 늘고, 플러그인 경로에는 걸리지도 않는다.
- **bridge 큐 타임아웃 추가를 1순위로 두기**: 전제가 틀렸다. 30초 기본 타임아웃이 이미 있다.
- **뮤텍스 획득 실패 시 즉시 거부**: 오케스트레이션의 정상 경쟁까지 실패로 만든다. 짧은 대기 후 isError로 바꾼다.
- **화면 해시만으로 changed 판정**: 시계, 커서 깜빡임, 애니메이션 때문에 오탐한다. 증거로만 붙이고 판정 근거로 쓰지 않는다.
- **Codex approvalPolicy 강화를 지금 확정**: 승인 대기가 멈춤 후보 중 하나라 증상을 악화시킬 수 있다. 0단계 결과를 본 뒤 K가 정한다.
- **watchdog 상수를 먼저 줄이기**: 원인을 가린다. 0단계 이후 모드별 상수만 추가한다.
- **ExecutionLeases를 호출 단위 입력 잠금으로 쓰기**: sidecar 메모리에만 있어서 자식 프로세스에서 닿지 않는다.

**(5) 남은 미확인 사항**
1. 멈춤의 실제 원인 (0단계에서 판정).
2. CodexElicitationDialog가 cc_* 승인 요청을 실제로 화면에 띄우는지.
3. Claude CLI가 MCP의 resources, prompts, notifications, elicitation 중 무엇을 쓰는지 (bridge 전환 시 회귀 범위).
4. pyautogui.typewrite가 한글을 건너뛰는지 (실측하지 않음).
5. 이 worktree 브랜치와 main의 병합 계획. toolBridge가 main에는 없다.
6. SetForegroundWindow 제한 때문에 대상 창 활성화가 실패하는 비율.
7. 0단계 결과 이후 화면 작업 턴의 sandbox/approval 정책을 바꿀지 (K 결정).

근거 파일 (worktree 기준):
- `C:/Users/lee30/Documents/K-Desktop-Agent/.worktrees/control-results-20261105/sidecar/src/toolBridge.ts`
- `C:/Users/lee30/Documents/K-Desktop-Agent/.worktrees/control-results-20261105/sidecar/src/index.ts` (2052, 2202-2205, 4723)
- `C:/Users/lee30/Documents/K-Desktop-Agent/.worktrees/control-results-20261105/sidecar/src/codex-app-server-bridge.mjs` (101, 180-189)
- `C:/Users/lee30/Documents/K-Desktop-Agent/.worktrees/control-results-20261105/bundled-mcp/server.py` (185)
- `C:/Users/lee30/Documents/K-Desktop-Agent/.worktrees/control-results-20261105/bundled-mcp/modules/computer_control.py` (162, 176)
- `C:/Users/lee30/Documents/K-Desktop-Agent/sidecar/src/mcpClient.ts` (62, 317)

---
## 원자료
```json
{
 "A": {
  "thesis": "강제는 한 곳에 몰아야 한다. 지금 Codex는 toolBridge를 거치고 Claude는 k-personal을 직접 부른다(index.ts 2052 buildMCPConfig가 PYTHON_EXE와 K_PERSONAL_PATH를 그대로 넘김). 이 상태에서는 어떤 관문을 만들어도 Claude 쪽에서 새어 나간다. 그래서 (1) 두 엔진 모두 toolBridge를 거치게 하고, (2) 전체 프로세스에 걸친 입력 점유 잠금과 사전·사후 검증은 가장 아래층인 k-personal server.py에 두고, (3) 셸 우회는 Claude는 PreToolUse 훅으로 거부하고, Codex는 화면 작업 턴만 approvalPolicy를 바꿔 실행 전 관문을 만들어야 한다. 이 셋이 갖춰져야 '구조적 강제'라고 말할 수 있다. 다만 셸 우회를 100% 막을 수는 없다. 탐지 후 중단과 최소 권한을 조합하는 것이 현실적인 상한이다. 추가로, 멈춤의 원인을 아직 조사하지 않았다. 관문보다 계측(Phase 0)이 먼저다.",
  "architecture": "[코드로 확인한 사실]\n- sidecar/src/toolBridge.ts(46줄): denied 집합을 tools/list와 tools/call 양쪽에서 강제하고 요청은 queue로 직렬화한다. 다만 정책이 시작할 때 정해지는 정적 denied 목록뿐이다. 턴 상태(ui_* 선시도 여부 등), 타임아웃, sidecar로 돌아가는 IPC 채널은 없다. 그래도 관문을 붙일 자리로는 적합하다.\n- sidecar/src/globalTools.ts createToolBridge: Codex(-c mcp_servers.k-personal.*)와 Gemini는 bridge를 쓴다(index.ts 4723 turnToolBridge, 4892, 6159).\n- Claude: index.ts 3491 buildMCPConfig → --mcp-config로 python server.py를 직접 연결한다. bridge를 거치지 않는다는 점은 확인했다. 강제 수단은 --disallowed-tools와 hooks/preToolUse-overwriteGuard.mjs, pitfallGuard.mjs뿐이다.\n- executionLeases.ts: sidecar 프로세스 안의 메모리 Map이다. dispatchRootTurn(index.ts 7011)에서 턴 단위로 session:/workspace: 키를 잡는다. 엔진 하위 프로세스(MCP server, bridge)는 이 lease에 닿을 수 없어서, 도구 호출 단위의 입력 잠금에는 그대로 못 쓴다. 턴 단위로 'desktop-input' 키를 잡는 데는 쓸 수 있지만 범위가 너무 거칠다(화면 작업 턴끼리 통째로 직렬화됨).\n- codex-app-server-bridge.mjs: 스레드를 approvalPolicy on-request와 sandbox danger-full-access로 시작한다(281~290). commandExecution 승인 요청은 처리하지만, danger-full-access에서는 모델이 권한 상승을 요청하지 않는 한 명령이 승인 없이 실행된다. 그래서 셸 우회는 현재 실행 전 관문이 없다. MCP 호출 승인은 mcpServer/elicitation/request로 들어온다. 자동 승인되는 것은 essentialApprovals와 읽기 도구 목록(readConfirmationTools)뿐이고, cc_mouse_click 같은 쓰기 도구는 K 응답을 기다리며 120초 타이머가 돈다. 멈춤 원인 후보지만 검증하지는 않았다.\n- index.ts 2202~2205: DEFAULT_TURN_IDLE_TIMEOUT_MS와 ACTIVE_TOOL_TIMEOUT_MS가 둘 다 60분이다. 화면 작업 멈춤 감지로는 쓸 수 없다.\n- toolSafety.ts: dimensions.controlsInput 표가 있다. 관문의 분류 원천으로 재사용할 수 있다.\n\n[제안 구조: 3층]\nL0 k-personal server.py, 엔진·호출자와 무관한 불변식. KDA 밖 Claude Code 플러그인 경로도 같은 서버를 쓰므로 여기 두면 모든 경로가 덮인다.\n - 입력 점유 잠금: Windows named mutex(Global이 아니라 Local\\KDA-desktop-input) 또는 lock file과 PID. cc_mouse_*, cc_keyboard_*, clip_paste_at, cc_focus_window를 호출할 때 획득하고, 실패하면 즉시 오류를 낸다(대기하지 않음). 프로세스가 둘(Claude 직결과 Codex bridge 뒤 python)이라 프로세스 내부 lock으로는 부족하다.\n - 포그라운드 검증: cc_* 입력 계열 인자에 target_window(title 또는 hwnd)를 필수로 둔다. 입력 직전에 GetForegroundWindow로 비교해서 다르면 거부한다.\n - 사후 상태: 입력 후 300~800ms 안에 포그라운드 창, 포커스 컨트롤(UIA), 선택적으로 축소 스크린샷 해시를 반환한다. 변화가 없으면 changed:false를 명시한다. 모델이 '성공했다고 믿고' 다음 단계로 가는 것을 막는 핵심이다.\n - 호출별 하드 타임아웃(예: ui_* 20초, cc_* 10초): 오래 걸리는 UIA 트리 순회 등이 서버를 붙잡지 못하게 한다.\nL1 toolBridge.ts, 턴 정책(KDA 턴에만 적용).\n - Claude도 bridge를 거치게 바꾼다: buildMCPConfig 대신 createToolBridge 결과를 --mcp-config의 command/args로 넣는다. Claude의 도구 이름 접두어 mcp__k-personal__는 서버 이름 키가 그대로라 유지된다. 그러면 denied 강제 지점이 하나로 합쳐진다.\n - 턴 상태 머신: 같은 bridge 프로세스가 턴 수명 동안 살아 있으므로 메모리 상태로 충분하다. 'ui-first' 규칙은 같은 target 창에 ui_find/ui_dump_tree/ui_list_windows를 시도한 기록이 없으면 cc_mouse_click/cc_keyboard_*를 거부하고 오류 메시지로 다음 행동을 안내한다. 예외는 UIA가 트리를 못 주는 창(ui_* 결과 empty 또는 error 기록)이다. 프롬프트가 아니라 거부 응답으로 유도하는 방식이다.\n - 호출 감사 이벤트: bridge stderr나 별도 fd로 {tool, target, 결과, 소요} JSONL을 내보내고 sidecar가 수집한다. 지금은 bridge에서 sidecar로 가는 채널이 없어서 새로 만들어야 한다.\n - 호출 시간 한도: callTool에 Promise.race로 타임아웃을 건다. 지금은 큐가 직렬이라 호출 하나가 멈추면 이후 전체가 멈춘다.\nL2 sidecar, 셸 우회와 멈춤 감시.\n - '화면 작업 턴' 판정: K 의도 분류에 의존하지 않고, 해당 턴의 permissions에서 cc_*가 허용되어 있으면 desktop 모드로 본다.\n - Claude: hooks에 preToolUse-desktopGuard.mjs를 추가한다. Bash/PowerShell 명령에서 SendKeys, user32(SetCursorPos, mouse_event, keybd_event, SendInput), pyautogui, AutoHotkey, nircmd, wscript, Add-Type 다음 DllImport 같은 패턴을 거부한다(exit 2와 stderr 안내). 기존 pitfallGuard와 같은 배선이다.\n - Codex: desktop 모드 턴만 approvalPolicy를 untrusted 계열(모든 명령 승인 요청)로 바꾸거나, 최소한 commandExecution item/started를 감시해 패턴이 맞으면 turn/interrupt를 건다. 앞의 것은 실행 전 차단이고, 뒤의 것은 실행 후 중단이다. 앞의 것을 쓰면 승인 요청이 많아지므로, bridge에서 읽기 전용 명령 화이트리스트는 자동 승인하고 패턴 매칭은 자동 거부하고 나머지만 K에게 묻는다.\n - 멈춤 watchdog: 기존 heartbeat와 idle 구조(emitTurnHeartbeat)를 재사용하되, desktop 모드에서만 별도 한도를 둔다. 예를 들어 '모델 출력과 도구 이벤트가 모두 없음 90초'면 경고를, 'elicitation이나 approval 대기 중'이면 대기 사유를 UI에 표시한다(멈춤과 대기를 구분). 180초면 사용자 확인 후 interrupt한다. 60분 상수는 그대로 두고 모드별 상수만 추가한다.\n - ExecutionLeases 재사용: 같은 conversation이나 workspace 직렬화는 그대로 둔다. desktop 모드 턴에 'desktop-input' 키를 추가하면 두 엔진이 동시에 화면을 잡는 경우를 턴 단위로 막는 보조 장치가 된다. 그래도 진짜 잠금은 L0 mutex다. 오케스트레이션(Claude와 Codex 병렬 하위 턴)에서 이 키는 교착을 만들 수 있으니, 하위 턴은 L0 mutex에만 의존하게 한다.",
  "enforcement_points": [
   "E1 [Claude 경로 통일] index.ts buildMCPConfig: python 직결을 createToolBridge로 바꾼다. 이걸 하지 않으면 L1 관문은 Codex 쪽에만 걸리는 반쪽짜리가 된다.",
   "E2 [discovery/dispatch] toolBridge.ts tools/list·tools/call: 기존 denied 강제에 턴 상태 기반 ui-first 거부, 호출 타임아웃, 감사 이벤트를 더한다.",
   "E3 [프로세스 간 입력 잠금] bundled-mcp/server.py call_tool의 cc_ 분기(142줄 부근): named mutex를 잡고, target_window 포그라운드를 검증하고, 사후 상태 diff를 반환한다. 획득에 실패하면 즉시 거부한다.",
   "E4 [Codex MCP 승인] codex-app-server-bridge.mjs mcpServer/elicitation/request: cc_* 쓰기 elicitation을 UI가 실제로 렌더링하는지 확인하고, 120초 대기 중이라는 상태를 heartbeat에 노출한다.",
   "E5 [Codex 셸] codex-app-server-bridge.mjs thread/start·turn/start: desktop 모드에서만 approvalPolicy를 강화하고, item/commandExecution/requestApproval에서 패턴이 맞으면 자동 decline한다. item/started commandExecution 감시와 interrupt는 2차 방어다.",
   "E6 [Claude 셸] sidecar/hooks/preToolUse-desktopGuard.mjs: Bash/PowerShell 입력 주입 패턴을 거부한다(기존 PreToolUse 배선 재사용).",
   "E7 [멈춤] index.ts heartbeat/idle: desktop 모드 전용 짧은 한도를 두고, '대기(승인/elicitation)'와 '무응답'을 구분해 표시한다.",
   "E8 [턴 직렬화] index.ts dispatchRootTurn executionLeases.acquire: desktop-input 키는 보조로 둔다. 오케스트레이션 하위 턴에는 적용하지 않는다."
  ],
  "risks": [
   "셸 우회 차단은 패턴 기반이라 완전하지 않다. 인코딩된 PowerShell(-EncodedCommand), 새로 만든 스크립트 파일 실행, 컴파일된 exe 같은 경로는 놓칠 수 있다. danger-full-access를 유지하는 한 '막았다'가 아니라 '어렵게 하고 탐지한다'가 정직한 표현이다.",
   "Codex approvalPolicy를 강화하면 승인 요청이 폭증해 사용성이 떨어지고, 자동 승인 화이트리스트가 새로운 우회 통로가 될 수 있다.",
   "Claude를 bridge로 옮기면 지연이 늘고, Claude CLI가 기대하는 MCP 기능(resources, prompts, elicitation, notifications)이 bridge에서 Unsupported로 끊긴다. toolBridge는 지금 initialize/ping/tools/list/tools/call만 처리한다. Claude 쪽 elicitation을 쓰는 기능이 있다면 깨진다.",
   "bridge 직렬 큐에 타임아웃이 없어서 멈춘 호출 하나가 턴 전체를 멈추게 한다. 지금도 존재할 수 있는 멈춤 원인 후보다(미검증).",
   "ui-first 규칙은 UIA가 지원하지 않는 앱(게임, 일부 Electron 앱, 원격 데스크톱)에서 불필요한 왕복을 강제한다. 예외 판정이 허술하면 모델이 형식적인 ui_* 호출로 관문을 통과하게 된다.",
   "named mutex 보유 중에 프로세스가 죽으면 abandoned 상태가 된다. Windows mutex는 abandoned를 감지할 수 있지만, lock file로 구현하면 stale lock 처리가 필요하다.",
   "포그라운드 검증은 K가 작업 도중 창을 바꾸면 거부를 낳는다. 의도한 동작이지만, 사용자에게는 '또 멈춘다'로 보일 수 있다.",
   "멈춤의 실제 원인을 모르는 채 관문부터 만들면 증상(가만히 멈춤)이 그대로 남을 수 있다. 예를 들어 Codex가 computer use 도구가 없다고 판단해 아무것도 하지 않거나, elicitation이 UI에 표시되지 않는 경우다."
  ],
  "phased_plan": [
   "Phase 0 (진단, 필수 선행): 같은 화면 제어 요청을 Codex로 재현하면서 codex-app-server-bridge의 수신 method 전체(특히 mcpServer/elicitation/request, item/started mcpToolCall, item/commandExecution/requestApproval)와 bridge의 tools/list 결과를 기록한다. 판정할 것은 세 가지다. a) k-personal 도구 목록이 Codex에 보였는가, b) cc_* 호출이 elicitation 대기에서 멈췄는가, c) 모델이 호출 자체를 하지 않았는가. 결과에 따라 Phase 1의 우선순위가 바뀐다.",
   "Phase 1 (멈춤 가시화와 타임아웃): toolBridge callTool 타임아웃, desktop 모드 watchdog, 대기 사유 표시(E2 일부, E4, E7). 위험이 적고 증상에 직접 닿는다.",
   "Phase 2 (L0 불변식): server.py cc_* 경로에 named mutex, target_window 포그라운드 검증, 사후 상태 diff를 넣는다(E3). 엔진과 무관하게 즉시 효과가 있다.",
   "Phase 3 (강제 지점 통일): Claude --mcp-config를 bridge 경유로 바꾸고, ui-first 상태 머신과 감사 이벤트를 넣는다(E1, E2). Claude 쪽 MCP 기능 회귀를 먼저 확인한다.",
   "Phase 4 (셸 우회): Claude PreToolUse desktopGuard(E6)를 먼저 넣고, Codex는 item/started 감시와 interrupt를 거쳐 desktop 모드 approvalPolicy 강화(E5) 순서로 간다. 승인 폭증을 측정하면서 진행한다.",
   "Phase 5 (승인 경로 통합): Claude와 Codex 승인 및 elicitation UI를 하나의 표현으로 정리한다. 강제 효과보다 일관성을 위한 작업이라 마지막에 둔다. 비서 초안의 순서 1→4→2→3과 비교하면, 진단(0)과 watchdog을 앞으로 당기고 Claude 경로 통일을 관문 앞에 둔다는 점이 다르다."
  ],
  "verification": [
   "Claude 우회 확인: 변경 전후로 Claude 턴의 프로세스 트리를 확인한다. python server.py의 부모가 claude(직결)인지 node toolBridge.js인지 본다. denied 도구 호출이 'Tool not permitted in this KDA turn'으로 거부되는지 테스트한다.",
   "입력 잠금: Claude 턴과 Codex 턴(또는 두 MCP 프로세스)에서 동시에 cc_keyboard_type을 호출해 하나만 성공하고 다른 하나는 즉시 lock 오류를 받는지 자동 테스트한다.",
   "포그라운드: target_window와 다른 창을 앞에 둔 상태에서 cc_mouse_click을 호출하면 거부되고, 사후 diff에 changed:false나 창 불일치가 담기는지 확인한다.",
   "ui-first: ui_* 이력 없이 cc_mouse_click을 호출하면 거부되고, ui_find가 empty를 낸 뒤에는 허용되는지 bridge 단위 테스트로 확인한다.",
   "타임아웃: 일부러 멈추는 MCP 도구(테스트용 sleep)로 bridge 큐가 한도 안에 오류를 내고 다음 요청을 처리하는지 확인한다.",
   "셸 우회: PowerShell SendKeys, Add-Type user32 SetCursorPos, python -c pyautogui 각 1건을 Claude(Bash/PowerShell)와 Codex(commandExecution)로 시도해, Claude는 실행 전 거부되고 Codex는 desktop 모드에서 decline되거나 interrupt되는지 기록한다. -EncodedCommand 변형으로 탐지 누락률도 기록해 한계를 문서화한다.",
   "watchdog: elicitation을 응답하지 않은 상태로 두고 UI에 '승인 대기'가 표시되는지, 무응답 90초에 경고가 뜨는지 확인한다.",
   "회귀: 기존 toolBridge, executionLeases, codex-app-server-bridge 테스트와 Claude 비화면 턴(파일, DB 도구)이 bridge 경유 후에도 정상인지 확인한다."
  ],
  "what_rules_cannot_do": "구조로도 하지 못하는 일이 있다. (1) danger-full-access 셸을 가진 엔진의 입력 주입을 완전히 막는 것은 불가능하다. 근본 해결은 화면 작업 턴의 셸 권한 자체를 낮추는 것(Codex sandbox 하향, Claude Bash 비활성화)이고, 그 대가로 다른 작업 능력을 잃는다. (2) 모델이 도구를 아예 호출하지 않고 멈추는 경우는 관문이 잡을 대상 자체가 없다. watchdog으로 감지해서 알리는 것까지가 한계다. (3) 사후 diff는 '무언가 바뀌었는가'까지만 알려 준다. '의도대로 바뀌었는가'는 여전히 모델의 판단이고, 여기에 검증 단계를 강제하려면 작업별 기대 상태를 명시해야 한다. (4) Codex computer use(데스크톱 앱 전용)를 KDA에서 대체하는 것은 이 설계 범위 밖이다. k-personal ui_*/cc_*가 그 자리를 대신할 뿐 동등하다는 보장은 없다."
 },
 "B": {
  "thesis": "'멈춤'과 '말만 하고 실제로는 안 된 조작'은 규칙을 더 넣는다고 없어지지 않습니다. 원인 상당수가 도구가 결과를 돌려주는 방식 자체에 있기 때문입니다. 코드에서 확인한 사실은 다섯 가지입니다. (1) k-personal은 실패해도 isError를 한 번도 세우지 않습니다. computer_control.handle_tool은 예외가 나도 '오류 발생: ...'을 평범한 TextContent로 돌려주고, server.py는 모르는 도구도 텍스트로 돌려줍니다. (2) cc_mouse_click·cc_keyboard_type는 실행했다는 사실만 출력하고, 화면이 실제로 바뀌었는지는 보지 않습니다. (3) cc_keyboard_type는 pyautogui.typewrite를 쓰는데, 이 함수는 한글 같은 비ASCII 문자를 입력하지 않고 넘어가는 것으로 알려져 있습니다. 그래도 'N글자를 입력했습니다'를 반환합니다(라이브러리 특성으로 판단했고 실측은 하지 않았습니다). (4) Claude는 buildMCPConfig로 k-personal을 직접 띄웁니다(index.ts:2052). toolBridge는 Codex와 Gemini만 거칩니다. (5) 턴마다 k-personal 프로세스가 따로 뜨므로, 프로세스 안에 잠금을 두면 엔진끼리는 직렬화되지 않습니다. 그래서 제안의 중심은 '관문 강제'가 아닙니다. '모델이 쓴 문장이 아니라 실행 영수증(ledger)이 결과를 판정하는 구조'입니다. cc_* 입력 도구를 '대상 확인 → 실행 → 사후 조건 검증'으로 묶인 거래(transaction) 단위로 바꾸고, 두 엔진을 같은 toolBridge로 지나게 하며, 턴이 끝날 때 sidecar가 영수증으로 실제 결과 카드를 따로 띄웁니다. 멈춤은 원인부터 계측해야 합니다. 원인이 밝혀지기 전에 watchdog 시간만 줄이면 증상을 가릴 뿐입니다.",
  "architecture": "세 층으로 나눕니다. 엔진(Claude, Codex)은 같은 toolBridge를 지나 k-personal에 닿습니다. k-personal 안에는 '데스크톱 거래 계층'을 둡니다.\n\n[A. k-personal 데스크톱 거래 계층 — Python, 엔진과 무관]\n- 모든 입력 점유 도구(cc_mouse_click/move, cc_keyboard_type/hotkey, clip_paste_at, ui_* 중 입력 fallback이 있는 것)를 하나의 실행 함수가 처리합니다. 순서는 다음과 같습니다. (a) OS 이름 있는 뮤텍스(Win32 CreateMutex 'Local\\KDA-desktop-input')를 시간 제한을 두고 잡습니다. 턴마다 프로세스가 따로 뜨므로 in-process 잠금으로는 직렬화가 안 되기 때문입니다. (b) target_window 인자(제목 일부 또는 hwnd)를 필수로 받습니다. 그 창을 활성화한 다음 GetForegroundWindow가 실제로 그 창인지 확인합니다. 아니면 실행하지 않고 isError로 돌려줍니다. (c) 실행합니다. 한글은 typewrite 대신 SendInput 유니코드나 클립보드 붙여넣기로 보냅니다. (d) 사후 조건을 검증합니다. 선택 인자 expect({ui_exists|ui_text_equals|window_title_contains|foreground_changed})가 있으면 UIA로 확인하고, 없으면 전후 포그라운드 창·포커스 컨트롤·화면 해시 차이만 증거로 붙입니다.\n- 반환은 구조화된 판정입니다: status = verified | unverified | failed, 증거, 다음에 할 일 힌트. failed는 isError=true로 보냅니다. MCP 표준 신호이므로 두 엔진이 모두 '실패'로 받습니다.\n- 모든 모듈 handle_tool의 예외 경로를 isError=true로 바꿉니다. 비용이 가장 적고 효과는 가장 큽니다.\n\n[B. toolBridge를 두 엔진이 같이 쓰는 관문으로 — TypeScript, 재사용]\n- 기존 toolBridge.ts는 턴마다 뜨는 stdio 프록시입니다. denied 목록을 discovery·dispatch 양쪽에서 강제하고 요청을 직렬화합니다. Claude의 --mcp-config도 createToolBridge의 launch(command/args)를 가리키게 바꿉니다. 현재 Claude는 bridge를 거치지 않습니다.\n- bridge에 넣을 것: ① 도구 계열별 호출 시간 제한. mcpClient.callTool(name,args,timeoutMs)이 이미 지원하고, 지금은 기본값 30s만 씁니다. ui_* 20s, cc_* 15s, web_* 45s 정도. ② ledger.jsonl을 policy dir(createToolBridge가 만드는 tmp dir)에 append합니다. 기록 항목은 도구·인자 요약·시작/종료·status·isError입니다. ③ 진행 신호(tool 시작/종료)를 stderr 한 줄 이벤트로 내보냅니다. sidecar가 활동 시각을 갱신할 근거가 됩니다.\n\n[C. sidecar 턴 상태 기계 — 데스크톱 턴 한정]\n- 턴 안에서 입력 점유 도구가 한 번이라도 호출되면 그 턴을 'desktop turn'으로 표시합니다. 상태는 idle → acting → verifying → reported | stalled | failed입니다.\n- 턴이 끝나면 sidecar가 ledger를 읽어 '실행 영수증' 카드를 모델 답변과 별도로 띄웁니다(verified 몇 건, unverified 몇 건, failed 몇 건, 마지막 실패 사유). 모델이 '완료했습니다'라고 써도 영수증이 unverified/failed면 UI에 그대로 보입니다. '말만 한 조작'을 구조로 드러내는 핵심 장치입니다.\n- Codex 셸 우회 처리: codex-app-server-bridge.mjs는 item/started로 commandExecution 명령 문자열을 이미 받습니다(items 맵). SendKeys/keybd_event/SendInput/AutoHotkey/nircmd/WScript.Shell 패턴이 보이면 해당 단계를 영수증에 'ledger 밖 입력 — 미검증'으로 표시합니다. 막지는 못하고 드러내기만 합니다.\n\n[재사용 판정 — 코드 기준]\n- toolBridge: 재사용 가능하고 가장 좋은 삽입 지점입니다. 46줄짜리 단순 프록시이고, 시간 제한·ledger·이벤트를 넣기 쉽습니다. 다만 지금은 Codex/Gemini 전용이라 Claude 경로 전환이 먼저 필요합니다.\n- ExecutionLeases: 입력 잠금 용도로는 맞지 않습니다. 턴 단위로 dispatchRootTurn이 handler 실행 전에 잡고 턴이 끝날 때 놓습니다. 그 시점에는 데스크톱 작업인지 알 수 없고, 턴 전체를 잡으면 너무 거칩니다. 또 sidecar 메모리 안에만 있어서 bridge/k-personal 자식 프로세스에서 호출 단위로 잡을 수 없습니다. 쓸 수 있다면 'desktop:input' 키를 데스크톱 오케스트레이션 턴에 선택적으로 거는 정도입니다. 호출 단위 잠금은 OS 뮤텍스가 맞습니다.\n- idle watchdog: 구조(lastActivity, activeToolCalls, activeToolStartedAt, 15s 점검, treeKill)는 Claude·Codex·Gemini 세 경로에 복제돼 있어 재사용할 수 있습니다. 문제는 값입니다(60분/60분). desktop turn에만 짧은 '무진행' 기준(예: 90~120s 동안 tool 이벤트도 텍스트 delta도 없음)을 추가합니다. 처음엔 kill하지 말고 stalled 상태와 사유를 표시만 합니다.",
  "enforcement_points": [
   "k-personal 모듈 handle_tool 예외 경로와 server.py의 '알 수 없는 도구' 반환: isError=true로 바꿉니다. 지금은 모든 실패가 성공 응답으로 나갑니다.",
   "k-personal 입력 점유 도구의 공통 실행 함수: OS 뮤텍스, target_window 필수, 포그라운드 확인, 사후 조건 검증, 판정 반환. 두 엔진이 모두 지나는 유일한 지점입니다.",
   "computer_control.cc_keyboard_type: 비ASCII 입력을 SendInput 유니코드나 클립보드 경로로 보냅니다. 보낸 글자 수가 아니라 실제로 반영된 값(UIA value 읽기 가능 시)으로 판정합니다.",
   "toolBridge.ts tools/call: 도구 계열별 callTool timeoutMs, ledger.jsonl append, stderr 진행 이벤트. 기존 denied 강제는 그대로 둡니다.",
   "index.ts Claude 경로 buildMCPConfig: k-personal 직접 실행을 createToolBridge launch로 교체합니다. --disallowedTools는 2차 방어로 남깁니다.",
   "codex-app-server-bridge.mjs item/started: commandExecution 명령에서 입력 주입 패턴을 탐지해 ledger에 '우회 입력' 표시를 합니다(차단 아님). 같은 위치의 approval/elicitation pending 상태도 진행 이벤트로 내보냅니다.",
   "index.ts 턴 종료(finally): ledger를 읽어 실행 영수증 이벤트를 emit합니다. 프론트가 모델 답변과 분리해 렌더링합니다.",
   "index.ts idle watchdog: desktop turn 플래그가 있을 때만 짧은 무진행 기준을 적용합니다. 1단계는 stalled 표시, 2단계는 사용자 확인 후 kill입니다."
  ],
  "risks": [
   "멈춤의 실제 원인을 아직 모릅니다. 코드로 확인한 사실은 이렇습니다. Codex 경로의 tool 호출은 bridge의 mcpClient 기본 30s timeout에 걸립니다. approval·elicitation은 120s 뒤 자동 decline됩니다. 그러니 '60분 동안 가만히 있음'은 도구 hang보다는 모델이 도구를 아예 안 부르거나(computer use 도구가 있다고 가정), tools/list 실패, 프론트에 보이지 않는 승인 대기, app-server 자체 정지일 가능성이 있습니다. 모두 가설이고 미검증입니다. 계측 없이 watchdog 시간만 줄이면 원인을 가립니다.",
   "Claude를 toolBridge로 옮기면 Claude 경로에도 30s 기본 timeout이 생깁니다. 오래 걸리는 web_*·fm_* 호출이 새로 실패할 수 있으니 계열별 timeout을 먼저 정해야 합니다.",
   "사후 조건 검증의 한계: expect가 없는 호출은 unverified로 남습니다. 모델이 expect를 생략하는 습관이 들면 영수증이 unverified로 가득 찹니다. 이 경우 cc_* 입력 도구에 expect를 필수로 할지는 사용 데이터를 보고 정합니다.",
   "포그라운드 확인은 Windows 포그라운드 잠금 정책(SetForegroundWindow 제한) 때문에 활성화 자체가 실패할 수 있습니다. 실패를 정직하게 failed로 돌려주는 것이 목적이므로, 성공률 저하가 아니라 그동안 숨겨져 있던 실패가 드러나는 것으로 해석해야 합니다.",
   "OS 뮤텍스를 잡은 채 프로세스가 죽으면 Win32는 abandoned mutex를 돌려줍니다. 이를 정상 획득으로 처리하고 로그만 남겨야 데드락이 생기지 않습니다.",
   "ui_* 선시도 강제(직전 초안 1번)는 실효성이 낮습니다. 모델이 의미 없는 ui_find를 한 번 부르면 그만이고, UIA를 지원하지 않는 앱(게임, 캔버스, 일부 Electron)에서 왕복 호출만 늘어납니다. 순서보다 '대상 확인 + 결과 검증'을 강제하는 쪽이 효과가 큽니다.",
   "셸 우회 탐지는 문자열 패턴이라 인코딩·스크립트 파일 실행으로 쉽게 피할 수 있습니다. danger-full-access를 유지하는 한 막을 수 없습니다."
  ],
  "phased_plan": [
   "0단계(진단, 코드 변경 최소): 멈춘 Codex 대화를 재현하면서 codex-app-server-bridge 이벤트를 단계별로 기록합니다(thread/turn 시작, tools/list에 k-personal 도구 포함 여부, item/started 종류, approval/elicitation pending, 마지막 delta 시각). '멈춤'이 모델 정지·승인 대기·도구 부재 중 어느 것인지 확정하기 전에는 watchdog 값을 손대지 않습니다.",
   "1단계(정직한 실패, 가장 저렴함): k-personal 모든 모듈의 예외·미지원 경로를 isError=true로 바꾸고, cc_keyboard_type의 비ASCII 입력을 고칩니다. 이것만으로 '오류를 성공으로 보고'하는 경로가 상당 부분 사라집니다.",
   "2단계(경로 통합): Claude mcp-config를 createToolBridge launch로 바꿔 두 엔진이 같은 bridge를 지나게 합니다. bridge에 계열별 timeout, ledger.jsonl, 진행 이벤트를 추가합니다.",
   "3단계(거래 단위 입력): 입력 점유 도구에 OS 뮤텍스, target_window 필수, 포그라운드 확인, expect 기반 사후 검증, verified/unverified/failed 판정을 넣습니다.",
   "4단계(영수증과 상태 기계): sidecar가 턴 종료 시 ledger로 실행 영수증을 띄우고, desktop turn 무진행 감지(표시 먼저, kill은 사용자 확인 후)를 붙입니다.",
   "5단계(우회 가시화): Codex commandExecution 입력 주입 패턴을 영수증에 '미검증 우회 입력'으로 표시합니다. 차단이 필요하면 데스크톱 턴에 한해 sandbox/approval 정책을 바꾸는 별도 결정이 필요합니다(K 판단 사항)."
  ],
  "verification": [
   "0단계: 같은 '화면 제어' 요청을 Codex로 5회 재현하고, 멈춤마다 마지막 이벤트 종류를 분류한 표를 만듭니다. 원인 분류 없이 다음 단계로 넘어가지 않습니다.",
   "1단계: test_modules.py에 존재하지 않는 창 focus, 범위 밖 좌표, 잘못된 도구 이름 케이스를 넣고 isError=true를 단언합니다. 메모장에 '안녕 abc'를 cc_keyboard_type으로 입력한 뒤 ui_get_text로 실제 값이 같은지 확인합니다.",
   "2단계: Claude 턴에서 denied 도구가 tools/list에 나오지 않고 tools/call에서 거부되는지 확인합니다(지금은 Codex만 해당). 두 엔진 턴 모두 ledger.jsonl이 생성되고 호출 수가 엔진 측 tool 이벤트 수와 같은지 대조합니다.",
   "3단계: Claude 턴과 Codex 턴을 동시에 띄워 서로 다른 창에 입력시킨 뒤, 입력이 섞이지 않고 뮤텍스 대기가 로그에 남는지 확인합니다. 대상 창을 가려 포그라운드 확인이 failed를 내는지도 확인합니다.",
   "4단계: 모델이 '완료'라고 답했지만 expect가 실패한 시나리오(이미 닫힌 버튼 클릭 등)에서 영수증이 failed로 표시되는지 확인합니다. 툴 호출 없는 무진행 상태를 인위로 만들어 stalled 표시가 기준 시간 안에 뜨는지 확인합니다.",
   "회귀: 기존 비데스크톱 턴(fm_*, db_*, 긴 빌드)에서 새 timeout·watchdog 때문에 생긴 중단이 0건인지, 이벤트 로그로 1주일간 관찰합니다."
  ],
  "what_rules_cannot_do": "이 구조가 할 수 없는 일은 다음과 같습니다. (1) danger-full-access인 Codex가 셸로 PowerShell SendKeys·SendInput을 직접 호출하는 것은 막을 수 없고, 탐지해서 영수증에 드러낼 수만 있습니다. 실제 차단은 sandbox/approval 정책을 바꾸는 결정이 있어야 가능합니다. (2) 검증은 expect로 주어진 사후 조건까지만 보장합니다. '맞는 버튼을 눌렀는가'라는 의미상 정답은 보장하지 못하고, expect가 없으면 unverified로 남을 뿐입니다. (3) 모델이 처음부터 도구를 부르지 않는 경우(Codex가 computer use 도구가 있다고 착각하는 등)는 관문으로 막을 대상이 없습니다. 무진행 감지로 빨리 드러내고 원인 진단으로 풀어야 합니다. (4) UIA도 화면 해시도 잡지 못하는 앱(전체화면 게임, 원격 데스크톱 창 안쪽)에서는 판정이 unverified를 넘지 못합니다."
 },
 "crit": [
  {
   "strongest_points_of_other": [
    "I checked the code and B is right that k-personal reports failures as successes. computer_control.py lines 176-177 catch the exception and return '오류 발생: ...' as plain TextContent. grep finds no isError anywhere in bundled-mcp/server.py or modules/*.py, in either main or the control-results worktree. A missed this. Without fixing it, A's post-action diff and the ui-first rejection are partly wasted, because the model still sees an error as a success. Of everything proposed, this is the cheapest and highest-value change.",
    "B is right that cc_keyboard_type uses pyautogui.typewrite (computer_control.py:162) and then reports 'typed N characters'. I have not measured whether Korean text is skipped. Either way it is a direct path to 'it said it typed but nothing happened', and A did not cover it.",
    "B corrects A on two facts. (1) toolBridge already has a per-call timeout: client.callTool goes through MCPClient.request, whose DEFAULT_REQUEST_TIMEOUT_MS is 30_000. (2) The approval in codex-app-server-bridge.mjs:101 is auto-declined after 120 seconds. Together these make a 60-minute tool hang unlikely, which shifts the stall suspects to: the model never calls a tool, tools/list fails, the approval is never shown in the UI, or the app-server itself stops. That reasoning is more precise than A's.",
    "B points out that ui-first is weak: one meaningless ui_find call gets past it, and on apps without UIA it only adds round trips. B's alternative is to enforce 'confirm the target, then verify the result', which is a sounder thing to enforce.",
    "B's receipt (ledger) card, which sidecar shows separately from the model's answer, surfaces 'it said it did it but didn't' in the UI. It works even when there is no gate at all, and it answers K's concern that prompt rules alone are not enough.",
    "B gives exact parameters for the expect argument and the verified/unverified/failed verdict, so a post-check 'did it do what was intended' can be added task by task. This fills in A's point (3) under what_rules_cannot_do."
   ],
   "flaws_in_other": [
    "B gives up on blocking shell bypass and only proposes making it visible. Claude can block it before execution with the existing PreToolUse hook wiring (the same wiring as pitfallGuard). That is cheap, and B does not mention Claude-side shell bypass at all. B only covers Codex commandExecution.",
    "B adds a 30s default timeout to the Claude path but does not mention that toolBridge handles only initialize/ping/tools/list/tools/call and returns 'Unsupported MCP method' for everything else. Losing Claude's MCP features (notifications, resources, elicitation) is a regression B does not list as a risk. It also does not mention that tools/call requires known, i.e. it rejects calls made before tools/list has run.",
    "On timeout, the bridge's callTool only rejects the Promise. The Python-side pyautogui or UIA call keeps running and holds the server's serial processing. B treats per-family timeouts as enough, but a hard timeout or cancellation on the server.py side (A's L0) is also needed to unblock the next call.",
    "B's ledger lives in the per-turn tmp policy dir, and progress events are one-line stderr messages. Collecting either needs a new path into sidecar's MCP launch structure (the Codex config path and Claude --mcp-config). B underestimates this. The receipt card also only appears at turn end, so it does nothing for a turn that is stalled right now. Stall visibility needs a separate real-time channel.",
    "B says to make expect mandatory based on usage data. Leaving it optional at first means the unverified count piles up and the receipt loses meaning. B concedes this but leaves it unresolved. When target_window is given, a minimal automatic expect could be used, such as a foreground or focus check.",
    "B leaves the Codex turn-level desktop-input lease mostly unused. It is not essential, but B does not cover the orchestration case where Claude and Codex run in parallel and the deadlock risk that brings."
   ],
   "revised_position": "I am revising A to take B's 'honest failure plus execution receipt' as its central axis. I keep A's single enforcement point, L0 invariants and Claude shell blocking as supporting pieces. Revised order:\nPhase 0 (diagnosis, required): reproduce the Codex stall 5 times and classify the last event each time. Candidates: tools/list missing k-personal tools, approval or elicitation pending (auto-declined after 120s), no tool call at all, or app-server stopped. Because a 30s per-call timeout and a 120s auto-decline already exist, a tool hang is unlikely; I am withdrawing A's claim that the bridge queue has no timeout.\nPhase 1 (honest failure, cheapest): make the exception and unknown-tool paths in all k-personal modules return isError=true. Move non-ASCII input in cc_keyboard_type to SendInput Unicode or clipboard paste, and judge success by reading the UIA value back.\nPhase 2 (stall visibility): bridge emits stderr events at tool start and end; sidecar shows a short no-progress threshold for desktop turns (warning at 90s, kill at 180s only with user confirmation) and displays approval waits separately. Add per-family timeouts (ui_ 20s, cc_ 15s, web_ 45s) and a hard timeout on the server.py side, because the bridge timeout alone leaves the Python call running.\nPhase 3 (L0 transaction): for input-occupying tools, a Local\\KDA-desktop-input mutex (failure returns an error immediately; abandoned is treated as acquired and logged), target_window required, foreground check, post-condition check from expect or an automatic foreground/focus check, and a verified/unverified/failed verdict (failed sets isError).\nPhase 4 (single path plus receipt): move Claude --mcp-config to createToolBridge, after first adding pass-through for MCP methods other than tools to avoid regressions. The bridge appends to ledger.jsonl, and sidecar shows a receipt card at turn end. I am dropping A's ui-first state machine; at most it becomes a hint when target confirmation fails.\nPhase 5 (shell bypass): block Claude before execution with PreToolUse desktopGuard (cheap, so it could go earlier). For Codex, use item/started pattern detection to mark the receipt and interrupt. Tightening approvalPolicy for desktop turns is a K decision.\nLimits I keep from A: complete shell blocking is impossible under danger-full-access; a model that never calls a tool can only be detected, not stopped; semantic correctness is guaranteed only up to the expect condition. File paths checked: C:/Users/lee30/Documents/K-Desktop-Agent/.worktrees/control-results-20261105/sidecar/src/toolBridge.ts, C:/Users/lee30/Documents/K-Desktop-Agent/sidecar/src/mcpClient.ts (DEFAULT_REQUEST_TIMEOUT_MS=30_000), C:/Users/lee30/Documents/K-Desktop-Agent/bundled-mcp/modules/computer_control.py (lines 162, 176-177), C:/Users/lee30/Documents/K-Desktop-Agent/sidecar/src/codex-app-server-bridge.mjs (line 101, 120_000 auto-decline)."
  },
  {
   "strongest_points_of_other": [
    "A는 L0(k-personal server.py)에 불변식을 둬야 하는 이유로 'KDA 밖 Claude Code 플러그인 경로도 같은 서버를 쓴다'를 들었다. 이 세션 도구 목록에도 mcp__plugin_k-personal-automation_k-personal__cc_* 가 따로 있다. 그러니 bridge에만 두는 강제는 플러그인 경로에서 샌다. 이 지적 때문에 B의 '거래 계층은 k-personal 안' 판단이 더 단단해지고, bridge에 무엇을 둘지는 줄여야 한다.",
    "Claude 셸 우회는 PreToolUse 훅(exit 2)으로 실행 전에 막을 수 있다. B는 Claude 쪽도 '드러내기만'으로 뭉뚱그렸는데, 실제로는 기존 pitfallGuard 배선을 재사용해 차단할 수 있다. 엔진마다 강제 수준이 다르다는 점을 B보다 정확하게 짚었다.",
    "'대기(elicitation/approval)'와 '무응답'을 UI에서 나눠 보여주자는 제안. 코드로 확인했다. codex-app-server-bridge.mjs:158-160에서 elicitation은 120초 타이머 뒤 decline되고, cc_* 같은 쓰기 도구는 자동 승인 대상이 아니다. 멈춤 후보 중 진단 가치가 가장 높다.",
    "toolBridge가 initialize/ping/tools/list/tools/call만 처리한다는 지적(확인: default에서 'Unsupported MCP method'를 던짐). Claude를 bridge로 옮길 때 resources/prompts/notifications가 끊기는 회귀 위험이다. B는 timeout 위험만 적었다.",
    "오케스트레이션 하위 턴에 desktop-input lease를 걸면 교착이 생길 수 있다는 구체적 경고. 하위 턴은 OS 뮤텍스에만 의존하게 하자는 분리가 타당하다."
   ],
   "flaws_in_other": [
    "사실 오류가 있다. A는 'bridge 직렬 큐에 타임아웃이 없어서 멈춘 호출 하나가 턴 전체를 멈추게 한다'고 하고 Phase 1 첫 항목에 callTool 타임아웃 추가를 넣었다. 실제 toolBridge.ts는 client.callTool(name, args)를 timeoutMs 없이 부르고, mcpClient.ts:318의 callTool은 undefined를 request(…, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS)로 넘긴다. 그래서 기본값 30_000(62줄)이 적용된다. 큐가 무한정 멈추는 경로는 아니다. Phase 1 우선순위가 틀린 전제 위에 서 있다. 진짜 문제는 반대 방향이다. 30초에 bridge가 포기해도 Python 쪽 호출은 계속 돌 수 있어서, 뮤텍스를 잡은 채 고아 작업이 남을 수 있다.",
    "가장 싼 결함을 놓쳤다. k-personal은 isError를 한 번도 세우지 않는다(bundled-mcp 전체 grep 결과 0건). computer_control.py:176의 except는 '오류 발생' 텍스트를 성공 응답으로 돌려준다. A의 사후 diff는 정상 실행 경로에만 붙고, 예외·미지원·포그라운드 실패가 MCP 표준 실패 신호로 엔진에 전달되지 않는다. '말만 한 조작'의 가장 직접적인 원인이 A의 설계에 빠져 있다.",
    "cc_keyboard_type가 pyautogui.typewrite(computer_control.py:162)를 쓴다는 점도 다루지 않는다. typewrite는 비ASCII(한글) 문자에 약하다(라이브러리 특성이고 실측은 안 함). 포그라운드 확인과 사후 diff를 해도 '입력 시도는 했는데 글자가 안 들어감'은 changed:false 정도로만 드러나고, 원인은 그대로 남는다.",
    "ui-first 상태 머신을 bridge에 두는 설계는 A 스스로 인정하듯 형식적인 ui_find 한 번으로 통과된다. 플러그인 경로에는 걸리지도 않는다. 강제처럼 보이지만 실효가 낮고, UIA를 지원하지 않는 앱에서는 왕복만 늘린다. 순서보다 결과(대상 확인 + 사후 조건)를 강제해야 한다.",
    "뮤텍스를 '획득 실패 시 즉시 거부(대기 없음)'로 둔 정책은 오케스트레이션에서 정상 경쟁까지 실패로 만든다. 모델은 재시도하거나 포기하고, 사용자에게는 '또 안 된다'로 보인다. 짧은 시간 제한 대기(예: 2~5s) 후 isError가 맞다. abandoned 상태는 정상 획득으로 처리하고 로그를 남긴다.",
    "사후 diff의 changed:false는 expect가 없으면 판정 근거가 약하다. 화면 해시는 시계, 커서 깜빡임, 애니메이션 때문에 '바뀜'으로 오탐하기 쉽다. 의도한 상태(expect: ui_exists/ui_text_equals/window_title_contains)를 선택 인자로 받아 verified/unverified/failed로 판정해야 한다. 그리고 그 판정이 모델 답변과 별도로 턴 종료 영수증에 보여야 모델 서술을 교정할 수 있다. A의 감사 이벤트는 수집만 하고 사용자에게 보여주는 장치가 없다.",
    "Codex approvalPolicy를 화면 작업 턴에서 강화(untrusted)하는 것을 Phase 0 결과보다 먼저 확정하면 위험하다. 현재 멈춤의 유력 후보 중 하나가 '프론트에 보이지 않는 승인/elicitation 120초 대기'다. 승인 요청을 늘리면 증상이 오히려 악화될 수 있다. 승인 UI가 실제로 렌더링되는지 검증한 뒤 K가 결정할 사항이다.",
    "Claude 훅의 패턴 차단은 Bash/PowerShell 명령 문자열만 본다. Write로 .ps1/.py 파일을 만든 뒤 실행하는 2단계 우회는 놓친다. '실행 전 차단'이라고 부르려면 Write 내용 검사까지 포함하거나, 탐지 + 영수증 표시와 함께 한계를 명시해야 한다."
   ],
   "revised_position": "수정한 입장은 이렇다. 실행 결과는 모델 서술이 아니라 영수증으로 판정한다는 B의 핵심은 유지한다. 그 위에 A가 짚은 두 가지를 받아들인다. 하나는 L0 커버리지 근거로 플러그인 경로가 같은 서버를 쓴다는 점, 다른 하나는 Claude 셸 우회를 실행 전에 차단할 수 있다는 점이다. 양쪽 초안에 있던 ui-first 강제는 B에서도 A에서도 뺀다.\n\n순서는 다음과 같다.\n0) 진단. Codex 멈춤을 재현하면서 다음을 기록한다: tools/list 포함 여부, mcpToolCall 발생 여부, elicitation/approval pending과 그것이 프론트에 렌더링됐는지, 마지막 delta 시각. 이를 바탕으로 멈춤을 '대기 / 도구 미호출 / 정지'로 분류한다. 분류 전에는 watchdog 값과 approvalPolicy를 바꾸지 않는다.\n1) k-personal(L0, KDA와 플러그인 공통)에서 정직한 실패. 모든 예외·미지원 경로를 isError=true로 바꾸고, cc_keyboard_type의 비ASCII 입력을 SendInput 유니코드나 클립보드 경로로 교체한다. 비용이 가장 적고 플러그인 경로까지 덮는다.\n2) L0 거래 계층. Local\\KDA-desktop-input 이름 있는 뮤텍스를 짧은 시간 제한 대기로 잡는다(abandoned는 정상 획득으로 처리하고 로그). target_window를 필수로 받고 GetForegroundWindow로 확인한다. 선택 인자 expect로 사후 조건을 검증해 verified/unverified/failed를 판정하고, failed는 isError로 돌려준다. 도구 계열별 내부 타임아웃도 둔다. bridge가 30초에 포기한 뒤에도 Python 쪽 고아 작업이 뮤텍스를 붙잡지 않게 하려는 것이다.\n3) 경로 통합. Claude가 MCP의 resources, prompts, notifications 중 실제로 쓰는 것이 있는지 먼저 확인하고, 그다음 Claude --mcp-config를 createToolBridge로 바꾼다. bridge에는 계열별 timeoutMs(현재는 기본 30s 하나뿐), ledger.jsonl, stderr 진행 이벤트를 넣는다. 턴이 끝나면 sidecar가 ledger로 실행 영수증 카드를 모델 답변과 분리해 띄운다.\n4) desktop turn 무진행 감지. 기존 watchdog 구조를 재사용하고 60분 상수는 그대로 둔 채 모드별 상수를 추가한다. '승인/elicitation 대기'와 '무응답'을 따로 표시한다. 처음에는 표시만 하고, kill은 사용자 확인 후에 한다.\n5) 셸 우회. Claude는 PreToolUse desktopGuard로 Bash/PowerShell 입력 주입 패턴을 실행 전에 거부하고, 한계(Write 후 실행, 인코딩)를 문서화한다. Codex는 item/started commandExecution 패턴을 탐지해 영수증에 '미검증 우회 입력'으로 표시하고, 필요하면 turn/interrupt를 건다. 화면 작업 턴의 approvalPolicy 강화나 sandbox 하향은 승인 UI 렌더링이 검증된 뒤 K가 결정할 사항이다.\n\n여전히 보장하지 못하는 것도 있다. danger-full-access 셸의 완전 차단, expect가 없는 호출의 의미상 정답, 모델이 도구를 아예 부르지 않는 경우는 막지 못한다. 이 경우들은 감지하고 영수증에 드러내는 것까지가 한계다.\n\n근거 파일:\n- C:/Users/lee30/Documents/K-Desktop-Agent/.worktrees/control-results-20261105/sidecar/src/toolBridge.ts\n- C:/Users/lee30/Documents/K-Desktop-Agent/.worktrees/control-results-20261105/sidecar/src/mcpClient.ts (62, 318)\n- C:/Users/lee30/Documents/K-Desktop-Agent/.worktrees/control-results-20261105/bundled-mcp/modules/computer_control.py (162, 176)\n- C:/Users/lee30/Documents/K-Desktop-Agent/.worktrees/control-results-20261105/sidecar/src/codex-app-server-bridge.mjs (121-160)"
  }
 ]
}
```
