import { useEffect, useRef, useState, memo } from "react";
import CornerBrackets from "./CornerBrackets";
import type { SessionMetrics, RateLimitInfo } from "../types";

interface MetricsPanelProps {
  metrics: SessionMetrics;
  mcpConnected: boolean;
  currentModel?: string;
  maxContextTokens?: number;
  // Phase 46 (v0.5.34) — 분모 source 설명 ("GPT-5/codex 400K" 또는 "⚠ 매칭 실패 → 200K fallback")
  maxContextSource?: string;
  /**
   * 메시지 배열 기반 컨텍스트 추정치 (App 의 estimateConvTokens 결과).
   * 자동 갱신 트리거와 같은 지표라 표시 % 와 트리거 % 가 일치한다.
   * 미지정이면 fallback 으로 raw `metrics.currentContextTokens` 를 사용.
   */
  estimatedContextTokens?: number;
  onManualRefresh?: () => void;
  onCompressContext?: () => void;
  isCompressing?: boolean;
  /**
   * Phase 15.5 — 현재 active provider 의 5h primary + 7d secondary 한도.
   * provider 가 anthropic/codex 가 아니거나 아직 데이터 못 받았으면 null.
   */
  rateLimit?: RateLimitInfo | null;
  /**
   * Phase 29 (v0.5.17) — Codex usage polling 이 fail 한 사유. null 이면 정상 또는 미로그인 silent.
   * UI 가 visible warning 표시 + 재시도 버튼 노출.
   */
  codexUsageError?: string | null;
  /**
   * Phase 31 (v0.5.19) — normalize 실패 시의 raw payload. [Raw 보기] 버튼이 열어 표시.
   */
  codexUsageRawPayload?: unknown;
  onRetryCodexUsage?: () => void;
}

