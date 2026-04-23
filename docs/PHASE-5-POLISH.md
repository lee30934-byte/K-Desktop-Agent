# Phase 5 상세 — 마크다운 렌더링 + 인스톨러

## 목표

**두 가지 독립적 작업**이지만 "배포 준비" 맥락으로 같이 묶음.

1. **마크다운**: Claude 응답의 `**볼드**`, `- 리스트`, ```코드블록``` 등이 제대로 렌더링되어 가독성 대폭 향상
2. **인스톨러**: MSI/NSIS 빌드 후 지인들이 한 번 클릭으로 설치 가능

---

## 부분 1: 마크다운 렌더링

### 의존성 추가

```powershell
cd C:\Users\user\Documents\K-Desktop-Agent
npm install react-markdown remark-gfm rehype-highlight rehype-raw
npm install -D @types/react-markdown
```

### Message 컴포넌트 수정

**`src/components/Message.tsx`**:

```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-shell";
import "highlight.js/styles/github-dark.css";  // 하이라이트 테마

// assistant 메시지 렌더링 부분:
{message.role === "assistant" ? (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    rehypePlugins={[rehypeHighlight]}
    components={{
      a: ({ href, children }) => (
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            if (href) openUrl(href);
          }}
        >
          {children}
        </a>
      ),
      code: ({ inline, className, children }) =>
        inline ? (
          <code className="md-inline-code">{children}</code>
        ) : (
          <pre className="md-code-block">
            <code className={className}>{children}</code>
          </pre>
        ),
    }}
  >
    {message.content}
  </ReactMarkdown>
) : (
  message.content
)}
```

### 스타일링

`App.css` 에 추가:

```css
.md-inline-code {
  background: var(--bg-0);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 1px 6px;
  font-family: var(--font-mono);
  font-size: 0.9em;
  color: var(--accent);
}

.md-code-block {
  background: var(--bg-0);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  margin: var(--space-md) 0;
}

.msg-assistant ul,
.msg-assistant ol {
  padding-left: var(--space-xl);
  margin: var(--space-sm) 0;
}

.msg-assistant li {
  margin: 2px 0;
}

.msg-assistant strong {
  color: var(--accent);
  font-weight: 600;
}

.msg-assistant h1,
.msg-assistant h2,
.msg-assistant h3 {
  font-family: var(--font-display);
  margin: var(--space-md) 0 var(--space-sm);
}

.msg-assistant h1 {
  font-size: 18px;
}
.msg-assistant h2 {
  font-size: 16px;
}
.msg-assistant h3 {
  font-size: 14px;
}

.msg-assistant blockquote {
  border-left: 3px solid var(--accent);
  padding-left: var(--space-md);
  color: var(--text-secondary);
  margin: var(--space-sm) 0;
}

.msg-assistant a {
  color: var(--accent);
  text-decoration: underline;
  cursor: pointer;
}

.msg-assistant a:hover {
  text-decoration: none;
}
```

### 외부 링크 열기

`src-tauri/capabilities/default.json` 에 이미 `shell:allow-open` 있음. 링크 클릭 시 기본 브라우저로.

### 이미지 표시 (스크린샷 결과 등)

MCP 도구가 이미지 반환하면 (예: base64 또는 파일 경로) Message.tsx에서 렌더링:

```tsx
// tool_result에 이미지 경로가 있으면
{toolOutput.startsWith("data:image") ? (
  <img src={toolOutput} alt="Tool output" className="tool-image" />
) : (
  <pre>{toolOutput}</pre>
)}
```

---

## 부분 2: 인스톨러 빌드

### 아이콘 업그레이드 (선택)

임시 "K" 아이콘을 K님 취향의 디자인으로 교체. 512×512 PNG 만들고:

```powershell
npx @tauri-apps/cli icon .\my-icon.png
```

### 버전 관리

`src-tauri/tauri.conf.json` 의 `version` 과 `package.json` 의 `version` 맞추기.

향후 업데이트 시 버전만 올리면 MSI가 자동 upgrade됨.

### 릴리즈 빌드

```powershell
.\scripts\build-msi.ps1
```

결과물:
- `src-tauri/target/release/bundle/msi/*.msi` — MSI 인스톨러
- `src-tauri/target/release/bundle/nsis/*-setup.exe` — NSIS 인스톨러 (대안)

### 서명 (선택)

코드 서명 인증서 있으면:
```json
// tauri.conf.json bundle 섹션에:
"windows": {
    "certificateThumbprint": "...",
    "digestAlgorithm": "sha256",
    "timestampUrl": "http://timestamp.digicert.com"
}
```

없으면 Windows SmartScreen이 "알 수 없는 게시자" 경고 — 지인들에게 "추가 정보 → 실행" 누르라고 안내.

### 설치 파일 검증

- 빈 폴더에 복사해서 **더블클릭 설치** 테스트
- 설치 후 시작 메뉴에 K Desktop Agent 등록 확인
- 실행 → 창 뜨는지, MCP 연결되는지 확인
- 언인스톨러 동작 확인

### 지인 배포용 패키지

`release/` 폴더 만들어서:
- `K-Desktop-Agent-Setup.msi`
- `README.txt` — 한국어 간단 설치 가이드
- `최초실행-셋업.ps1` — 지인 PC에서 필요한 게 있으면 (Git Bash 체크 등)

예: 간단한 README.txt

```
K Desktop Agent v0.1.0

설치:
  1. K-Desktop-Agent-Setup.msi 더블클릭
  2. 설치 마법사 따라가기
  3. 시작 메뉴에서 "K Desktop Agent" 실행

최초 실행 시:
  - Git for Windows 필요 (없으면 알림 → https://git-scm.com/downloads/win)
  - Python 3.10+ 필요 (없으면 알림 → https://python.org)
  - Claude Max/Pro 구독 로그인 (브라우저 자동 열림)

문의: kcppride@gmail.com
```

### 자동 업데이트 (선택, 나중에)

`tauri-plugin-updater` 써서 GitHub Release 에서 새 버전 자동 체크 가능. 지금은 불필요.

---

## 성공 기준

### 마크다운
- [ ] `**볼드**`, `*이탤릭*`, `~~취소선~~` 렌더링
- [ ] `# 헤더` 1/2/3 레벨 스타일
- [ ] 번호/불릿 리스트
- [ ] 인라인 코드 `` `code` `` 색상 적용
- [ ] ```python ``` 코드블록 신택스 하이라이팅
- [ ] 링크 클릭 → 기본 브라우저에서 열림
- [ ] 표(table) 렌더링 (GFM)

### 인스톨러
- [ ] MSI 빌드 성공 (20~30MB 예상)
- [ ] 다른 폴더에서 .msi 더블클릭 → 설치
- [ ] 시작 메뉴에 바로가기
- [ ] 설치된 앱 실행 → 정상 동작
- [ ] 언인스톨 → 깨끗하게 제거

## 주의점

- **react-markdown v9+** 에서 inline prop 동작 바뀜. 공식 문서 확인.
- **highlight.js** CSS는 `node_modules/highlight.js/styles/` 에서 선택. `github-dark` 가 P3Torrent와 잘 어울림.
- **빌드 크기**: Rust release 빌드 LTO 켜놨으니 ~20MB. Vite 빌드가 0.5~1MB 정도 추가.
- **서명 없는 MSI**: Windows SmartScreen 경고. 지인용이라면 용인, 상업 배포라면 서명 필수.
