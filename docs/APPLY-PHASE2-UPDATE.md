# Phase 2 업데이트 적용 절차

> **이 문서는 Claude Code CLI 가 실행 가능하도록 작성되었습니다.**
> K가 "Phase 2 업데이트 적용해줘" 라고 요청하면 이 문서 순서대로 Bash / Read / Edit 도구를 사용해 진행하세요.
> K-Personal MCP 의 `mcp__k-personal__*` 도구들도 검증에 활용할 수 있습니다.

## 배경

Cowork 세션에서 Phase 2 (트레이 + 자동시작 + 리로드 + 바로가기) 코드를 작성해 `K-Desktop-Agent.zip` 으로 전달했습니다. 지금 이 프로젝트 폴더는 **이미 Phase 2 코드가 반영된 상태**입니다 (K가 수동으로 zip 풀어 덮어씀).

남은 일은:
1. 새로 추가된 의존성 설치 (`tauri-plugin-single-instance`)
2. 한 번 빌드해서 동작 확인
3. 바탕화면 + 시작 메뉴 바로가기 생성
4. 선택: Windows 시작 시 자동 실행 등록

---

## Step 1 · 현재 실행 중인 개발 서버 종료

Claude Code 세션에서 백그라운드로 실행 중이던 `run-dev.ps1` 이 있으면 먼저 종료해야 합니다 (파일 잠금 방지).

```bash
# Windows에서 tauri dev 관련 프로세스 확인
powershell -NoProfile -Command "Get-Process | Where-Object { \$_.ProcessName -match 'k-desktop-agent|tauri|node' } | Select-Object Id, ProcessName"
```

실행 중이면 K에게 **수동 종료** 요청 (앱 창 닫고 터미널 Ctrl+C). Claude는 사용자 동의 없이 프로세스 kill 하지 않습니다.

---

## Step 2 · 파일 상태 검증

현재 프로젝트가 Phase 2 반영 상태인지 확인.

```bash
# 핵심 파일들에 Phase 2 마커 문자열 존재 확인
cd "$USERPROFILE/Documents/K-Desktop-Agent"

grep -l "reload_sidecar" src-tauri/src/lib.rs || echo "✗ lib.rs old"
grep -l "tauri-plugin-single-instance" src-tauri/Cargo.toml || echo "✗ Cargo.toml old"
test -f src/components/Settings.tsx && echo "✓ Settings.tsx exists" || echo "✗ Settings.tsx missing"
test -f scripts/launch.vbs && echo "✓ launch.vbs exists" || echo "✗ launch.vbs missing"
test -f scripts/setup-shortcuts.ps1 && echo "✓ setup-shortcuts.ps1 exists" || echo "✗ setup-shortcuts.ps1 missing"
```

하나라도 `✗` 가 나오면 zip 적용이 미완료된 것. K에게 알리고 중단.

---

## Step 3 · 의존성 설치

```bash
cd "$USERPROFILE/Documents/K-Desktop-Agent"
npm install
```

핵심 변화: Cargo.toml 에 `tauri-plugin-single-instance = "2.0.1"` 추가됨. 이건 **다음 Rust 빌드 시 자동으로 받아짐** — 별도 명령 불필요.

sidecar 쪽은 변경 없으므로 기존 설치 유지.

**예상 출력**: `added XX packages` 또는 `up to date`.

---

## Step 4 · 개발 빌드 검증

```bash
cd "$USERPROFILE/Documents/K-Desktop-Agent"
# 백그라운드 실행은 권장하지 않음 — K가 눈으로 창 뜨는 거 확인해야 함
# Claude가 아닌 K가 직접 실행:
echo ""
echo "⚠ 다음 명령을 K가 직접 PowerShell에서 실행 필요 (창 렌더링 확인 위함):"
echo ""
echo "    cd \$env:USERPROFILE\\Documents\\K-Desktop-Agent"
echo "    .\\scripts\\run-dev.ps1"
echo ""
echo "첫 빌드는 Rust 재컴파일로 3~5분 소요 (single-instance 크레이트 추가됨)."
```

**검증 체크리스트** (창 뜨면 K에게 확인 요청):

1. 창 X 버튼 → 창이 사라지고 **시스템 트레이 (작업 표시줄 우측)**에 K 아이콘 생성?
2. 트레이 좌클릭 → 창 복원?
3. 트레이 **우클릭** → Show / Reload Sidecar / Settings / Quit 메뉴?
4. 사이드바의 **Settings 버튼** 클릭 → 다크 모달 오픈?
5. Settings 안 **Reload 버튼** 클릭 → 상단 배지가 잠깐 CONNECTING 갔다가 LIVE 복귀?
6. 도구 호출 (예: "스크린샷 찍어줘") 정상 동작?

하나라도 실패하면 문제 진단 (아래 `진단` 섹션).

