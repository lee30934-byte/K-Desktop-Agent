# 다른 PC 에서 KDA 개발 + Release 올리기

> Phase 96 (v0.6.38) — K 가 lee30 같은 추가 PC 에서도 코드 수정 + GitHub release 트리거 가능하게 하는 단계 안내. 회사 PC (DESKTOP-AUDU6JT) 와 동일한 dev 환경을 셋업하는 정답 경로.

## 🎯 결론 한 줄

**K 의 어느 PC 에서든 `git push origin main && git push origin vX.Y.Z` 만 하면 GitHub Actions 가 자동으로 Tauri release 빌드 + sign + publish.** Signing key 는 K 의 PC 어디에도 있을 필요 없음 — GitHub Secrets 에만 있음. ⚠️ **절대 새 키 만들지 말 것** (`memory/pitfall_tauri_signing_key_rotation.md`).

따라서 추가 PC 는 ① 코드 수정 가능한 환경 + ② git push 인증 두 가지만 갖추면 끝.

## 🚀 lee30 PC 의 일회성 셋업 (한 번만)

### 0. 사전 확인

PowerShell 에서:
```powershell
git --version
# git version 2.x.x  ← 있으면 OK. 없으면 winget install Git.Git 또는 git-scm.com
```

### 1. 소스 코드 clone

```powershell
cd $env:USERPROFILE\Documents
git clone https://github.com/lee30934-byte/K-Desktop-Agent.git
cd K-Desktop-Agent
```

> 첫 `git clone` 시 GitHub 인증 팝업이 뜰 수 있음 — K 의 평소 GitHub 계정 (lee30934-byte) 으로 OAuth 진행. 이후 push 도 동일 credential 사용.

### 2. dev 의존성 일괄 설치

**관리자 권한 PowerShell** 을 열고:

```powershell
cd $env:USERPROFILE\Documents\K-Desktop-Agent
.\scripts\setup.ps1
```

스크립트가 자동 설치 (이미 있으면 skip):
- Rust (rustup) — Tauri 의 Rust 컴파일
- Node.js LTS — frontend / sidecar
- Visual Studio 2022 Build Tools (C++ 워크로드) — **~6GB, 15~25분** ⏰
- `npm install` (프로젝트 의존성)

⚠️ Build Tools 설치 끝나면 시스템 재부팅 권장. PATH 갱신 필요.

### 3. KDA 본체 런타임 의존성

KDA 가 처음 실행될 때 first-run 마법사가 자동 호출. 별도 단계 없음. (Claude CLI / Codex CLI / Python / K-Personal-MCP 등.) 수동 실행은 `scripts/install-deps.ps1`.

### 4. OAuth 로그인 (필수 1회)

KDA 실행 후 Settings → AI 탭:
- Claude (Max OAuth): "claude login" 버튼
- Codex (ChatGPT): "codex login" 버튼

회사 PC 와 별도 계정 인증 필요 (Claude/Codex 의 토큰은 PC 마다 별도 저장).

### 5. (선택) 바탕화면 바로가기 — `npm run tauri:dev` 더블클릭 launcher

```powershell
.\scripts\create-dev-shortcut.ps1
```

바탕화면에 **"KDA Dev"** 아이콘 생성. 더블클릭 시 PowerShell 창이 떠서 자동으로 `cd <repo> && npm run tauri:dev`. 매번 터미널 열고 cd 칠 필요 없음. 각 PC 에서 한 번씩 실행하면 그 PC 의 바탕화면에 박힘 (자동 sync 가 아니라 *방법의 재현성* — 미래에 PC 추가될 때마다 같은 명령 한 번).

## 🔧 일상 개발 흐름

### 코드 수정 + 로컬 검증

```powershell
cd $env:USERPROFILE\Documents\K-Desktop-Agent

# (선택) 최신 main 동기화
git pull origin main

# 코드 수정 (VSCode / Cursor / 어디서든)

# 검증 1: TypeScript 컴파일 (3초)
npm run build

# 검증 2: dev 실행 (Tauri 로 KDA 띄움)
npm run tauri:dev
# → 첫 실행 시 Rust deps 컴파일 2~5분 ☕. 이후엔 incremental 로 빠름.
```

