# K Desktop Agent

개인 Windows 자동화용 Claude 채팅 앱. Tauri (Rust + React) 기반, K-Personal MCP와 연동.

**디자인**: P3Torrent 인스파이어드 HUD 스타일 (다크 + 시안 네온).

## 현재 상태

**Phase 1 + UI 재디자인 완료** — 실제 Claude 연결, 1200×800 3분할 레이아웃.

## 사전 준비

### 도구 설치 (아직 안 했으면)

PowerShell 관리자 권한에서:

```powershell
cd C:\Users\user\Documents\K-Desktop-Agent
.\scripts\setup.ps1
```

(Rust, Node, Visual Studio Build Tools, npm 의존성 자동 설치)

### Claude 로그인 (최초 1회)

```powershell
$claudeExe = Get-ChildItem "$env:LOCALAPPDATA\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code" -Recurse -Filter "claude.exe" | Select-Object -First 1 -ExpandProperty FullName
& $claudeExe setup-token
```

## 실행

```powershell
.\scripts\run-dev.ps1
```

## 빌드 (MSI 인스톨러)

```powershell
.\scripts\build-msi.ps1
```

## 프로젝트 구조

```
K-Desktop-Agent/
├── src/                         React 프론트엔드
│   ├── App.tsx                  메인 앱 (이벤트 핸들링)
│   ├── App.css                  P3Torrent 스타일 시스템
│   ├── index.css                디자인 토큰 + 폰트
│   ├── types.ts                 공유 TypeScript 타입
│   └── components/
│       ├── Sidebar.tsx          좌측 사이드바 (대화 목록, 툴)
│       ├── MainChat.tsx         중앙 채팅 영역
│       ├── Composer.tsx         입력창
│       ├── Message.tsx          메시지 렌더러
│       ├── MetricsPanel.tsx     하단 미터 패널
│       └── CornerBrackets.tsx   모서리 L자 장식
├── src-tauri/                   Rust 백엔드
│   ├── Cargo.toml
│   ├── tauri.conf.json          창 크기, 번들 설정
│   ├── capabilities/            Tauri 2.x 권한
│   └── src/
│       ├── main.rs
│       └── lib.rs               sidecar 프로세스 관리, IPC
├── sidecar/                     Node.js 사이드카
│   └── src/index.ts             Claude Agent SDK 연결
├── scripts/                     PowerShell 편의 스크립트
└── package.json
```

## 로드맵

- [x] **Phase 0**: 스캐폴드, Rust-React 왕복 (에코)
- [x] **Phase 1 + UI**: 실제 Claude 연결, P3Torrent 스타일
- [ ] Phase 2: 시스템 트레이, 자동 시작
- [ ] Phase 3: K-Personal MCP 자동 등록
- [ ] Phase 4: SQLite 대화 히스토리
- [ ] Phase 5: 마크다운 렌더링, MSI 인스톨러

## 디자인 시스템

주요 토큰은 `src/index.css` 의 `:root` 에 정의:

- 색상: `--bg-0` ~ `--bg-4`, `--accent` (시안), `--warn` (오렌지), `--text-primary/secondary/tertiary`
- 폰트: `--font-display` (Space Grotesk), `--font-body` (Inter), `--font-mono` (JetBrains Mono)
- 간격: `--space-xs` ~ `--space-2xl`
- 반경: `--radius-sm/md/lg`

컴포넌트 간 일관성을 위해 항상 이 토큰들을 사용. 하드코딩 금지.

## 라이선스

개인용.
