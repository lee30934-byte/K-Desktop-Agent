import { useState } from "react";
import CornerBrackets from "./CornerBrackets";
import type { SessionMetrics } from "../types";

interface MetricsPanelProps {
  metrics: SessionMetrics;
  mcpConnected: boolean;
  currentModel?: string;
  maxContextTokens?: number;
  onManualRefresh?: () => void;
  onCompressContext?: () => void;
  isCompressing?: boolean;
}

export default function MetricsPanel({
  metrics,
  mcpConnected,
  currentModel = "claude-opus-4.6",
  maxContextTokens = 200000,
  onManualRefresh,
  onCompressContext,
  isCompressing = false,
}: MetricsPanelProps) {
  const [showContextDetails, setShowContextDetails] = useState(false);

  // 컨텍스트 사용량 = 마지막 턴에서 모델이 본 전체 토큰 (input + cache_creation + cache_read).
  // 누적 totalInputTokens 가 아닌 "현재 컨텍스트 윈도우 점유율" — 새 턴마다 갱신됨.
  // currentContextTokens 가 없으면(첫 메시지 전, 또는 과거 대화 복원 직후) 0 으로 표시.
  const currentContext = metrics.currentContextTokens ?? 0;
  const contextUsage = (currentContext / maxContextTokens) * 100;
  const contextColor = contextUsage >= 80 ? "warn" : contextUsage >= 60 ? undefined : "accent";
  const remainingTokens = Math.max(0, maxContextTokens - currentContext);

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
            <div className="context-tooltip-title">컨텍스트 사용량</div>
            <div className="context-tooltip-row">
              <span>사용</span>
              <span className="mono">{formatTokens(currentContext)}</span>
            </div>
            <div className="context-tooltip-row">
              <span>최대</span>
              <span className="mono">{formatTokens(maxContextTokens)}</span>
            </div>
            <div className="context-tooltip-row">
              <span>남은</span>
              <span className="mono">{formatTokens(remainingTokens)}</span>
            </div>
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

