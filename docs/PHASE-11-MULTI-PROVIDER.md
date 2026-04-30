# Phase 11 — OpenAI / Google 계정 연동 (멀티 프로바이더)

**상태: G1 출하 완료 (2026-04-30)** — REST 모드 (OpenAI / OpenRouter / Gemini) 가 K-Personal MCP 도구를 직접 호출할 수 있게 됨. 나머지 갭 (G2~G5) 은 별도 단계로 진행.

## 📊 구현 진행 상황

| 갭 | 내용 | 상태 |
|---|---|---|
| **G1** | MCP function calling 어댑터 — GPT/Gemini 가 K-Personal MCP 의 45개 도구를 직접 호출 | ✅ **완료 (2026-04-30)** |
| **G2** | API key 를 localStorage 평문 → OS keyring 으로 이전 | 미진행 |
| **G3** | REST 경로에 이미지 첨부 지원 (현재 Claude CLI 만 처리) | 미진행 |
| **G4** | Strategy C 폴백 — Claude 거부/오류 시 자동 GPT/Gemini 재시도 | 미진행 |
| **G5** | 메시지별 모델 picker (현재 글로벌 1개) | 미진행 |

### G1 출하 내역 (2026-04-30)

**구현 모듈** (sidecar/src/):
- `mcpClient.ts` — JSON-RPC 2.0 over stdio MCP 클라이언트 (singleton + lazy spawn + concurrent-safe)
- `toolSchema.ts` — MCP JSON Schema → OpenAI / Gemini / Anthropic tool schema 변환기 + 라우팅 헬퍼
- `restTools.ts` — provider-별 streaming round runner (OpenAI 의 fragmented tool_calls 누적, Gemini 의 functionCall 파싱)

**index.ts 변경**: `handleViaRestAPI` 가 single-shot SSE 에서 multi-round tool-call 루프로 리팩토링됨. `MAX_TOOL_ROUNDS=8`, `MCP_CALL_TIMEOUT_MS=30_000`. Anthropic-via-REST 는 별개 protocol (tool_use content blocks) 이라 G1 범위 외 — text-only 유지.

**검증 (smoke-rest-tools)**:
- Layer 1 (mock HTTP, CI 안전): 33개 어설션 — fragmented JSON args 재조립, parallel tool calls, Gemini functionCall, message builders, namespacing
- Layer 2 (live K-Personal MCP): 9개 어설션 — 실제 cc_screen_size 호출 → "화면 크기: 1920 x 1080" 반환 ✓
- 회귀 테스트: 기존 smoke-sidecar / smoke-attachment 둘 다 통과 (Claude CLI 경로 무영향)

**디자인 결정**:
- 도구 이름은 `mcp__k-personal__fm_list_directory` 형태로 namespacing — 기존 `lockedTools`/`PERM_TOOL_MAP` 정책이 그대로 적용 (REST 와 Claude CLI 권한 일관성)
- Gemini schema sanitizer 는 OpenAPI 3.0 호환만 통과 (`additionalProperties`, `$schema`, unknown keys 제거). 첫 구현에서 properties 의 KEY 도 화이트리스트로 거른 버그 발견 → 수정 + 회귀 어설션 추가
- 도구 호출은 sequential (parallel 매력적이지만 mouse/keyboard/clip 순서 의존성 보호)
- Permission 재확인은 `dispatchModelToolCall` 안에서 defence-in-depth — 모델이 disallowed 도구를 호출하면 MCP 까지 가기 전에 거부

**아키텍처**:
```
sidecar (REST 경로)
  ├─ MCPClient (subprocess) ── k-personal-mcp/server.py
  │     ├─ initialize handshake (2.6s typical)
  │     ├─ tools/list  → 45개 schema 캐싱 (2ms)
  │     └─ tools/call  → 결과 반환
  ├─ toolSchema 변환기
  │     ├─ MCP JSON Schema → OpenAI {name, description, parameters}
  │     └─ MCP JSON Schema → Gemini functionDeclarations
  └─ multi-round driver (handleViaRestAPI)
        ├─ OpenAI: fragmented tool_calls delta 누적 → MCP call → role:"tool" 첨가 → 다음 라운드
        └─ Gemini: functionCall → MCP call → functionResponse → 다음 라운드
```

---

## ⏭️ 아래는 원래 설계 문서 (2026-04-30 작성, G1 출하 전 작성된 전략 분기)

## ⚠️ 정직한 시작 — 이건 Phase 4.5 보다 큰 작업

이 앱의 **핵심 자산** 은:
- Claude Agent SDK (sidecar 의 멀티턴·툴·resume·히스토리)
- K-Personal MCP 의 42개 도구 (스크린샷·자동화·DB 등)

OpenAI / Google 추가는 단순히 "API 키 설정" 이 아니라 **이 두 자산을 다른 SDK 위에서 재현해야 하는 작업** — 솔직히 큰 변경이다. 절차상 옵션도 두 개로 갈린다 (아래 "전략 분기").

