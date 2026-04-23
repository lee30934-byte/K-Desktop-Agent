# K Desktop Agent — Handoff 가이드

이 문서는 Cowork 세션에서 K Desktop Agent + Claude Code CLI 로 개발 환경을 전환할 때 참고하는 가이드입니다.

## 왜 전환하나

Cowork 세션은 Linux 마이크로VM 샌드박스라서:
- 파일 변경 → zip 재생성 → 복사 → 재시작 (30초~1분/회)
- K님 Windows 파일 시스템 직접 접근 불가

반면 **K Desktop Agent 프로젝트 폴더에서 Claude Code CLI 를 실행**하면:
- 파일을 Read/Write/Edit 도구로 즉시 수정
- K-Personal MCP 로 화면 캡처해 UI 검증
- 빌드·실행도 Bash 도구로 직접
- 파일 변경 즉시 Vite HMR 적용

## 전환 방법

### 1. 터미널 열기

```powershell
cd C:\Users\user\Documents\K-Desktop-Agent
claude
```

(`claude` 는 `$env:CLAUDE_CODE_GIT_BASH_PATH` 이미 설정돼 있으니 바로 실행 가능)

### 2. Claude Code 세션에서 프로젝트 인식 확인

Claude Code CLI 가 자동으로:
- `CLAUDE.md` 읽어서 프로젝트 컨텍스트 확보
- 현재 디렉터리 = 작업 루트 인식

첫 프롬프트 예시:
```
프로젝트 상태 확인하고 남은 Phase 뭐 있는지 요약해줘
```

→ Claude가 `CLAUDE.md` + `ROADMAP.md` 읽어서 요약.

### 3. 특정 Phase 진행 요청

```
Phase 2 진행해줘
```

→ Claude가 `docs/PHASE-2-TRAY.md` 읽고:
1. 변경할 파일 목록 요약 제시
2. K님 승인 후 Edit/Write 도구로 실제 수정
3. 수정 후 `.\scripts\run-dev.ps1` 재실행 지시 (또는 직접 Bash)
4. 성공 기준 체크

## 워크플로우 예시

### "Phase 2 진행해줘"

1. Claude: "docs/PHASE-2-TRAY.md 읽고 있어요. 다음 파일들 수정 예정:
   - src-tauri/src/lib.rs (트레이 + 창 close 핸들러)
   - src-tauri/capabilities/default.json (권한)
   - src/components/Settings.tsx (새 파일)
   - src/App.tsx (Settings 토글)
   
   진행할까요?"
2. K: "응, ㄱㄱ"
3. Claude: [Edit 도구로 파일 수정]
4. Claude: "수정 끝. `run-dev.ps1` 재시작 해주세요"
5. K: [재시작 후 테스트]
6. K: "트레이 아이콘 안 보여"
7. Claude: [K-Personal MCP 로 스크린샷 찍어 확인, 버그 수정]

### "이거 좀 이상한데 왜 이러지"

Claude에게 현상을 설명하면:
- `Bash` 도구로 로그 확인
- `Read` 도구로 코드 읽기
- `mcp__k-personal__cc_screenshot` 으로 시각적 디버깅

## Cowork 세션과의 관계

| 언제 어느 걸 쓰나 | |
|---|---|
| **평소 개발** | Claude Code CLI (이 방법) |
| **디자인 목업·기획 논의** | Cowork (멀티모달, 아티팩트) |
| **복잡한 리팩토링·아키텍처 검토** | Cowork (긴 컨텍스트·여러 파일 동시 검토에 유리) |
| **문제 해결 막혔을 때 둘째 의견** | Cowork |
| **릴리즈 노트·문서 작성** | 둘 다 OK |

## 파일 변경 반영 방법

### Vite HMR 이 자동 반영
- `src/**/*.tsx`, `src/**/*.ts`, `src/**/*.css`

### 재시작 필요
- `src-tauri/**/*.rs` (Rust 재컴파일)
- `src-tauri/tauri.conf.json`
- `sidecar/src/*.ts` (Node 프로세스 재기동)

Claude Code 세션에서 재시작은 Bash 로 직접:
```bash
# run-dev 터미널에서 Ctrl+C
# 새 Bash 세션에서
npm run tauri:dev
```

## 팁

- **변경 사항은 작게, 자주** 테스트. 한 번에 여러 파일 수정하면 에러 원인 찾기 힘듦.
- **git 초기화 권장**: `git init && git add -A && git commit -m "Phase 3 complete"` — 되돌리기 쉽게.
- **CLAUDE.md 는 계속 업데이트**: Phase 완료 시 "현재 상태" 섹션 갱신 요청. Claude 가 다음 세션에서 정확히 파악.
- **이상하면 초기화 말고 백업부터**: `Copy-Item K-Desktop-Agent ...-backup -Recurse` 먼저.

## 긴급 연락 / 참고

- Claude Code CLI 로그인 문제: `claude login` 다시
- Claude Agent SDK 버전 문제: `npm view @anthropic-ai/claude-agent-sdk versions`
- Tauri 2.x 공식 문서: https://tauri.app/v2/
- K-Personal MCP 서버 위치: `C:\Users\user\Documents\K-Personal-MCP\server.py`
