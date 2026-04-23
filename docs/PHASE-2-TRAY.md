# Phase 2 — 트레이 + 자동시작 + 리로드 + 바로가기

**상태: 완료 (2026-04-21)** — 코드 반영 + 의존성 설치 + 바로가기 3종(바탕화면·시작메뉴·자동시작) 등록까지 완료.
**적용 절차 기록: `docs/APPLY-PHASE2-UPDATE.md`**

## 구현된 기능

### 1. 시스템 트레이

`src-tauri/src/lib.rs` 의 `setup_tray()`:
- `TrayIconBuilder` 로 트레이 아이콘 + 메뉴 구성
- 메뉴 항목: Show / Reload Sidecar / Settings / Quit
- 좌클릭 이벤트: 창 토글 (보이면 숨김, 숨었으면 복원 + 포커스)
- 우클릭: 메뉴 표시
- 아이콘 ID: `"main-tray"`

### 2. 창 close → 트레이로 숨김

```rust
main_window.on_window_event(move |event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();       // 기본 종료 취소
        let _ = win_handle.hide(); // 창만 숨김
    }
});
```

완전 종료는 트레이 우클릭 → Quit 또는 Settings → Quit.

### 3. `--minimized` 플래그

`main.rs` 에서 args 파싱, `run_with_options(start_minimized)` 호출.
`true` 면 setup 에서 `main_window.hide()` → 창 안 보이고 트레이에만.

자동 시작 시 사용 (`scripts/launch.vbs` 에서 `--minimized` 인자 있으면 전달).

### 4. Sidecar 리로드

`reload_sidecar` Tauri 커맨드:
1. `SIDECAR_CHILD` 싱글톤에서 기존 프로세스 `start_kill()` + `wait()`
2. `SIDECAR_TX` 채널 비우기
3. 프론트에 `{"type":"reloading"}` 이벤트 송출
4. `spawn_sidecar()` 재호출

호출 위치:
- Settings 모달 "Reload" 버튼
- 트레이 메뉴 "Reload Sidecar"

### 5. Settings 모달

`src/components/Settings.tsx`:
- 자동 시작 토글 (`@tauri-apps/plugin-autostart` 의 `enable`/`disable`/`isEnabled`)
- Reload Sidecar 버튼 → `invoke("reload_sidecar")`
- Quit 버튼 → `invoke("quit_app")`
- About 섹션 (버전, 모델, 구독 정보)

트레이에서 "Settings" 선택 시 `open-settings` 이벤트가 프론트로 전달되어 모달 자동 오픈.

### 6. 중복 실행 방지

`tauri-plugin-single-instance` 사용. 이미 실행 중일 때 다시 실행하면 기존 창이 포커스 받음.

### 7. 바탕화면·시작메뉴·시작프로그램 바로가기

**`scripts/launch.vbs`**:
- `wscript.exe` 로 실행되는 VBScript
- `cmd.exe /c ... npm run tauri:dev` 를 **창 숨김 모드**(`Run cmd, 0, False`)로 호출
- 로그: `logs/launch.log`
- 인자로 `--minimized` 받으면 `-- --minimized` 로 npm 에 전달

**`scripts/setup-shortcuts.ps1`**:
- `WshShell.CreateShortcut` COM 으로 `.lnk` 파일 생성
- 타겟: `wscript.exe scripts\launch.vbs`
- 아이콘: `src-tauri/icons/icon.ico`
- `-AutoStart` 옵션: `shell:startup` 폴더에도 바로가기 생성 (인자에 `--minimized`)
- `-Remove` 옵션: 전부 제거

### 8. DevTools 자동 오픈 비활성화

기본값에서 off. 필요할 때만 `KDA_OPEN_DEVTOOLS=1` 환경변수로 활성화.

## 성공 기준

- [x] 창 X → 트레이로 숨김 (프로세스 살아있음)
- [x] 트레이 좌클릭 → 창 토글
- [x] 트레이 우클릭 → 전체 메뉴
- [x] Settings 에서 자동 시작 on/off
- [x] `--minimized` 플래그로 창 숨긴 채 시작
- [x] Sidecar Reload (앱 재시작 없이)
- [x] 바탕화면 바로가기 (PowerShell 창 없이 실행)
- [x] Windows 시작 시 자동 실행 (옵션)
- [x] 중복 실행 시 기존 창 포커스

## K가 직접 적용할 일

(Claude Code CLI 기준)
```
docs/APPLY-PHASE2-UPDATE.md 대로 진행해줘
```

주요 명령:
1. `npm install` (새 Rust 의존성은 cargo 가 자동 처리)
2. `.\scripts\run-dev.ps1` 한 번 돌려서 트레이·모달 동작 확인
3. `.\scripts\setup-shortcuts.ps1 -AutoStart`
4. 바탕화면 아이콘 더블클릭 테스트

## 알려진 제약

### 자동 시작에 대하여

- `tauri-plugin-autostart` 는 **Tauri 바이너리 경로** 를 Windows 시작프로그램에 등록함. 지금은 dev 모드 바이너리 (`target/debug/k-desktop-agent.exe`) 라 K 계정에서만 유효.
- 더 안정적인 자동 시작은 **`setup-shortcuts.ps1 -AutoStart`** 를 통해 `shell:startup` 폴더에 `.lnk` 직접 넣는 방식. `launch.vbs --minimized` 를 호출하므로 dev/prod 구분 없이 동작.
- Phase 5 에서 MSI 빌드 후 정식 Installed Location 으로 바뀌면, `tauri-plugin-autostart` 의 자동 시작도 확실히 동작.

### DevTools

- dev 모드라도 `KDA_OPEN_DEVTOOLS=1` 없으면 안 열림. 필요하면:
  ```powershell
  $env:KDA_OPEN_DEVTOOLS="1"
  .\scripts\run-dev.ps1
  ```
