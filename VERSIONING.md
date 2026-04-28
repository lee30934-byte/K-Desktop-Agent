# K Desktop Agent 버전 관리 가이드

## 버전 체계 (Semantic Versioning)

```
MAJOR.MINOR.PATCH
  │     │     └─ 버그 수정, 사소한 변경
  │     └─────── 새 기능 추가 (하위 호환)
  └───────────── 큰 변경, 호환성 깨짐
```

### 버전 올리는 기준

| 변경 유형 | 버전 타입 | 예시 |
|-----------|-----------|------|
| 버그 수정, UI 미세 조정 | `patch` | 0.1.0 → 0.1.1 |
| 새 기능 추가, 설정 항목 추가 | `minor` | 0.1.0 → 0.2.0 |
| DB 스키마 변경, API 변경 | `major` | 0.1.0 → 1.0.0 |

---

## 자동화 스크립트 사용법

### 1. 버전 올리기

```powershell
# patch 버전 올리기 (0.1.0 → 0.1.1)
.\scripts\bump-version.ps1 patch

# minor 버전 올리기 (0.1.0 → 0.2.0)
.\scripts\bump-version.ps1 minor

# major 버전 올리기 (0.1.0 → 1.0.0)
.\scripts\bump-version.ps1 major

# 특정 버전으로 지정
.\scripts\bump-version.ps1 0.3.0
```

### 2. 스크립트가 자동으로 하는 것

- ✅ `package.json` 버전 업데이트
- ✅ `src-tauri/Cargo.toml` 버전 업데이트
- ✅ `src-tauri/tauri.conf.json` 버전 업데이트
- ✅ `CHANGELOG.md` 새 버전 항목 추가

### 3. 수동으로 해야 할 것

1. `CHANGELOG.md`에 변경사항 작성
2. Git 커밋 & 태그
3. 빌드

---

## 릴리스 프로세스

### 전체 플로우

```
[기능 개발 완료]
       ↓
.\scripts\bump-version.ps1 minor
       ↓
CHANGELOG.md 작성
       ↓
git add -A && git commit -m "chore: release v0.2.0"
       ↓
git tag v0.2.0
       ↓
npm run tauri:build
       ↓
[설치 파일 배포]
  - src-tauri/target/release/bundle/nsis/*.exe
  - src-tauri/target/release/bundle/msi/*.msi
```

### 한 줄 명령 (빠른 릴리스)

```powershell
# 패치 릴리스 (버그 수정 후)
.\scripts\bump-version.ps1 patch; git add -A; git commit -m "chore: release patch"; npm run tauri:build

# 마이너 릴리스 (새 기능 추가 후)
.\scripts\bump-version.ps1 minor; git add -A; git commit -m "chore: release minor"; npm run tauri:build
```

---

## 버전 관련 파일 목록

| 파일 | 위치 | 용도 |
|------|------|------|
| `package.json` | 루트 | npm 패키지 버전 |
| `Cargo.toml` | src-tauri/ | Rust 크레이트 버전 |
| `tauri.conf.json` | src-tauri/ | 설치 파일 버전 |
| `CHANGELOG.md` | 루트 | 변경 이력 |

---

## Claude에게 요청할 때

다음과 같이 요청하면 됩니다:

> "패치 버전 올리고 빌드해줘"
> "버전 0.2.0으로 올려줘"
> "마이너 버전 업데이트하고 릴리스해줘"

Claude가 자동으로:
1. `bump-version.ps1` 실행
2. CHANGELOG 업데이트 (필요시)
3. Git 커밋
4. 빌드 실행

---

## 현재 버전 확인

```powershell
# package.json에서 확인
(Get-Content package.json | ConvertFrom-Json).version

# 또는 모든 파일 한번에 확인
Select-String -Pattern '"version"' package.json, src-tauri\tauri.conf.json
```

---

## 자동 업데이트 (GitHub Releases)

### 동작 방식

1. 앱 실행 시 GitHub Releases에서 새 버전 확인 (30분마다 재확인)
2. 새 버전 발견 시 상단에 업데이트 배너 표시
3. "지금 업데이트" 클릭 → 백그라운드 다운로드 → 재시작

### GitHub 릴리스 생성 (자동)

```powershell
# 1. 버전 올리기
.\scripts\bump-version.ps1 minor

# 2. 커밋 & 태그
git add -A
git commit -m "chore: release v0.2.0"
git tag v0.2.0

# 3. 푸시 (GitHub Actions 자동 실행)
git push origin main --tags
```

### 필요한 GitHub Secrets

| Secret 이름 | 설명 |
|-------------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | 업데이트 서명용 개인키 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 개인키 암호 |

### 서명 키 생성 (최초 1회)

```powershell
# Tauri CLI로 키 생성
npx tauri signer generate -w ~/.tauri/k-desktop-agent.key

# 생성된 내용:
# - 개인키: ~/.tauri/k-desktop-agent.key
# - 공개키: 콘솔에 출력됨 → tauri.conf.json의 pubkey에 복사
```

### tauri.conf.json 설정

```json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/YOUR_USERNAME/K-Desktop-Agent/releases/latest/download/latest.json"
      ],
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6... (공개키)"
    }
  }
}
```
