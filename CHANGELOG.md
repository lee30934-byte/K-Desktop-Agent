# Changelog

모든 주요 변경사항을 여기에 기록합니다.
형식: [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/)

## [0.6.51] - 2026-05-29

### Fixed
- Hardened sidecar broken stdout pipe recovery: EPIPE/ERR_STREAM_DESTROYED now exits the Node sidecar so the Tauri parent can respawn it.
- Added startup timeout guard for cases where the sidecar never emits its first stdout event after spawn.
- Extended preflight markers so missing EPIPE/startup-timeout guards fail before release.

---

## [0.6.50] - 2026-05-29

### 추가
- sidecar heartbeat 이벤트와 Rust watchdog을 추가해 stdout/LLM stream 정지 시 sidecar를 자동 kill/respawn하도록 보강.

### 변경
- 릴리즈 기준을 원격 최신 v0.6.49 다음 버전인 v0.6.50으로 고정.

---

## [0.1.0] - 2025-01-XX

### 추가
- 기본 채팅 인터페이스
- Claude Agent SDK 통합 (대화 재개 지원)
- MCP 서버 연동 (k-personal)
- 대화 백업/복원 (JSON)
- 컨텍스트 압축 기능
- 다중 AI 프로바이더 설정 (Claude, GPT, Gemini)
- 에이전트 권한 토글 (자동/확인/수동)
- 6가지 UI 테마
- 한국어 UI

### 기술 스택
- Tauri 2.0 + React + TypeScript
- SQLite (대화 저장)
- Node.js Sidecar (Claude Agent SDK)

---
