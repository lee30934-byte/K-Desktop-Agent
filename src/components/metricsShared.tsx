import { useEffect, useState } from "react";
import type { SessionMetrics, RateLimitWindow } from "../types";

// v0.7.86 UI 5단계 — MetricsPanel(classic footer) · ContextRing(o2 입력창) · SessionUsagePanel(o2 세션 탭)
// 이 같은 계산·카드를 쓴다. 표시 % 와 자동 갱신 트리거 % 가 어긋나지 않도록 한 곳에서만 계산한다.

export interface ContextUsageInput {
  metrics: SessionMetrics;
  maxContextTokens: number;
  estimatedContextTokens?: number;
}

/**
 * 컨텍스트 사용량 (Phase 12 — Context Meter v2).
 * 우선순위:
 *   1) measuredContext = metrics.maxTurnContextTokens — sidecar 가 turn 내 message_start 들의
 *      (input + cc + cr) 최댓값으로 보낸 정확치. sub-agent 합산 부풀음 회피.
 *   2) estimatedContext = estimateConvTokens(messages) (App 에서 계산) — 첫 턴 전 fallback.
 *   3) rawTurnContext = metrics.currentContextTokens — result.usage 기반 raw. 비교용으로만 노출.
 */
export function computeContextUsage({ metrics, maxContextTokens, estimatedContextTokens }: ContextUsageInput) {
  const measuredContext = metrics.maxTurnContextTokens ?? 0;
  const rawTurnContext = metrics.currentContextTokens ?? 0;
  const estimatedContext = estimatedContextTokens ?? rawTurnContext;
  const displayContext = measuredContext > 0 ? measuredContext : estimatedContext;
  const contextSource: "measured" | "estimated" = measuredContext > 0 ? "measured" : "estimated";
  const rawContextUsage = (displayContext / maxContextTokens) * 100;
  // Phase 28 (v0.5.16): 부풀음 (1737% 같은 nonsense) UI 가드 — 100% 까지만 표시.
  const contextOverflowed = rawContextUsage > 100;
  const contextUsage = Math.min(rawContextUsage, 100);
  // 60/80% 색 경계 (footer 시절과 같음)
  const contextColor: "warn" | "accent" | undefined = contextOverflowed
    ? "warn"
    : contextUsage >= 80
    ? "warn"
    : contextUsage >= 60
    ? undefined
    : "accent";
  const remainingTokens = Math.max(0, maxContextTokens - displayContext);
  return {
    measuredContext, rawTurnContext, estimatedContext, displayContext, contextSource,
    rawContextUsage, contextOverflowed, contextUsage, contextColor, remainingTokens,
  };
}

export type ContextUsage = ReturnType<typeof computeContextUsage>;

/** 컨텍스트 상태 한 줄 안내 (툴팁/세션 탭 공통). */
export function contextHint(u: ContextUsage, maxContextTokens: number): string {
  return u.contextOverflowed
    ? "⚠️ 100% 초과 — 큰 tool 결과 (cc_screenshot 등) 의 base64 가 누적된 케이스. 새 대화 또는 압축 권장."
    : u.contextUsage >= 90 && u.contextSource === "measured"
    ? `⚠️ ${maxContextTokens >= 1_000_000 ? "1M 마장" : "한도"} 임박 — 모델이 이미 ${formatTokens(u.displayContext)} 입력받음. 큰 history 누적 대화면 새 대화 / 압축 권장`
    : u.contextUsage >= 90
    ? "⚠️ 세션이 곧 자동 갱신됩니다"
    : u.contextUsage >= 70
      ? "주의: 컨텍스트 70% 이상"
      : "✓ 정상 범위";
}

/** interval(ms) 마다 리렌더. active=false 면 타이머 없음. */
export function useNowTick(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const h = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(h);
  }, [intervalMs, active]);
  return now;
}

/** 세션 경과 시간. 매초 tick 은 이 작은 컴포넌트에만 머문다 (R9). */
export function SessionElapsed({ startedAt, active = true }: { startedAt: number; active?: boolean }) {
  const now = useNowTick(1000, active);
  return <>{formatDuration(Math.max(0, now - startedAt))}</>;
}

/**
 * Phase 15.5 — provider 의 5h / 주간 한도 표시.
 * 사용% + reset 까지 남은 시간. 카운트다운은 부모 리렌더(MetricsPanel 매초 tick,
 * SessionUsagePanel 은 탭이 열려 있을 때 30초 tick)로 갱신.
 */
