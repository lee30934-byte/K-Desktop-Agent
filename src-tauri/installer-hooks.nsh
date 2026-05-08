; K Desktop Agent — NSIS installer hooks
;
; Phase 16 (Shortcut Hygiene): Tauri 의 인앱 updater (tauri-plugin-updater 2.10.1) 가
; setup.exe 를 호출할 때 `/UPDATE` 플래그를 안 붙여서, 매 업데이트마다 NSIS template 의
; CreateOrUpdateDesktopShortcut 함수가 호출되어 바탕화면 바로가기가 다시 생성되는 문제 해결.
;
; 동작:
;   1. PREINSTALL hook 에서 Public Desktop + User Desktop 양쪽을 체크
;   2. 이미 .lnk 가 어느 쪽이든 존재하면 NoShortcutMode = 1 로 set
;   3. NSIS template 의 CreateOrUpdateDesktopShortcut (line 8084-8086) 가 NoShortcutMode = 1
;      이면 바로가기 생성 skip
;
; 효과:
;   - 신규 설치: 양쪽 다 없음 → 정상 흐름 (사용자가 finish page 에서 옵션 선택 시 생성)
;   - 인앱 업데이트 / 재설치 / setup.exe 수동 더블클릭: 이미 있으니 skip → 중복 안 생김
;   - K가 일부러 lnk 를 삭제하면 다음 설치 때만 정상 생성
;
; 검증: scripts/check.ps1 의 NSIS hook grep 에서 이 파일 + 압축된 installer.nsi 안에
;      'NSIS_HOOK_PREINSTALL' 매크로 확인.

!macro NSIS_HOOK_PREINSTALL
  ; 디버그: 이 hook 이 컴파일에 박혔는지 빌드 로그에서 확인 가능
  DetailPrint "K Desktop Agent: checking existing desktop shortcuts (Phase 16)"

  ; Phase 16: 이미 어느 쪽 Desktop 에든 .lnk 있으면 NoShortcutMode 설정
  ; SetShellVarContext current → $DESKTOP = C:\Users\<user>\Desktop
  SetShellVarContext current
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" hasShortcut

  ; SetShellVarContext all → $DESKTOP = C:\Users\Public\Desktop
  SetShellVarContext all
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" hasShortcut

  Goto endShortcutCheck

  hasShortcut:
    DetailPrint "K Desktop Agent: existing desktop shortcut detected, skipping creation"
    StrCpy $NoShortcutMode 1

  endShortcutCheck:
    ; 원래 context 로 복귀 (NSIS template 의 후속 동작이 의존할 수 있음)
    SetShellVarContext current
!macroend

; ════════════════════════════════════════════════════════════════
; Phase 25 (v0.5.11): Portable data dir — 기본 data-pointer.txt 박기
; ════════════════════════════════════════════════════════════════
;
; install 폴더 옆 (= ${INSTDIR}\..\data) 을 default 데이터 폴더로 박는다.
; K 가 D:\KDA 에 깔면 D:\data 가 default — 같은 드라이브 통일.
;
; 이미 data-pointer.txt 가 있으면 (재설치 / 업데이트) 덮어쓰지 않음 — K 가 옛
; 위치 (예: 본 PC 의 ~/.kda 또는 K 가 명시 변경한 D:\KDA-data) 를 잃지 않게.
;
; 만든 폴더는 uninstall 시 삭제 안 함 (uninstaller 가 ${INSTDIR} 만 청소).
; K 데이터 안전.
!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "K Desktop Agent: setting up data-pointer.txt (Phase 25)"

  ; 이미 pointer 가 있으면 skip
  IfFileExists "$INSTDIR\data-pointer.txt" pointerExists

  ; default 데이터 경로 결정 — install 폴더의 부모 + \data
  ; NSIS 의 ${INSTDIR} 는 사용자가 인스톨러 화면에서 고른 폴더 (예: D:\KDA\app)
  ; 부모는 D:\KDA — 그 옆에 D:\KDA\data 박음
  Push $0
  Push $1
  StrCpy $0 "$INSTDIR\.."  ; install dir 의 부모
  StrCpy $1 "$0\data"        ; 부모 + \data

  ; UTF-8 no-BOM 파일 작성 (FileWrite 는 default 가 ANSI 라 ASCII path 만 안전)
  ; data 경로는 영문/숫자/슬래시만 — ASCII 안전
  FileOpen $9 "$INSTDIR\data-pointer.txt" w
  FileWrite $9 "$1"
  FileClose $9
  DetailPrint "K Desktop Agent: data-pointer.txt set to $1"

  ; 데이터 폴더가 아직 없으면 생성
  CreateDirectory "$1"
  Pop $1
  Pop $0
  Goto endPointerCheck

  pointerExists:
    DetailPrint "K Desktop Agent: data-pointer.txt already exists — preserving K's choice"

  endPointerCheck:
!macroend
