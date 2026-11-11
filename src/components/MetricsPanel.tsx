import { useEffect, useRef, useState, memo } from "react";
import CornerBrackets from "./CornerBrackets";
import { RateLimitCard, computeContextUsage, contextHint, formatTokens, formatDuration } from "./metricsShared";
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
  currentModel = "Opus 4.8",
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
  // 계산은 metricsShared.computeContextUsage 한 곳에서 (o2 의 ContextRing · SessionUsagePanel 과 공유).
  const usage = computeContextUsage({ metrics, maxContextTokens, estimatedContextTokens });
  const {
    rawTurnContext, estimatedContext, displayContext, contextSource,
    rawContextUsage, contextOverflowed, contextUsage, contextColor, remainingTokens,
  } = usage;

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
                ? `실제 측정치 ${rawContextUsage.toFixed(1)}% — tool 결과 누적 부풀음 가능. 새 세션으로 이어가기 또는 새 대화로 이어가기 권장.`
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
              {contextHint(usage, maxContextTokens)}
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
                title="지금까지 대화를 요약해 새 대화를 만들고 그곳에서 이어갑니다. 현재 대화는 그대로 보존됩니다."
              >
                {isCompressing ? "⏳ 요약 중..." : "📦 요약해서 새 대화로 이어가기"}
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
                title="지금까지 대화를 요약해 넘기고, 같은 대화 안에서 AI 엔진 세션만 새로 시작합니다. 메시지는 지워지지 않고 컨텍스트 사용량과 세션 통계만 0부터 다시 쌓입니다."
              >
                ↻ 새 세션으로 이어가기 <span className="btn-sub">맥락 유지 · 같은 대화</span>
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
