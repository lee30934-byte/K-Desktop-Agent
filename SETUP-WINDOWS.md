# Windows 전용 설치 가이드 (Phase 0)

이 프로젝트를 처음 돌려보기 위한 단계별 가이드입니다.

## 1. 파일 복사

이 폴더(`K-Desktop-Agent`) 전체를 다음 위치로 복사하세요:

```
C:\Users\user\Documents\K-Desktop-Agent
```

## 2. 필수 도구 설치

### 2-1. Rust 설치 (없는 경우에만)

PowerShell에서:

```powershell
winget install Rustlang.Rustup
```

설치 후 **새 PowerShell 창을 다시 열고** 확인:

```powershell
rustc --version
```

### 2-2. Node.js 설치 (없는 경우에만)

```powershell
winget install OpenJS.NodeJS.LTS
```

새 PowerShell 창에서 확인:

```powershell
node --version    # v20 이상
npm --version
```

### 2-3. Visual Studio Build Tools 설치

Tauri는 Rust를 컴파일할 때 MSVC 링커를 씁니다.

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools `
  --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools"
```

설치에 10~20분 걸립니다. 완료 후 PC 재부팅 권장.

### 2-4. (선택) WebView2 확인

Windows 10 1803 이상에는 이미 포함돼 있어요. Windows 11이면 걱정 없음.

## 3. 의존성 설치

```powershell
cd C:\Users\user\Documents\K-Desktop-Agent
npm install
```

이 명령이:
- 프론트엔드 의존성 (React, Tauri API 등) 설치
- `postinstall` 훅으로 `sidecar/` 내부 의존성도 자동 설치

시간: 1~3분.

## 4. 아이콘 생성 (필수)

Tauri는 아이콘 없이는 빌드가 안 됩니다. 아무 정사각형 PNG 파일을 프로젝트 루트에 `icon.png`로 두고:

```powershell
npx @tauri-apps/cli@latest icon ./icon.png
```

자동으로 `src-tauri/icons/` 에 여러 사이즈의 아이콘이 만들어집니다.

**임시 아이콘을 원하시면**: 512x512 정도의 단색 PNG를 Paint나 아무 이미지 앱으로 만들어도 됩니다. 지금은 개발용이라 뭐든 OK.

## 5. 첫 실행

```powershell
npm run tauri:dev
```

- **최초 실행**: Rust 의존성 컴파일 때문에 2~5분 걸립니다. 커피 한 잔.
- **이후 실행**: 10~20초.

창이 뜨면:
1. 입력창에 "안녕" 같은 걸 치고 Enter
2. Rust 백엔드가 `[Phase 0 echo — ...]` 하면서 메시지를 돌려주면 성공

## 6. 다음 단계

Phase 0 확인되면 Phase 1 진행:
- Node 사이드카를 Rust가 spawn
- Claude Agent SDK로 실제 AI 응답
- 스트리밍 표시

## 자주 겪는 에러

### `error: linker 'link.exe' not found`
→ VS Build Tools 설치 안 됨. 2-3번 단계 다시.

### `warning: unused import` 류 경고
→ 무시해도 됨. 개발 중이라 정상.

### 창이 뜨긴 했는데 빈 화면
→ 프론트엔드(Vite)가 아직 빌드 중. 10초 기다려보고 새로고침(Ctrl+R).

### `npm install`이 중간에 멈춤
→ Ctrl+C로 죽이고 `npm cache clean --force` 후 재시도.

### `TauriError: failed to load icon`
→ 4번 (아이콘 생성) 단계 건너뜀. 돌아가서 수행.

---

진행 중 문제 생기면 오류 메시지 전체를 복사해서 질문하세요.