---

## Step 5 · 바로가기 생성

동작 확인 끝나면 K에게 **현재 실행 중인 dev 서버를 종료**한 후 (Ctrl+C + Quit 메뉴), 다음 실행:

```bash
# PowerShell 정책상 Claude 가 직접 실행은 실패할 수 있으므로 K 에게 요청:
echo ""
echo "⚠ K가 PowerShell 에서 직접 실행:"
echo ""
echo "    cd \$env:USERPROFILE\\Documents\\K-Desktop-Agent"
echo "    .\\scripts\\setup-shortcuts.ps1 -AutoStart"
echo ""
echo "이 스크립트는:"
echo "  - 바탕화면에 'K Desktop Agent.lnk' 생성"
echo "  - 시작 메뉴 Programs 에 'K Desktop Agent.lnk' 생성"
echo "  - (-AutoStart 옵션) Windows 시작 프로그램에 등록 (--minimized 플래그)"
echo ""
echo "-AutoStart 빼면 자동 시작은 등록 안 함."
```

**Claude가 대신 실행하려면** (가능한 경우):

```bash
cd "$USERPROFILE/Documents/K-Desktop-Agent"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-shortcuts.ps1" -AutoStart
```

---

## Step 6 · 최종 검증

```bash
# 바탕화면 바로가기 존재 확인
test -f "$USERPROFILE/Desktop/K Desktop Agent.lnk" && echo "✓ 바탕화면 바로가기" || echo "✗ 바탕화면 바로가기 없음"

# 시작 메뉴
test -f "$APPDATA/Microsoft/Windows/Start Menu/Programs/K Desktop Agent.lnk" && echo "✓ 시작 메뉴" || echo "✗ 시작 메뉴 없음"

# 자동 시작 (옵션 적용한 경우만)
test -f "$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup/K Desktop Agent.lnk" && echo "✓ 자동 시작" || echo "— 자동 시작 미등록 (옵션)"
```

### 실제 사용 테스트

K에게:
1. **바탕화면 아이콘 더블클릭** → PowerShell 창 없이 5~10초 후 앱 창 뜨는지
2. 자동 시작 등록한 경우: **Windows 재부팅 후** 트레이에 자동으로 K 아이콘 생기는지

---

## 진단 (문제 발생 시)

### 트레이 아이콘이 안 보임

1. `Get-Process | Where-Object { $_.ProcessName -match 'k-desktop' }` — 프로세스는 떠 있는지
2. 작업 표시줄 우측 ^ 화살표 클릭 — 숨겨진 아이콘에 있는지
3. Rust 빌드 로그 확인: `Get-ChildItem $env:USERPROFILE\Documents\K-Desktop-Agent\src-tauri\target\debug` 로 `k-desktop-agent.exe` 타임스탬프 확인

### `reload_sidecar` 호출 시 에러

```bash
# DevTools 로그 확인하려면 환경변수 설정 후 재시작
powershell -Command "\$env:KDA_OPEN_DEVTOOLS='1'; .\scripts\run-dev.ps1"
```

### 바탕화면 아이콘 더블클릭해도 앱 안 뜸

```bash
# 로그 확인
Get-Content "$USERPROFILE/Documents/K-Desktop-Agent/logs/launch.log" -Tail 50
```

흔한 원인:
- `node`, `npm` 이 PATH 에 없음 → `where.exe node` 확인
- `node_modules/` 미존재 → `npm install` 재실행
- `src-tauri/target/debug/k-desktop-agent.exe` 미존재 → 한 번은 `npm run tauri:dev` 돌려서 빌드 필요

---

## 완료 후 업데이트할 파일

이 업데이트 성공 시 다음 파일들 수정해서 상태 반영:

1. **`CLAUDE.md`** 의 "현재 상태" 섹션에서 Phase 2 를 `✅ 완료` 로 이동
2. **`ROADMAP.md`** 의 "완료된 Phase" 에 Phase 2 추가, "남은 Phase" 에서 제거
3. **`docs/PHASE-2-TRAY.md`** 최상단에 `**상태: 완료 (YYYY-MM-DD)**` 추가

Edit 도구로 해당 부분들 수정하면 됩니다.

---

## 관련 명령 참고

**전체 제거 후 재설치**:
```bash
cd "$USERPROFILE/Documents/K-Desktop-Agent"
powershell -Command ".\scripts\setup-shortcuts.ps1 -Remove"
# 그 다음 다시 .\scripts\setup-shortcuts.ps1 실행
```

**sidecar 재기동만** (앱 재시작 없이):
앱의 사이드바 → Settings → Reload 버튼. 또는 트레이 우클릭 → Reload Sidecar.

**개발 중 DevTools 자동 오픈**:
```bash
$env:KDA_OPEN_DEVTOOLS="1"
.\scripts\run-dev.ps1
```