### Release 올리기

```powershell
# 1. package.json / Cargo.toml / tauri.conf.json 의 version 을 다음 미사용 버전으로 bump
#    (또는 scripts\bump-version.ps1 자동화 사용 — 있다면)

# 2. 빌드 검증
npm run build

# 3. commit
git add .
git commit -m "feat(vX.Y.Z): ..."

# 4. tag + push
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z

# 5. GitHub Actions 가 자동 트리거 — ~14분 후 release publish
#    https://github.com/lee30934-byte/K-Desktop-Agent/releases
```

⚠️ **버전 bump 시 4개 파일 동기화 필수** — `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.lock` (안의 `name = "k-desktop-agent"` 블록). 빠뜨리면 Actions 빌드 실패.

## 🔐 Git push 인증

처음 `git push` 할 때 Windows 의 **Git Credential Manager** 가 OAuth 팝업을 띄움:

1. 팝업의 "Sign in with your browser" 클릭
2. 기본 브라우저에 GitHub OAuth 페이지 뜸
3. K 의 GitHub 계정 (lee30934-byte) 으로 승인
4. credential 이 Windows 자격 증명 관리자에 저장됨 — 다음부터 자동

⚠️ `pitfall_oauth_embedded_webview.md` 참고 — OAuth 는 항상 시스템 기본 브라우저에서.

만약 팝업이 안 뜨거나 인증 실패하면 GitHub CLI 로 대체:
```powershell
winget install GitHub.cli
gh auth login
# → 브라우저 OAuth + Git credential helper 자동 셋업
```

## 🧠 Memory Sync (이미 활성)

K 의 `~/.kda/memory/` 누적 메모리는 Phase 94 (v0.6.36) 부터 두 PC 간 자동 양방향 sync. lee30 PC 에서 새 pitfall/feedback 추가하면 30분 안에 회사 PC 도 받음. 별도 셋업 불필요.

## 🔥 자주 만나는 함정 (메모리 함정 정리)

- **PowerShell BOM** (`pitfall_powershell_secret_bom.md`) — `Set-Content -Encoding UTF8` 은 BOM 박힘. 외부 도구 읽는 파일엔 `[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))` 사용.
- **Tauri signing key 절대 재생성 X** (`pitfall_tauri_signing_key_rotation.md`) — 새 키로 sign 한 release 는 기존 설치본의 인앱 updater 가 검증 못 함. lee30 에서 release 올려도 GitHub Actions 가 secrets 의 기존 키로 sign.
- **OAuth embedded webview** (`pitfall_oauth_embedded_webview.md`) — Google 정책으로 embedded WebView 안에서 OAuth 막힘. 항상 시스템 기본 브라우저로.
- **AhnLab V3 + ccusage** (`pitfall_av_blocks_bundled_native_binary.md`) — lee30 에 V3 깔려 있고 KDA 설정에서 ccusage polling 켜져 있으면 5분마다 알림 팝업. Settings → 시스템 → "Anthropic 사용량 폴링" toggle off.

## 📋 체크리스트 (lee30 PC 첫 셋업)

- [ ] git 설치 확인 (`git --version`)
- [ ] `git clone https://github.com/lee30934-byte/K-Desktop-Agent.git`
- [ ] **관리자 PowerShell** 에서 `.\scripts\setup.ps1` (15~25분)
- [ ] 재부팅
- [ ] 새 PowerShell 에서 `npm run tauri:dev` — 정상 실행 확인
- [ ] KDA 안에서 Claude / Codex OAuth 로그인
- [ ] (옵션) `git pull --no-rebase` 한 번 — memory sync repo 확인

체크리스트 완주하면 lee30 PC 가 회사 PC 와 완전 동일한 dev 환경. 일상 개발 흐름은 두 PC 어디서든.