function MetricsPanel({
  metrics,
  mcpConnected,
  currentModel = "Opus 5.7 · 1M",
  maxContextTokens = 200000,
  maxContextSource,
  estimatedContextTokens,
  onManualRefresh,
  onCompressContext,
  isCompressing = false,
  rateLimit,
  codexUsageError,
  codexUsageRawPayload,
  onRetryCodexUsage,
}: MetricsPanelProps) {
  const [showContextDetails, setShowContextDetails] = useState(false);
  // 컨텍스트 카드 + 툴팁을 함께 감싸는 컨테이너 ref. 외부 클릭 감지용.
  // hover 토글에서 클릭 토글로 바꾼 이유: 툴팁이 카드 위로 띄워진 floating 패널이라
  // 마우스가 카드→툴팁 사이 갭(8px)을 지날 때 mouseLeave 가 발화하면서 닫혀버려
  // 안의 버튼(세션 초기화 / 대화 압축) 을 클릭할 수 없었음.
  const contextRef = useRef<HTMLDivElement | null>(null);

  // 매초 자체 리렌더 — Session 경과 시간 표시용.
  // 이전엔 App.tsx 의 setTick 으로 전체 트리가 리렌더돼서 메시지 ReactMarkdown 재파싱이
  // 매초 일어났음. 여기로 격리하면 매초 갱신 비용이 footer 한 줄에만 머문다.
  const [, setTick] = useState(0);
  useEffect(() => {
    const h = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(h);
  }, []);

  // 툴팁 열렸을 때만 외부 클릭 / ESC 감지 — 닫혀있을 땐 리스너 등록 안 해 비용 0.
  useEffect(() => {
    if (!showContextDetails) return;
    const onPointerDown = (e: MouseEvent) => {
      const root = contextRef.current;
      if (root && !root.contains(e.target as Node)) {
        setShowContextDetails(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowContextDetails(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [showContextDetails]);

  // ─── 컨텍스트 사용량 표시 (Phase 12 — Context Meter v2) ────────────────
  // 우선순위:
  //   1) measuredContext = metrics.maxTurnContextTokens
  //      sidecar 가 turn 내 message_start 들의 (input + cc + cr) 최댓값으로 보낸 정확치.
  //      sub-agent 합산 부풀음 회피 + 한 turn 의 가장 큰 단일 model call 컨텍스트.
  //   2) estimatedContext = estimateConvTokens(messages) (App 에서 계산)
  //      첫 턴 전 (아직 measured 없음) 의 fallback. messages.slice(-20) 길이 기반.
  //   3) rawTurnContext = metrics.currentContextTokens
  //      result.usage 기반 raw — sub-agent 호출 합산되어 1M~4M 부풀 수 있음.
  //      툴팁 비교용으로만 노출.
  const measuredContext = metrics.maxTurnContextTokens ?? 0;
  const rawTurnContext = metrics.currentContextTokens ?? 0;
  const estimatedContext = estimatedContextTokens ?? rawTurnContext;
  const displayContext = measuredContext > 0 ? measuredContext : estimatedContext;
  const contextSource: "measured" | "estimated" =
    measuredContext > 0 ? "measured" : "estimated";
  const rawContextUsage = (displayContext / maxContextTokens) * 100;
  // Phase 28 (v0.5.16): 부풀음 (1737% 같은 nonsense) UI 가드 — 100% 까지만 표시.
  // 실제 측정치가 100% 넘으면 그건 sidecar/모델이 잘못 보고한 값이거나 tool output 부풀음.
  // contextOverflowed 가 true 면 카드에 ⚠ 표시.
  const contextOverflowed = rawContextUsage > 100;
  const contextUsage = Math.min(rawContextUsage, 100);
  const contextColor = contextOverflowed
    ? "warn"
    : contextUsage >= 80
    ? "warn"
    : contextUsage >= 60
    ? undefined
    : "accent";
  const remainingTokens = Math.max(0, maxContextTokens - displayContext);

  return (
    <footer className="metrics">
      <CornerBrackets corners={["tl", "tr", "bl", "br"]} size={12} />

      <MetricCard
        label="Model"
        value={currentModel}
        mono
        accent="accent"
      />

      {/* 컨텍스트 프로그레스 바 — 클릭하면 상세 툴팁 토글 */}
      <div
        ref={contextRef}
        className="metric-card context-monitor"
        role="button"
        tabIndex={0}
        aria-expanded={showContextDetails}
        aria-label="컨텍스트 사용량 상세 보기 토글"
        onClick={() => setShowContextDetails((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setShowContextDetails((v) => !v);
          }
        }}
      >
        <div className="eyebrow metric-label">Context</div>
        <div className="context-bar-wrapper">
          <div className="context-bar">
            <div
              className={`context-bar-fill ${contextColor ? `context-bar-${contextColor}` : ""}`}
              style={{ width: `${Math.min(contextUsage, 100)}%` }}
            />
            {contextUsage >= 60 && (
              <div className="context-bar-threshold" style={{ left: "80%" }} />
            )}
          </div>
          <span
            className={`context-percent mono ${contextColor ? `text-${contextColor}` : ""}`}
            title={
              contextOverflowed
                ? `실제 측정치 ${rawContextUsage.toFixed(1)}% — tool 결과 누적 부풀음 가능. 세션 초기화 또는 압축 권장.`
                : undefined
            }
          >
            {contextUsage.toFixed(1)}%{contextOverflowed ? "+ ⚠" : ""}
          </span>
        </div>

        {/* 상세 툴팁 — 내부 클릭이 카드 onClick 으로 버블링돼 토글이 꺼지는 걸 막는다 */}
        {showContextDetails && (
          <div
            className="context-tooltip"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="context-tooltip-title">
              컨텍스트 사용량 ({contextSource === "measured" ? "실측" : "추정"})
            </div>
            <div className="context-tooltip-row" title={contextSource === "measured" ? "sidecar 가 SSE message_start 의 usage 들 중 (input + cache_creation + cache_read) 최댓값으로 보낸 정확한 윈도우 점유율." : "메시지 배열 기반 추정치 (4자 ≈ 1 토큰). 첫 턴 전 fallback."}>
              <span>사용</span>
              <span className="mono">{formatTokens(displayContext)}</span>
            </div>
            <div className="context-tooltip-row">
              <span>최대</span>
              <span className="mono">{formatTokens(maxContextTokens)}</span>
            </div>
            <div className="context-tooltip-row">
              <span>남은</span>
              <span className="mono">{formatTokens(remainingTokens)}</span>
            </div>
            {/* 측정치와 추정치를 동시에 보여 갭이 크면 즉시 감지 가능 */}
            {contextSource === "measured" && estimatedContext > 0 && (
              <div className="context-tooltip-row" title="messages.slice(-20) 기반 추정치. 실측과 크게 차이나면 메시지 누락 / 누적 의심.">
                <span>추정 (참고)</span>
                <span className="mono" style={{ opacity: 0.7 }}>{formatTokens(estimatedContext)}</span>
              </div>
            )}
            {rawTurnContext > 0 && (
              <>
                <div className="context-tooltip-divider" />
                <div className="context-tooltip-row" title="result.usage 의 raw 합 (input + cache_creation + cache_read). 한 턴에 sub-agent / iterative tool 호출이 있으면 누적되어 윈도우보다 클 수 있음 — billing 용 지표.">
                  <span>최근 턴 raw</span>
                  <span className="mono" style={{ opacity: 0.7 }}>{formatTokens(rawTurnContext)}</span>
                </div>
              </>
            )}
            <div className="context-tooltip-divider" />
            <div className="context-tooltip-hint">
              {contextOverflowed
                ? "⚠️ 100% 초과 — 큰 tool 결과 (cc_screenshot 등) 의 base64 가 누적된 케이스. 새 대화 또는 압축 권장."
                : contextUsage >= 90 && contextSource === "measured"
                ? `⚠️ ${maxContextTokens >= 1_000_000 ? "1M 마장" : "한도"} 임박 — 모델이 이미 ${formatTokens(displayContext)} 입력받음. 큰 history 누적 대화면 새 대화 / 압축 권장`
                : contextUsage >= 90
                ? "⚠️ 세션이 곧 자동 갱신됩니다"
                : contextUsage >= 70
                  ? "주의: 컨텍스트 70% 이상"
                  : "✓ 정상 범위"}
            </div>
            {/* Phase 38 (v0.5.26): measured 와 estimated 갭 큼 → 어느 쪽이 진실인지 판단 도움 */}
            {contextSource === "measured" && estimatedContext > 0 && Math.abs(displayContext - estimatedContext) > maxContextTokens * 0.3 && (
              <div className="context-tooltip-hint" style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                💡 실측({formatTokens(displayContext)}) 과 추정({formatTokens(estimatedContext)}) 갭 큼 — 누적 history 큰 대화일 가능성. 수치 자체는 모델이 보고한 정확치.
              </div>
            )}
            {/* Phase 35 (v0.5.23) + Phase 46 (v0.5.34) — 모델별 분모 출처 + 매칭 source */}
            <div className="context-tooltip-row" style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }} title="분모는 모델 ID 매칭으로 추정. 실제 모델 한도와 다를 수 있음. GPT-5/codex=400K, Claude default=1M, gpt-5-nano=1M, 그 외=200K">
              <span>분모 출처</span>
              <span className="mono">{currentModel} → {formatTokens(maxContextTokens)}</span>
            </div>
            {maxContextSource && (
              <div
                className="context-tooltip-row"
                style={{
                  fontSize: 10,
                  opacity: maxContextSource.startsWith("⚠") ? 0.95 : 0.5,
                  color: maxContextSource.startsWith("⚠") ? "var(--warn, #ffb74d)" : undefined,
                  marginTop: 2,
                }}
                title={maxContextSource.startsWith("⚠") ? "모델 ID 매칭 실패 — Settings 에서 model 명시 권장. 200K fallback 이라 빠르게 100% 도달." : undefined}
              >
                <span>매칭</span>
                <span className="mono" style={{ fontSize: 10 }}>{maxContextSource}</span>
              </div>
            )}
            {onCompressContext && contextUsage >= 50 && (
              <button
                className="context-compress-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onCompressContext();
                  setShowContextDetails(false);
                }}
                disabled={isCompressing}
                title="대화를 요약하고 새 세션으로 이어서 진행"
              >
                {isCompressing ? "⏳ 압축 중..." : "📦 대화 압축 & 이어하기"}
              </button>
            )}
            {onManualRefresh && (
              <button
                className="context-refresh-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onManualRefresh();
                  setShowContextDetails(false);
                }}
                title="세션 수동 갱신 (대화 초기화)"
              >
                🔄 세션 초기화
              </button>
            )}
          </div>
        )}
      </div>

      <MetricCard
        label="Turns"
        value={String(metrics.turnCount)}
        mono
      />

      <MetricCard
        label="Tools"
        value={String(metrics.toolCallCount)}
        mono
      />

      <MetricCard
        label="In"
        value={formatTokens(metrics.totalInputTokens)}
        mono
      />

      <MetricCard
        label="Out"
        value={formatTokens(metrics.totalOutputTokens)}
        mono
      />

      <MetricCard
        label="MCP"
        value={mcpConnected ? "LIVE" : "OFF"}
        mono
        accent={mcpConnected ? "accent" : "warn"}
      />

      {/* Phase 15.5 — Rate limit 카드 (5h + 주간). 데이터 받았을 때만 노출. */}
      {rateLimit?.primary && (
        <RateLimitCard label="5h" window={rateLimit.primary} />
      )}
      {rateLimit?.secondary && (
        <RateLimitCard label="Week" window={rateLimit.secondary} />
      )}
      {/* Phase 29 (v0.5.17) — Codex usage fetch 가 fail 했고 캐시도 없으면 진단 카드. */}
      {codexUsageError && !rateLimit?.primary && !rateLimit?.secondary && (
        <div
          className="metric-card rate-limit-error"
          title={`자세한 사유: ${codexUsageError}\n\n[재시도] 클릭 시 즉시 다시 fetch.\n로그인 만료면 환경설정 → AI 모델 연동 → Codex → [Codex 로그인].`}
          style={{ minWidth: "180px", maxWidth: "260px" }}
        >
          <div className="eyebrow metric-label">Codex Usage</div>
          <div className="text-warn mono" style={{ fontSize: "0.85em", marginTop: "0.3em", lineHeight: "1.3" }}>
            ⚠ {codexUsageError}
          </div>
          <div style={{ display: "flex", gap: "4px", marginTop: "0.4em", flexWrap: "wrap" }}>
            {onRetryCodexUsage && (
              <button
                className="settings-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onRetryCodexUsage();
                }}
                style={{ padding: "2px 8px", fontSize: "0.8em", cursor: "pointer" }}
                title="Codex 사용량 다시 가져오기"
              >
                재시도
              </button>
            )}
            {/* Phase 31 (v0.5.19): raw payload 가 있으면 K 가 schema 직접 확인 가능 */}
            {codexUsageRawPayload != null && (
              <button
                className="settings-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  try {
                    const json = JSON.stringify(codexUsageRawPayload, null, 2);
                    const truncated = json.length > 4000 ? json.slice(0, 4000) + "\n... (truncated)" : json;
                    window.alert(`Codex API raw 응답:\n\n${truncated}`);
                  } catch (e) {
                    window.alert(`raw payload 표시 실패: ${String(e)}`);
                  }
                }}
                style={{ padding: "2px 8px", fontSize: "0.8em", cursor: "pointer" }}
                title="chatgpt.com 응답 raw JSON 보기 (schema 진단용)"
              >
                Raw 보기
              </button>
            )}
          </div>
        </div>
      )}

      <MetricCard
        label="Session"
        value={formatDuration(Date.now() - metrics.startedAt)}
        mono
      />
    </footer>
  );
}

