// Phase 144 (v0.7.20) — W1 대화별 provider 해석 (순수 함수).
//
// 왜 별도 모듈인가:
//   종전엔 provider 결정이 App.tsx 안 4곳(2535 인라인 / 2736 buildSendSettings /
//   3842 인라인 …)에 흩어진 채 전부 localStorage 전역값을 직접 읽었다. 그래서
//   "대화 A 는 Claude, 대화 B 는 Codex" 가 원천적으로 불가능했고, task-watch 처럼
//   대화가 명시된 turn 도 "그 순간 전역에 켜져 있던 provider" 로 실행됐다.
//   결정 로직을 부작용 없는 함수 하나로 모아서 (a) 배선 누락을 없애고
//   (b) 전역을 반대값으로 세팅한 상태에서 대화별 값이 이기는지 실제로 테스트한다.
//
// 이 모듈은 React / Tauri / DOM 에 의존하지 않는다 (store 를 주입받는다).
// 테스트: sidecar/test-conversation-provider.mjs

export const LS_ACTIVE_PROVIDER = "kda_active_provider";
export const LS_ACTIVE_MODEL = "kda_active_model";
export const LS_API_KEYS = "kda_api_keys";

/** localStorage 호환 최소 인터페이스 (테스트에서 가짜 store 주입용) */
export interface ProviderKeyStore {
  getItem(key: string): string | null;
}

/** conversations 테이블에 저장된 대화별 고정값. 둘 다 null 이면 "전역 따름". */
export interface ConversationProviderPin {
  provider?: string | null;
  model?: string | null;
}

export interface ResolvedProviderSettings {
  provider: string;
  model: string | undefined;
  apiKey: string | undefined;
  /** "conversation" = 대화에 고정된 값, "global" = 전역 폴백. UI 표시/로그용. */
  source: "conversation" | "global";
}

function clean(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * 대화별 provider → 전역 폴백 → provider 에 맞는 API 키 순으로 확정한다.
 *
 * 규칙:
 *  1. pin.provider 가 있으면 그걸 쓴다 (전역 토글 무시). 이게 W1 의 핵심.
 *  2. 없으면 전역 kda_active_provider, 그것도 없으면 "claude" — 기존 동작 100% 보존.
 *  3. model:
 *     - pin.model 이 있으면 그걸 쓴다.
 *     - pin.provider 로 고정됐는데 pin.model 이 없으면, 전역 model 은 **확정 provider 와
 *       전역 provider 가 같을 때만** 물려받는다. 다르면 undefined → sidecar 가 그 엔진의
 *       기본 모델을 쓴다. (Claude 전역모델 "claude-fable-5" 를 Codex 대화에 넘기면
 *       엔진이 알 수 없는 모델로 죽거나 조용히 무시된다.)
 *  4. apiKey 는 **확정된 provider** 기준으로 읽는다. 전역값 기준으로 읽으면 Codex 대화에
 *     Gemini 키가 실리는 식으로 어긋난다. claude 는 Max 구독이라 키 불필요.
 *     gemini-cli 는 별도 입력란이 없어 gemini 키를 재사용 (기존 로직 유지).
 */
export function resolveProviderSettings(
  pin: ConversationProviderPin | null | undefined,
  store: ProviderKeyStore,
): ResolvedProviderSettings {
  let globalProvider = "claude";
  let globalModel: string | null = null;
  try {
    globalProvider = clean(store.getItem(LS_ACTIVE_PROVIDER)) || "claude";
    globalModel = clean(store.getItem(LS_ACTIVE_MODEL));
  } catch {
    globalProvider = "claude";
  }

  const pinnedProvider = clean(pin?.provider);
  const pinnedModel = clean(pin?.model);

  const provider = pinnedProvider || globalProvider;
  const source: "conversation" | "global" = pinnedProvider ? "conversation" : "global";

  let model: string | undefined;
  if (pinnedModel) {
    model = pinnedModel;
  } else if (!pinnedProvider || pinnedProvider === globalProvider) {
    model = globalModel ?? undefined;
  } else {
    model = undefined;
  }

  let apiKey: string | undefined;
  if (provider !== "claude") {
    try {
      const raw = store.getItem(LS_API_KEYS);
      if (raw) {
        const keys = JSON.parse(raw);
        if (keys && typeof keys === "object") {
          const k = clean(keys[provider]);
          apiKey = k ?? undefined;
          if (provider === "gemini-cli" && !apiKey) {
            apiKey = clean(keys["gemini"]) ?? undefined;
          }
        }
      }
    } catch {
      apiKey = undefined;
    }
  }

  return { provider, model, apiKey, source };
}

/** UI 표시용 라벨. 미지정 대화는 폴백 상태가 눈에 보이게 "전역 따름" 으로 나온다. */
export function providerLabel(provider: string | null | undefined): string {
  switch (clean(provider)) {
    case "claude": return "Claude";
    case "codex": return "Codex";
    case "gemini": return "Gemini";
    case "gemini-cli": return "Gemini CLI";
    case null: return "전역 따름";
    default: return String(provider);
  }
}

/** 대화별로 고정 가능한 provider 목록 (UI 선택지). null = 전역 따름. */
export const PINNABLE_PROVIDERS: Array<string | null> = [
  null,
  "claude",
  "codex",
  "gemini-cli",
  "gemini",
];
