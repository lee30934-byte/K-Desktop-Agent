import { useEffect, useState, memo } from "react";
import CornerBrackets from "./CornerBrackets";
import type { SessionMetrics } from "../types";

interface MetricsPanelProps {
  metrics: SessionMetrics;
  mcpConnected: boolean;
  currentModel?: string;
  maxContextTokens?: number;
  /**
   * 메시지 배열 기반 컨텍스트 추정치 (App 의 estimateConvTokens 결과).
   * 자동 갱신 트리거와 같은 지표라 표시 % 와 트리거 % 가 일치한다.
   * 미지정이면 fallback 으로 raw `metrics.currentContextTokens` 를 사용.
   */
  estimatedContextTokens?: number;
  onManualRefresh?: () => void;
  onCompressContext?: () => void;
  isCompressing?: boolean;
}

function MetricsPanel({
  metrics,
  mcpConnected,
  currentModel = "claude-opus-4.6",
  maxContextTokens = 200000,
  estimatedContextTokens,
  onManualRefresh,
  onCompressContext,
  isCompressing = false,
}: MetricsPanelProps) {
  const [showContextDetails, setShowContextDetails] = useState(false);
  // 매초 자체 리렌더 — Session 경과 시간 표시용.
  // 이전엔 App.tsx 의 setTick 으로 전체 트리가 리렌더돼서 메시지 ReactMarkdown 재파싱이
  // 매초 일어났음. 여기로 격리하면 매초 갱신 비용이 footer 한 줄에만 머문다.
  const [, setTick] = useState(0);
  useEffect(() => {
    const h = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(h);
  }, []);

  // 컨텍스트 사용량 — 표시 지표는 messages 배열 기반 추정치 (App 의 estimateConvTokens).
  // sidecar usage 의 cache_read_input_tokens 는 한 턴 안의 모든 내부 model call (sub-agent /
  // iterative tool 사용) 을 누적 합산해서 1M~4M 까지 부풀어 윈도우 점유율로 부적절했음.
  // 이제 자동 갱신 트리거와 같은 estimateConvTokens 를 표시에도 사용 → "표시 < 10% 인데
  // 갑자기 갱신됨" 같은 미스매치 제거.
  // 툴팁에는 raw 측정치(rawTurnContext) 도 함께 노출해 최근 턴이 실제로 본 합계도 확인 가능.
  const rawTurnContext = metrics.currentContextTokens ?? 0;
  const estimatedContext = estimatedContextTokens ?? rawTurnContext;
  const contextUsage = (estimatedContext / maxContextTokens) * 100;
  const contextColor = contextUsage >= 80 ? "warn" : contextUsage >= 60 ? undefined : "accent";
  const remainingTokens = Math.max(0, maxContextTokens - estimatedContext);

  return (
    <footer className="metrics">
      <CornerBrackets corners={["tl", "tr", "bl", "br"]} size={12} />

      <MetricCard
        label="Model"
        value={currentModel}
        mono
        accent="accent"
      />

      {/* 컨텍스트 프로그레스 바 */}
      <div
        className="metric-card context-monitor"
        onMouseEnter={() => setShowContextDetails(true)}
        onMouseLeave={() => setShowContextDetails(false)}
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
          <span className={`context-percent mono ${contextColor ? `text-${contextColor}` : ""}`}>
            {contextUsage.toFixed(1)}%
          </span>
        </div>

        {/* 상세 툴팁 */}
        {showContextDetails && (
          <div className="context-tooltip">
            <div className="context-tooltip-title">컨텍스트 사용량 (추정)</div>
            <div className="context-tooltip-row">
              <span>사용</span>
              <span className="mono">{formatTokens(estimatedContext)}</span>
            </div>
            <div className="context-tooltip-row">
              <span>최대</span>
              <span className="mono">{formatTokens(maxContextTokens)}</span>
            </div>
            <div className="context-tooltip-row">
              <span>남은</span>
              <span className="mono">{formatTokens(remainingTokens)}</span>
            </div>
            {rawTurnContext > 0 && (
              <>
                <div className="context-tooltip-divider" />
                <div className="context-tooltip-row" title="최근 턴에서 모델이 본 raw 토큰 합 (input + cache_creation + cache_read). 한 턴에 여러 내부 model 호출이 있으면 누적되어 윈도우보다 클 수 있음 — billing 용 지표라 윈도우 점유율과는 다름.">
                  <span>최근 턴 raw</span>
                  <span className="mono">{formatTokens(rawTurnContext)}</span>
                </div>
              </>
            )}
            <div className="context-tooltip-divider" />
            <div className="context-tooltip-hint">
              {contextUsage >= 90
                ? "⚠️ 세션이 곧 자동 갱신됩니다"
                : contextUsage >= 70
                  ? "주의: 컨텍스트 70% 이상"
                  : "✓ 정상 범위"}
            </div>
            {onCompressContext && contextUsage >= 50 && (
              <button
                className="context-compress-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onCompressContext();
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

      <MetricCard
        label="Session"
        value={formatDuration(Date.now() - metrics.startedAt)}
        mono
      />
    </footer>
  );
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