## 왜 필요한가 (K 가 직전에 요청한 맥락)

추측: 모델 비교, Claude OAuth 차단 시 fallback, 특정 작업에 더 나은 모델 사용 (예: 코드는 Claude, 이미지 생성은 GPT-Image / Gemini Vision).

**확인 필요**: K 의 진짜 use case 가 다음 중 어느 쪽인지에 따라 설계가 완전히 달라짐:

| K 의 의도 | 추천 전략 |
|---|---|
| **(a) 같은 채팅창에서 모델만 토글** (히스토리·MCP 도구 공유) | 전략 A: 어댑터 레이어 |
| **(b) "다른 모델 = 다른 앱"** (각자 고유 컨텍스트) | 전략 B: 사이드카 분리 |
| **(c) Claude OAuth 차단 시 안전망만** | 전략 C: 폴백 전용 — Claude 가 거부할 때 GPT/Gemini 가 같은 prompt 재시도 |

**K, 이 중 어느 쪽인가요?** 나머지 설계는 (a) 를 기본 가정으로 작성 — 가장 흔한 멘탈 모델이고, (b)/(c) 는 (a) 의 부분집합으로 만들 수 있음.

---

## 전략 A — 어댑터 레이어 (가정: K 의도 = (a))

### 아키텍처

```
[프론트 React] ─── invoke ───┐
                              ▼
                    [Rust lib.rs ─ provider 라우팅]
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  sidecar-claude/      sidecar-openai/        sidecar-gemini/
  (현 sidecar)         (신규)                  (신규)
        │                     │                     │
        └────┬────────────────┴─────────────────────┘
             ▼
       MCP-to-FunctionCalling 어댑터
             │
             ▼
       K-Personal MCP (Python, 변경 없음)
```

### 핵심 — MCP 어댑터

K-Personal MCP 의 도구는 **MCP 프로토콜 (JSON-RPC over stdio)** 을 따름. Claude Agent SDK 는 이를 native 지원. OpenAI 와 Google 은 자기들 function calling 형식만 알고 MCP 는 모름.

**어댑터 의무**:
1. 시동 시 MCP 서버에서 도구 목록 (`tools/list`) 받아 OpenAI/Google function schema 로 변환
2. 모델이 function call 발행 → 어댑터가 MCP 의 `tools/call` 로 변환해 호출
3. MCP 결과 → 모델 형식으로 다시 변환 후 reply

**기존 오픈소스 후보** (시간 절약):
- `mcp-bridge` (TypeScript, MIT) — 이미 OpenAI / Anthropic / Gemini 변환기 내장
- `litellm` (Python) — 100+ 모델 통합 + 최근 MCP 지원 추가
- 직접 구현 — 약 ~300줄. 통제권 ↑, 의존성 ↓

### Provider 별 구현 포인트

| 항목 | OpenAI (GPT) | Google (Gemini) |
|---|---|---|
| **인증** | OAuth (ChatGPT 계정) 또는 API key | OAuth (Google 계정) 또는 API key |
| **SDK** | `openai` (Node) | `@google/generative-ai` (Node) |
| **스트리밍** | SSE | SSE |
| **함수 호출** | `tools` 파라미터 (json schema) | `tools` 파라미터 (function declarations) |
| **이미지 입력** | `image_url` content part | `inlineData` content part |
| **세션/resume** | 기본 stateless — sidecar 가 직접 history 관리 | 기본 stateless — 동일 |
| **사용량 측정** | `usage.{prompt,completion}_tokens` | `usageMetadata.{prompt,candidates}TokenCount` |

### OAuth — 어떻게 K 계정 연동하나

K 가 **API key 가 아니라 본인 계정 (ChatGPT Plus / Google AI Studio)** 으로 쓰고 싶다면:

- **OpenAI**: 공식적으로 ChatGPT Plus 구독은 **API 사용을 자동으로 주지 않음** — API 는 별도 결제. ChatGPT 의 OAuth 토큰을 외부에서 쓰는 건 ToS 위반. **현실: OpenAI 는 API key 발급이 정공법** (`platform.openai.com/api-keys`)
- **Google**: Gemini API 는 Google AI Studio 에서 무료 tier 제공 (분당 RPM 제한). API key 만으로 시작. 또는 GCP 서비스 계정으로 더 큰 quota.

**즉: "Claude Max OAuth 동등" 의 무비용 OAuth 통합은 OpenAI/Google 둘 다 지원 안 함**. Claude 가 예외적인 케이스 — Anthropic 이 Claude Max 구독에 SDK OAuth 를 묶어 제공한 것. 이 사실을 K 에게 정확히 전달하고 다음 옵션 중 선택:

| 옵션 | 비용 | UX |
|---|---|---|
| **API key** 입력 (OpenAI / Google AI Studio 둘 다) | OpenAI: 사용량 기반 / Gemini: 무료 tier 후 사용량 | Settings 에 API key 입력 필드. 가장 빠름. |
| **Google Cloud OAuth** (Gemini API in Vertex AI 모드) | GCP 사용량 기반 | OAuth flow 구현 필요 (~반나절) |
| **Claude Max 만 유지하고 GPT/Gemini 미연동** | 0 | 가장 단순 |

### Settings UI 변경

```
┌─ Settings ────────────────────────┐
│ ▼ Models                          │
│   [✓] Claude (현재) — OAuth 연동됨 │
│   [ ] OpenAI GPT — API key 필요   │
│       [_______________________]   │
│       [Save]                       │
│   [ ] Google Gemini — API key 필요│
│       [_______________________]   │
│       [Save]                       │
│                                    │
│   기본 모델: [Claude ▼]            │
│   채팅별 토글: 메시지 옆 모델 picker│
└────────────────────────────────────┘
```

API key 는 OS keyring (`@tauri-apps/plugin-stronghold` 또는 Windows Credential Manager) 에 저장 — `localStorage` 는 평문이라 금지.

### 일정 / 의존성

| 단계 | 예상 | 비고 |
|---|---|---|
| 1. provider abstraction (sidecar 내 인터페이스 정의) | 1일 | `IProvider` 타입 + Claude 구현부 분리 |
| 2. OpenAI provider 구현 | 1일 | function calling 매핑 포함 |
| 3. Gemini provider 구현 | 1일 | function calling 매핑 포함 |
| 4. MCP-to-FunctionCalling 어댑터 | 1일 | mcp-bridge 통합 또는 직접 구현 |
| 5. UI — model picker + API key 관리 | 1일 | keyring 통합 |
| 6. e2e 테스트 (각 모델로 K-Personal MCP 도구 호출) | 0.5일 | 회귀 |

**총: 5.5일 — Phase 9 보다 한 자리 수 큼**

새 의존성:
- frontend: `@tauri-apps/plugin-stronghold` (또는 keyring)
- sidecar: `openai`, `@google/generative-ai`, `mcp-bridge` (선택)

---

## 전략 B — 사이드카 분리 (가정: K 의도 = (b))

각 모델을 **별도 앱** 처럼 운영. 같은 Tauri 프로세스에서 sidecar 만 다중화:

- 사이드바에서 새 대화 만들 때 모델 선택 → 그 대화는 그 모델 sidecar 에 라우팅
- 대화별 `provider` 컬럼을 SQLite 에 추가
- MCP 어댑터는 여전히 필요하지만 provider 별 sidecar 가 자체 관리

**장점**: 각 SDK 의 native feature (예: Claude 의 resume) 를 그대로 살림. 어댑터 복잡도 ↓
**단점**: 같은 채팅에서 모델 토글 안 됨

전략 A 보다 30% 적은 작업량 (~4일).

---

## 전략 C — 폴백 전용 (가정: K 의도 = (c))

**가장 작은 변경**. Claude 가 정책 거부 / OAuth 만료 시 자동으로 GPT 또는 Gemini 에 같은 prompt 재시도:

- sidecar 에 `fallbackProvider` 옵션 추가
- Claude 응답이 정책 거부 패턴이면 폴백 호출
- MCP 도구는 폴백 시 비활성화 (어댑터 없음)
- Settings 에 "폴백 모델 = [없음 / GPT-4 / Gemini]" 한 줄

**총: 1일**. 단, MCP 도구를 폴백에서 못 쓰므로 자동화 작업은 Claude 만.

---

## 위험 / 미정

| 위험 | 완화 |
|---|---|
| ToS — ChatGPT 구독 OAuth 외부 사용은 위반 | API key 만 지원, 명시적 안내 |
| API key 유출 | keyring 저장. 메모리 누수 방지 위해 sidecar 가 환경변수로만 전달 받고 즉시 폐기 |
| MCP 도구의 모델별 호환성 차이 | 도구별 화이트리스트 (Claude 만 지원하는 도구 표시) |
| 비용 폭주 (의도치 않은 OpenAI API 호출) | Settings 에 일일 사용량 한도 + sidecar 가 한도 초과 시 차단 |
| 응답 품질 차이로 K 혼란 | 메시지 메타에 모델 표시 (P3Torrent UI 의 모서리 브래킷 옆) |

---

## K 결정 필요 — 진행 전 확인

1. **전략**: A (어댑터, ~5.5일) / B (분리, ~4일) / C (폴백, ~1일) — 어느 쪽?
2. **인증**: API key 만 (현실적) / OAuth 도 시도 (Google 만 가능) — 어느 쪽?
3. **우선순위**: Phase 9 (개인화) 와 어느 게 먼저? 저는 **Phase 9 먼저** 추천 — 작고 즉시 가치 있고, 그 학습 결과가 Phase 11 작업 자체에도 도움됨 (예: "OpenAI SDK 의 stream 처리는 SSE 끊김에 약함" 같은 학습).

K 의 답에 따라 본격 구현 시작.
