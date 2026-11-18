/**
 * Codex 추론 강도(reasoning effort) — 모델별 지원 단계와 보정.
 *
 * 근거 (2026-11-19, Codex CLI 0.170.0 `~/.codex/models_cache.json` + 실제 호출):
 *   - 현행 모델은 low · medium · high · xhigh · max · ultra 를 지원한다. GPT-6/5.6 Luna 는 ultra 가 없다.
 *   - `minimal` 은 어느 현행 모델도 지원하지 않는다. gpt-6.2-sol + minimal → 400
 *     "Unsupported value: 'minimal' is not supported". 예전 설정에 남은 minimal 은 low 로 바꾼다.
 *   - 실호출 확인: gpt-6.2-sol ultra / gpt-6.2-astra max / gpt-6-luna xhigh → rc=0.
 *     gpt-6-luna ultra 는 서버가 받았지만 카탈로그에 없으므로 max 로 보정한다(문서화된 값만 보낸다).
 *
 * 앱 화면 · Rust · 사이드카 세 곳이 같은 단계 목록을 쓴다. 이 파일이 화면 쪽 정본이다.
 */

export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

const FULL: readonly ReasoningLevel[] = REASONING_LEVELS;
const NO_ULTRA: readonly ReasoningLevel[] = ["low", "medium", "high", "xhigh", "max"];
/** 카탈로그에 없는 옛 모델(gpt-5.5, o3 등)은 오래 지원된 세 단계만 보낸다. */
const LEGACY: readonly ReasoningLevel[] = ["low", "medium", "high"];

const MODEL_LEVELS: Record<string, { levels: readonly ReasoningLevel[]; defaultLevel: ReasoningLevel }> = {
  "gpt-6.2-sol": { levels: FULL, defaultLevel: "low" },
  "gpt-6.2-astra": { levels: FULL, defaultLevel: "low" },
  "gpt-6.1-sol": { levels: FULL, defaultLevel: "low" },
  "gpt-6.1-terra": { levels: FULL, defaultLevel: "low" },
  "gpt-6-astra": { levels: FULL, defaultLevel: "medium" },
  "gpt-6-sol": { levels: FULL, defaultLevel: "medium" },
  "gpt-6-luna": { levels: NO_ULTRA, defaultLevel: "medium" },
  "gpt-5.6-sol": { levels: FULL, defaultLevel: "low" },
  "gpt-5.6": { levels: FULL, defaultLevel: "low" },
  "gpt-5.6-terra": { levels: FULL, defaultLevel: "medium" },
  "gpt-5.6-luna": { levels: NO_ULTRA, defaultLevel: "medium" },
};

export const REASONING_LABELS: Record<ReasoningLevel, { label: string; desc: string }> = {
  low: { label: "낮음 (low)", desc: "빠름 · 가벼운 추론" },
  medium: { label: "중간 (medium)", desc: "균형 — 일반 작업" },
  high: { label: "높음 (high)", desc: "깊은 추론 — 복잡한 문제" },
  xhigh: { label: "매우 높음 (xhigh)", desc: "더 깊은 추론 · 느림" },
  max: { label: "최대 (max)", desc: "아주 깊은 추론 · 느리고 사용량 많음" },
  ultra: { label: "울트라 (ultra)", desc: "가장 깊은 추론 · 가장 느리고 사용량 많음" },
};

export function isReasoningLevel(v: unknown): v is ReasoningLevel {
  return typeof v === "string" && (REASONING_LEVELS as readonly string[]).includes(v);
}

/** 저장값 정규화. 옛 minimal → low, default/모르는 값 → undefined(모델 기본값). */
export function normalizeStoredEffort(v: string | null | undefined): ReasoningLevel | undefined {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "minimal") return "low";
  return isReasoningLevel(s) ? s : undefined;
}

/** 모델이 지원하는 단계. 모델 미지정(ChatGPT 기본 모델)이면 현행 카탈로그 공통값(ultra 제외)을 쓴다. */
export function levelsForModel(model: string | null | undefined): readonly ReasoningLevel[] {
  const id = (model ?? "").trim().toLowerCase();
  if (!id || id === "default" || id === "auto") return NO_ULTRA;
  return MODEL_LEVELS[id]?.levels ?? LEGACY;
}

export function defaultLevelForModel(model: string | null | undefined): ReasoningLevel | undefined {
  const id = (model ?? "").trim().toLowerCase();
  return MODEL_LEVELS[id]?.defaultLevel;
}

/**
 * 고른 단계를 실제 모델이 받을 수 있는 값으로 맞춘다.
 * 지원하지 않는 높은 단계는 그 모델의 가장 높은 단계로 낮추고, 낮은 쪽은 가장 낮은 단계로 올린다.
 */
export function clampEffortForModel(
  effort: string | null | undefined,
  model: string | null | undefined,
): ReasoningLevel | undefined {
  const want = normalizeStoredEffort(effort);
  if (!want) return undefined;
  const allowed = levelsForModel(model);
  if (allowed.includes(want)) return want;
  const rank = REASONING_LEVELS.indexOf(want);
  const below = allowed.filter((l) => REASONING_LEVELS.indexOf(l) <= rank);
  return below.length ? below[below.length - 1] : allowed[0];
}
