# Phase 1 전환 가이드

Phase 0(에코)이 정상 동작하는 걸 확인한 뒤, 아래 4개 파일을 교체하면 Phase 1(실제 Claude 연결)로 넘어갑니다.

## 1. sidecar 의존성 추가

`sidecar/package.json` 의 dependencies에 이미 `@anthropic-ai/claude-agent-sdk`가 들어있습니다. 재설치만:

```powershell
cd C:\Users\user\Documents\K-Desktop-Agent\sidecar
npm install
```

만약 SDK 패키지 이름이나 버전이 바뀌었다면 에러가 나는데, 그때는:
```powershell
npm view @anthropic-ai/claude-agent-sdk versions --json
```
으로 최신 버전 확인 후 `package.json` 업데이트.

## 2. Claude Code CLI 로그인 (최초 1회)

Claude Agent SDK는 내부적으로 Claude Code CLI의 OAuth 토큰을 씁니다. 아직 로그인 안 됐다면:

```powershell
# Claude Code CLI가 PATH에 없다면 MS Store 앱 내부 경로 사용:
& "C:\Users\user\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code\2.1.111\claude.exe" setup-token
```

브라우저가 열리고 Claude Max/Pro 계정으로 로그인하면 토큰이 저장됩니다.

## 3. 파일 교체

**`phase1-files/` 폴더의 파일 → 프로젝트의 해당 경로로:**

| 복사 원본 | 덮어쓸 대상 |
|---|---|
| `phase1-files/sidecar-src-index.ts` | `sidecar/src/index.ts` |
| `phase1-files/src-tauri-src-lib.rs` | `src-tauri/src/lib.rs` |
| `phase1-files/src-App.tsx` | `src/App.tsx` |

**`App.css` 수정:**
`phase1-files/App.css.additions` 내용을 `src/App.css` 파일 **끝에 추가** (덮어쓰기 X).

## 4. 개발 의존성 추가 (sidecar)

`sidecar/`에서 개발 중 `.ts` 직접 실행에 `tsx`가 필요 (이미 package.json에 있음). 혹시 빠져있다면:

```powershell
cd sidecar
npm install --save-dev tsx
```

## 5. 실행

```powershell
cd C:\Users\user\Documents\K-Desktop-Agent
npm run tauri:dev
```

창이 뜨면:
1. 상단 subtitle이 "연결 중..." → "연결됨" 으로 바뀌어야 함
2. "안녕, 소개해봐" 입력 → Claude의 실제 응답이 스트리밍되어 표시되면 **Phase 1 성공**

## 트러블슈팅

### "sidecar spawn failed: ENOENT"
→ Node.js PATH 문제. `node --version`이 되는지 확인.
→ `sidecar/node_modules` 있는지 확인. 없으면 `cd sidecar && npm install`.

### "Cannot find module '@anthropic-ai/claude-agent-sdk'"
→ 의존성 설치 안 됨. `cd sidecar && npm install`.

### "OAuth token not found" 또는 401
→ 2번 단계(로그인) 안 함. Claude Code CLI로 로그인 필요.

### 응답이 안 오고 "응답 중..."만 계속
→ DevTools 콘솔 열어서 sidecar 로그 확인. Ctrl+Shift+I.
→ stderr 메시지는 Rust가 실행된 PowerShell 창에 출력됨.

### "assistant_delta" 이벤트가 안 옴
→ Claude Agent SDK의 이벤트 스키마가 버전업되면서 바뀌었을 가능성.
→ sidecar/src/index.ts의 `switch (event.type)` 부분을 최신 SDK 기준으로 수정 필요.
→ 먼저 `console.log(event)`를 넣어서 실제 이벤트 구조 확인.

## Phase 1 완료 기준

- [ ] 창이 뜨고 "연결됨" 표시
- [ ] 한국어 메시지 입력 시 Claude가 한국어로 자연스럽게 응답
- [ ] 스트리밍 (글자가 하나씩 나타남) 동작
- [ ] 길어지는 응답을 "중단" 버튼으로 끊을 수 있음
- [ ] 창 닫으면 Node sidecar도 같이 종료됨

완료되면 Phase 2 (트레이 + 자동시작) 진행.
