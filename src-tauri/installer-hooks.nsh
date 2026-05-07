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
