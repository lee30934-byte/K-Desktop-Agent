' K Desktop Agent - 창 없는 백그라운드 런처
' 바탕화면 바로가기의 Target 으로 사용.
' npm run tauri:dev 를 터미널 창 없이 실행 → Tauri 앱만 뜸

Option Explicit
Dim WshShell, fso, scriptDir, projectRoot, logPath, cmd, arg, traceFile, ts

Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")

scriptDir   = fso.GetParentFolderName(Wscript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)
logPath     = projectRoot & "\logs"

' logs 폴더 없으면 생성
If Not fso.FolderExists(logPath) Then
  fso.CreateFolder(logPath)
End If

' ─── 진단 트레이스 ──────────────────────────────
' 어느 단계까지 실행됐는지 기록. 디버깅 후 제거 가능.
traceFile = logPath & "\launch.trace.log"
Sub Trace(msg)
  On Error Resume Next
  Dim f
  Set f = fso.OpenTextFile(traceFile, 8, True) ' 8=append, True=create
  f.WriteLine Now & "  " & msg
  f.Close
  On Error Goto 0
End Sub

Trace "=== VBS 시작 ==="
Trace "scriptDir   = " & scriptDir
Trace "projectRoot = " & projectRoot
Trace "WSH CurDir  = " & WshShell.CurrentDirectory

' wscript 자체의 CWD 를 프로젝트 루트로 강제
On Error Resume Next
WshShell.CurrentDirectory = projectRoot
If Err.Number <> 0 Then
  Trace "CurrentDirectory 설정 실패: " & Err.Description
  Err.Clear
Else
  Trace "WSH CurDir 변경 후 = " & WshShell.CurrentDirectory
End If
On Error Goto 0

' --minimized 인자 전달 여부 (자동 시작 시 사용)
arg = ""
If Wscript.Arguments.Count > 0 Then
  If Wscript.Arguments(0) = "--minimized" Then
    arg = " -- --minimized"
  End If
End If
Trace "tauri arg = '" & arg & "'"

' cmd.exe /c 로 포장해서 npm 실행, 로그는 파일로 (디버깅 필요할 때)
cmd = "cmd.exe /c cd /d """ & projectRoot & """ && npm run tauri:dev" & arg & _
      " > """ & logPath & "\launch.log"" 2>&1"

Trace "cmd = " & cmd

' 3번째 인자 0 = 창 숨김 (가장 중요)
' 4번째 인자 False = 완료 대기 안 함
On Error Resume Next
Dim runRet
runRet = WshShell.Run(cmd, 0, False)
If Err.Number <> 0 Then
  Trace "WshShell.Run 실패: [" & Err.Number & "] " & Err.Description
  Err.Clear
Else
  Trace "WshShell.Run 호출 OK (return=" & runRet & ")"
End If
On Error Goto 0

Trace "=== VBS 종료 ==="

Set WshShell = Nothing
Set fso = Nothing
