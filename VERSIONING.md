# K Desktop Agent 버전 관리 가이드

## 원칙

릴리즈 버전의 기준은 로컬 파일이 아니라 `origin/main`과 원격 태그입니다. 로컬 repo가 뒤처진 상태에서 `package.json`만 보고 다음 버전을 정하면 안 됩니다.

릴리즈 전에는 다음 값이 모두 같아야 합니다.

- `package.json`
- `package-lock.json`
- `package-lock.json`의 root package entry
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- Git tag `vX.Y.Z`
- `CHANGELOG.md`의 `## [X.Y.Z] - YYYY-MM-DD` 항목

## 표준 절차

```powershell
git checkout main
git pull --ff-only origin main

.\scripts\bump-version.ps1 patch
# 또는 minor / major / 직접 버전: 0.8.0

.\scripts\check.ps1
npm run build

git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/tauri.conf.json CHANGELOG.md VERSIONING.md scripts .github
git commit -m "chore: release vX.Y.Z"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

## 자동 방지 장치

`scripts/release-version-guard.mjs`가 다음을 강제합니다.

- `bump-version.ps1` 실행 전 `git fetch origin main --tags`
- 현재 브랜치가 `main`인지 확인
- 로컬 `HEAD`가 `origin/main`과 같은지 확인
- worktree가 깨끗한지 확인
- 다음 버전이 최신 태그보다 큰지 확인
- 이미 존재하는 태그인지 확인
- 버전 파일 전체가 같은 값인지 확인
- Release workflow에서 태그와 버전 파일, CHANGELOG 항목이 일치하는지 확인

수동 확인 명령:

```powershell
npm run version:check
node scripts/release-version-guard.mjs next patch
node scripts/release-version-guard.mjs release v0.7.3
```

## 절대 하지 말 것

- 로컬 `package.json` 버전만 보고 다음 버전을 정하지 말 것.
- `git pull` 없이 버전 bump를 시작하지 말 것.
- 태그를 먼저 만들고 나중에 버전 파일을 맞추지 말 것.
- Tauri signing key는 버전 문제 해결 목적으로 재생성하지 말 것.
