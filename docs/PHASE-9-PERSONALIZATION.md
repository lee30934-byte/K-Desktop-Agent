# Phase 9 — 개인화 스킬 (자가 학습 + 실패 회피)

**상태: 설계 (2026-04-30)** — K의 누적 경험을 파일 시스템에 기록·로드해 매 세션 자동 적용. ROADMAP 의 기존 "자가 학습 (사용 패턴 기반 선제 제안)" 항목을 구체화.

## 왜 필요한가

K 와 누적 작업이 많아질수록 매번 같은 함정에 빠지고, K 의 선호·자주 쓰는 패턴을 새 세션마다 다시 설명해야 함. 이미 부분적으로 운영 중인 메모 시스템(`feedback_*.md`, `pitfall_*.md`)을 **자동화 + 로딩 + 회피 게이트**로 확장해, "한번 학습한 건 두 번째부터 자동으로 피한다" 를 만든다.

직전 v0.4.3 → v0.4.6 사고 (PowerShell BOM 주입 + Tauri 키 로테이션 강행) 가 정확히 이 메커니즘이 막을 수 있었던 케이스 — 이미 `pitfall_powershell_secret_bom.md` / `pitfall_tauri_signing_key_rotation.md` 로 기록됨.

---

## 핵심 설계 — 하이브리드 학습

| 카테고리 | 저장 위치 | 채우는 방식 | 트리거 |
|---|---|---|---|
| **선호** (스타일·도구·언어) | `feedback_*.md` | K 의 명시적 피드백을 Claude 가 정리 | K 가 "이거 기억해" / 명시적 선호 표명 |
| **실패** (pitfall) | `pitfall_*.md` | **자동 (PostToolUse Hook + 세션 종료 요약)** | 빌드 실패 / 같은 에러 2회 / K 가 "또 그러네" |
| **성공 패턴** | `pattern_*.md` | 세션 종료 시 Claude 가 요약 제안 → K 승인 후 저장 | 비파괴적 작업 완료 시 |
| **프로젝트 컨텍스트** | `CLAUDE.md` (각 repo) | 이미 운영 중 — Phase 완료마다 갱신 | Phase 완료 / 큰 의사결정 |

**자동성 vs 노이즈 균형**: 실패만 자동 (안전·고가치), 성공 패턴은 K 승인 게이트, 선호는 K 명시. 무분별한 PostToolUse 학습은 노이즈만 쌓임.

---

## 구현 — 4 단계

### 1. 메모리 디렉토리 표준화

기존 위치: `C:\Users\user\.claude\projects\C--Users-user-Documents-K-Desktop-Agent\memory\`

표준 파일명 규칙:
- `feedback_<topic>.md` — K 선호
- `pitfall_<topic>.md` — 회피해야 할 패턴
- `pattern_<topic>.md` — 잘 먹히는 패턴
- `MEMORY.md` — 세 카테고리 인덱스 (이미 운영 중)

각 파일은 frontmatter (`name`, `description`, `type`, `firstObservedDate`, `relatedRun?`) 필수.

### 2. 자동 로딩 — 이미 작동 중

Claude Code CLI 가 세션 시작 시 `MEMORY.md` 를 자동으로 읽어 system prompt 에 주입. K-Desktop-Agent 의 sidecar (Agent SDK) 도 같은 위치를 읽도록 설정 — `sidecar/src/index.ts` 의 system prompt 합성 로직에 다음 추가:

```ts
// pseudo-code
const memoryDir = path.join(claudeProjectsDir, projectKey, "memory");
const memoryFiles = await fs.readdir(memoryDir);
const memoryContext = memoryFiles
  .filter(f => f.endsWith(".md"))
  .map(f => `# ${f}\n${fs.readFileSync(path.join(memoryDir, f), "utf8")}`)
  .join("\n\n");