/**
 * Phase 15.5 — provider 의 5h / 주간 한도 표시.
 * 사용% + reset 까지 남은 시간. 부모(MetricsPanel)가 매초 setTick 으로 리렌더되므로
 * 여기서 별도 timer 없어도 카운트다운 자동 갱신.
 */
function RateLimitCard({
  label,
  window,
}: {
  label: string;
  window: {
    used_pct?: number;
    reset_at: number;
    used_tokens?: number;
    limit_tokens?: number;
    time_pct?: number;
    burn_rate_per_min?: number;
    projection_remaining_min?: number;
  };
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

function formatRemaining(ms: number): string {
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

// memo — 자체 setTick 으로 매초 리렌더하지만, 부모(App) 리렌더 시 props 가
// 새 ref 면 같이 리렌더되어 비용 중복. 핸들러는 useStableCallback 으로 안정화됐고
// metrics/mcpConnected 만 진짜 변경 시 갱신되도록.
export default memo(MetricsPanel);

function MetricCard({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: "accent" | "warn";
}) {
  return (
    <div className={`metric-card ${accent ? `metric-card-${accent}` : ""}`}>
      <div className="eyebrow metric-label">{label}</div>
      <div className={`metric-value ${mono ? "mono" : ""}`}>{value}</div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1000000).toFixed(2)}M`;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

