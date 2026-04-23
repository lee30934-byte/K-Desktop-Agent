# Scripts

일상적으로 쓸 스크립트 모음.

| 파일 | 용도 | 언제 씀 |
|---|---|---|
| `setup.ps1` | 최초 환경 셋업 (Rust·Node·VS BuildTools·npm) | 프로젝트 받은 직후 한 번 |
| `run-dev.ps1` | 개발 모드 실행 | 매번 작업할 때 |
| `build-msi.ps1` | 릴리즈 빌드 (MSI/NSIS) | 지인 배포용 파일 만들 때 |

## 첫 실행 체크리스트

1. PowerShell **관리자 권한**으로 열기
2. `cd C:\Users\user\Documents\K-Desktop-Agent`
3. `.\scripts\setup.ps1`
4. (스크립트 완료 후) **새 PowerShell 창** 열기 (PATH 갱신 위해)
5. `.\scripts\run-dev.ps1`

## 실행 정책 에러

```
... this script cannot be loaded because running scripts is disabled on this system
```

→ PowerShell에서 한 번만:
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```
그리고 Y.