const systemPrompt = `${baseSystemPrompt}\n\n## K's accumulated memory\n\n${memoryContext}`;
```

7일 이상 된 메모는 system reminder 로 "stale 가능성" 표시 (Claude Code 가 이미 하는 패턴).

### 3. 자동 학습 — PostToolUse Hook (실패만)

Phase 4.5 의 `sidecar/hooks/preToolUse-overwriteGuard.mjs` 와 같은 디렉토리에 **새 hook**:

`sidecar/hooks/postToolUse-failureNote.mjs`:

```js
// 의사 코드
export default async function ({ toolName, output, exitCode, sessionContext }) {
  // 빌드 실패 / Bash exit code != 0 / 같은 에러 메시지 2회 등 시그널 감지
  if (looksLikeFailure(toolName, output, exitCode)) {
    const summary = await summarizeFailure(output, sessionContext);
    // 사용자에게 즉시 묻지 않고, 세션 메타에 누적
    appendToSessionFailureLog(summary);
  }
}
```

**핵심: 자동 저장은 안 함**. 세션 메타에 누적만 → 세션 종료 (또는 K 가 "/save-pitfall" 명령) 시점에 Claude 가 요약 제안 → K 승인 후 `pitfall_*.md` 생성.

이유: 자동 저장하면 일시적 에러 (네트워크 끊김 등) 가 영구 회피 규칙으로 굳어 노이즈 만든다. **K 승인 게이트**는 root-cause-fix 선호와도 부합.

### 4. 회피 게이트 — 메모를 단순 정보 → 행동 제약으로

Hook 단계에서 `pitfall_*.md` 를 단순히 system prompt 로 넣는 것을 넘어, **PreToolUse Hook 이 위험 패턴을 감지하면 차단**:

`sidecar/hooks/preToolUse-pitfallGuard.mjs` (신규):

```js
const PITFALL_PATTERNS = [
  {
    id: "powershell-secret-bom",
    test: (toolName, args) =>
      toolName === "Bash" &&
      /Get-Content -Raw.*\| gh secret set/.test(args.command),
    message: "BOM 주입 위험. --body-file 또는 cmd /c type ... | gh secret set --body - 사용",
    blocking: true,
  },
  {
    id: "tauri-key-rotation",
    test: (toolName, args) =>
      toolName === "Bash" && /tauri signer generate/.test(args.command),
    message: "키 로테이션은 K 설치본의 인앱 updater 를 끊습니다. 정말 필요한지 K 와 재확인.",
    blocking: false,  // 경고만
  },
];
```

`pitfall_*.md` 파일에 `hookPattern` 필드 (선택)를 두어 hook 이 자동 로드.

---

## UI / 운영 — Settings 모달 확장

새 탭 "Memory" 추가:

- 메모 목록 표시 (카테고리별)
- 각 항목 토글 (활성/비활성) — 잘못 학습된 항목 즉시 비활성화 가능
- "이번 세션의 학습 후보" 섹션 — Hook 이 모은 실패 시그널 → K 가 "저장" / "버림" 결정
- 메모 디렉토리 열기 버튼 (`shell.open`)

UI 는 Phase 4.5 의 권한 게이트 토글 패턴 재사용.

---

## 일정 / 의존성

| 단계 | 예상 | 비고 |
|---|---|---|
| 1. 메모리 디렉토리 자동 로딩 (sidecar) | 30분 | system prompt 합성에 디렉토리 읽기 추가 |
| 2. PostToolUse hook (실패 시그널 수집) | 1시간 | 세션 메타 누적만, 자동 저장 X |
| 3. 세션 종료 요약 → K 승인 → 저장 | 1.5시간 | 새 sidecar 메시지 타입 + Settings UI |
| 4. PreToolUse pitfall guard | 1시간 | Phase 4.5 hook 패턴 확장 |
| 5. Settings "Memory" 탭 | 1.5시간 | 토글 + 목록 + 후보 검토 UI |
| 6. 회귀 테스트 | 1시간 | hook unit test + 메모 로드 e2e |

**총: 6.5시간 (한 세션)**

의존성: Phase 4.5 의 hook 인프라 (이미 있음). 새 의존성 없음.

---

## 성공 기준

1. 새 세션 시작 → sidecar 가 모든 `feedback_*.md` / `pitfall_*.md` / `pattern_*.md` 를 system prompt 에 주입 (확인: `log("info", "memory loaded: N files")`)
2. PowerShell 에서 `Get-Content -Raw | gh secret set` 패턴을 Bash 도구로 시도 시 → PreToolUse hook 차단 + K 에게 회피책 안내
3. 빌드 실패 → 세션 끝에 Claude 가 "이번 실패를 pitfall 로 기록할까요?" 제안 → K 승인하면 자동 파일 생성
4. Settings → Memory 탭에서 메모 비활성화 → 다음 응답에 반영 (sidecar reload 1회 후)

---

## 위험 / 미정

- **노이즈**: 자동 학습 자가 폭주 위험 → "K 승인 게이트" 로 1차 방지. 추가로 "최근 7일 내 같은 패턴 3회 미만이면 후보 등록 안 함" 같은 임계치 필요할 수도.
- **프라이버시**: 메모 파일에 비밀번호/토큰 같은 민감정보 들어가면 위험. PostToolUse hook 의 `summarizeFailure` 단계에 redaction (정규식 기반: `[A-Za-z0-9+/]{40,}`, `password=...` 등 마스킹) 필수.
- **메모 충돌**: 같은 주제로 contradicting 메모가 누적될 위험 → 새 pitfall 등록 시 기존 메모와 sim-check (간단한 키워드 매칭) → 겹치면 K 에게 "기존 X 와 통합할까?" 물어보기.

---

## 다음 단계

K 가 이 설계에 ok 하시면, 1~6 순서대로 구현 시작. 가장 먼저 **1번 (메모리 디렉토리 자동 로딩)** 만 떼서 single-PR 로 먼저 검증하는 것을 권장 — 그것만으로도 즉시 가치가 있고, 이후 hook 들은 점진 추가.