export function RateLimitCard({
  label,
  window,
}: {
  label: string;
  window: RateLimitWindow;
}) {
  // 표시 우선순위:
  //   1) used_pct (한도 %) — provider 가 직접 줌 (Codex)
  //   2) time_pct (시간 진행률) — ccusage path 에서 block 시간 진행률, "한도 %" 아님
  //   3) used_tokens — 둘 다 없으면 토큰 수만
  const hasUsedPct = typeof window.used_pct === "number";
  const hasTimePct = typeof window.time_pct === "number";
  const showPct = hasUsedPct || hasTimePct;
  const pct = hasUsedPct
    ? Math.max(0, Math.min(100, window.used_pct!))
    : hasTimePct
      ? Math.max(0, Math.min(100, window.time_pct!))
      : 0;
  const remainMs = Math.max(0, window.reset_at - Date.now());
  // 한도 % (used_pct) 일 때만 warn 색. 시간 진행률은 그냥 accent.
  const accent = hasUsedPct
    ? pct >= 90
      ? "warn"
      : pct >= 70
        ? undefined
        : "accent"
    : "accent";

  // burn rate 위험 신호 — projection_remaining_min < remainingBlockMin 이면 한도 도달 위험
  const remainingBlockMin = remainMs / 60_000;
  const burnRateDanger =
    typeof window.projection_remaining_min === "number" &&
    window.projection_remaining_min > 0 &&
    window.projection_remaining_min < remainingBlockMin;

  const tooltip = [
    hasUsedPct
      ? `${label} 한도: ${pct.toFixed(1)}% 사용`
      : hasTimePct
        ? `${label} block 시간 진행률: ${pct.toFixed(0)}% (한도 % 아님 — Anthropic 비공개)`
        : `${label}: 사용량 추적`,
    `reset 까지: ${formatRemaining(remainMs)}`,
    window.used_tokens != null
      ? window.limit_tokens != null
        ? `누적 ${formatTokens(window.used_tokens)} / ${formatTokens(window.limit_tokens)} 토큰`
        : `누적: ${formatTokens(window.used_tokens)} 토큰`
      : null,
    typeof window.burn_rate_per_min === "number"
      ? `burn rate: ${formatTokens(window.burn_rate_per_min)} 토큰/분`
      : null,
    typeof window.projection_remaining_min === "number"
      ? burnRateDanger
        ? `⚠ 이 페이스면 한도 도달까지 ${Math.round(window.projection_remaining_min)}분 (block 끝나기 전!)`
        : `이 페이스면 한도 도달까지 ${Math.round(window.projection_remaining_min)}분 (안전)`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  // 카드 헤더 — 시간 진행률일 때 "5h ⏳" 처럼 시계 아이콘으로 한도% 와 구분
  const labelDisplay = hasUsedPct ? label : hasTimePct ? `${label} ⏳` : label;

  return (
    <div
      className={`metric-card context-monitor ${accent ? `metric-card-${accent}` : ""} ${burnRateDanger ? "metric-card-warn" : ""}`}
      title={tooltip}
    >
      <div className="eyebrow metric-label">{labelDisplay}</div>
      {showPct ? (
        <div className="context-bar-wrapper">
          <div className="context-bar">
            <div
              className={`context-bar-fill ${accent ? `context-bar-${accent}` : ""}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className={`context-percent mono ${accent ? `text-${accent}` : ""}`}>
            {pct.toFixed(0)}%
          </span>
        </div>
      ) : (
        <div className="metric-value mono">
          {window.used_tokens != null ? formatTokens(window.used_tokens) : "—"}
        </div>
      )}
      <div className="metric-sublabel mono" style={{ opacity: 0.7, fontSize: "10px", marginTop: 2 }}>
        ⏱ {formatRemaining(remainMs)}
        {window.used_tokens != null && (
          <>
            {" · "}
            <span style={{ opacity: 0.85 }}>{formatTokens(window.used_tokens)}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** Codex 사용량 raw payload 를 alert 로 보여 준다 (schema 진단용). */
export function showCodexRawPayload(payload: unknown) {
  try {
    const json = JSON.stringify(payload, null, 2);
    const truncated = json.length > 4000 ? json.slice(0, 4000) + "\n... (truncated)" : json;
    window.alert(`Codex API raw 응답:\n\n${truncated}`);
  } catch (e) {
    window.alert(`raw payload 표시 실패: ${String(e)}`);
  }
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return "reset 됨";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function formatTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1000000).toFixed(2)}M`;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
