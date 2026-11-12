import { memo, useCallback, useEffect, useState } from "react";
import type { SessionMetrics } from "../types";
import { Popover, Ring } from "../ui";
import { computeContextUsage, formatTokens, SessionElapsed } from "./metricsShared";
import { Icon } from "../ui/icons";

// v0.7.86 UI 5단계 — o2 배치: MetricsPanel 의 Context 카드를 입력창 안 링으로 옮긴다.
// 클릭하면 요약 팝오버(사용/최대/남은 + 경과 + 세션 버튼 2개), 자세한 진단은 '세션·사용량' 탭.
// classic 배치는 이 컴포넌트를 쓰지 않고 예전 MetricsPanel footer 를 그대로 그린다.

export interface ContextRingProps {
  metrics: SessionMetrics;
  maxContextTokens: number;
  estimatedContextTokens?: number;
  onManualRefresh?: () => void;
  onCompressContext?: () => void;
  isCompressing?: boolean;
  /** Codex 사용량 조회 오류 — 링에 ! 점 */
  hasUsageError?: boolean;
  onOpenSessionPanel?: () => void;
}

/** dzA (D) — 80% 미만은 무채색(ok = o2 CSS 에서 중립), 80~89% 주황, 90% 이상 빨강. 세션 탭·넛지와 같은 경계. */
function ringTone(pct: number, overflowed: boolean): "ok" | "warn" | "danger" {
  if (overflowed || pct >= 90) return "danger";
  if (pct >= 80) return "warn";
  return "ok";
}

function ContextRing({
  metrics,
  maxContextTokens,
  estimatedContextTokens,
  onManualRefresh,
  onCompressContext,
  isCompressing = false,
  hasUsageError = false,
  onOpenSessionPanel,
}: ContextRingProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const u = computeContextUsage({ metrics, maxContextTokens, estimatedContextTokens });
  const pct = Math.round(u.contextUsage);
  const tone = ringTone(u.contextUsage, u.contextOverflowed);
  const label = `컨텍스트 ${pct}% 사용${u.contextOverflowed ? " (100% 초과)" : ""}`;

  return (
    <div className="context-ring">
      <button
        type="button"
        className={`context-ring-btn context-ring-btn--${tone}`}
        aria-label={`${label} · 상세 보기`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${label} · 클릭하면 상세`}
        // 열린 상태에서 링을 다시 누르면 팝오버의 바깥 클릭 닫기와 겹쳐 곧바로 다시 열리지 않게
        onMouseDown={(e) => { if (open) e.stopPropagation(); }}
        onClick={() => setOpen((v) => !v)}
      >
        <Ring value={u.contextUsage} size={18} tone={tone} label={label} />
        <span className="context-ring-pct mono">{pct}%{u.contextOverflowed ? "+" : ""}</span>
        {hasUsageError && <span className="context-ring-dot" aria-label="사용량 조회 오류" title="사용량 조회 오류 · 세션·사용량 탭에서 확인" />}
      </button>
      <Popover open={open} onClose={close} align="end" className="context-ring-popover">
        <div className="context-ring-popover__title">
          컨텍스트 {u.contextUsage.toFixed(1)}% ({u.contextSource === "measured" ? "실측" : "추정"})
        </div>
        <dl className="context-ring-popover__rows">
          <div><dt>사용</dt><dd className="mono">{formatTokens(u.displayContext)}</dd></div>
          <div><dt>최대</dt><dd className="mono">{formatTokens(maxContextTokens)}</dd></div>
          <div><dt>남은</dt><dd className="mono">{formatTokens(u.remainingTokens)}</dd></div>
          <div><dt>경과</dt><dd className="mono"><SessionElapsed startedAt={metrics.startedAt} active={open} /></dd></div>
        </dl>
        <div className="context-ring-popover__actions">
          {onManualRefresh && (
            <button
              type="button"
              className="context-refresh-btn"
              onClick={() => { onManualRefresh(); close(); }}
              title="지금까지 대화를 요약해 넘기고, 같은 대화 안에서 AI 엔진 세션만 새로 시작합니다. 메시지는 지워지지 않고 컨텍스트 사용량과 세션 통계만 0부터 다시 쌓입니다."
            >
              ↻ 새 세션으로 이어가기 <span className="btn-sub">맥락 유지 · 같은 대화</span>
            </button>
          )}
          {onCompressContext && (
            <button
              type="button"
              className="context-compress-btn"
              onClick={() => { onCompressContext(); close(); }}
              disabled={isCompressing}
              title="지금까지 대화를 요약해 새 대화를 만들고 그곳에서 이어갑니다. 현재 대화는 그대로 보존됩니다."
            >
              {isCompressing ? "⏳ 요약 중..." : "📦 요약해서 새 대화로 이어가기"} <span className="btn-sub">새 대화 · 현재 대화는 보존</span>
            </button>
          )}
        </div>
        {onOpenSessionPanel && (
          <button type="button" className="context-ring-popover__more" onClick={() => { onOpenSessionPanel(); close(); }}>
            세션·사용량 자세히 →
          </button>
        )}
      </Popover>
    </div>
  );
}

export default memo(ContextRing);

/**
 * 입력창 위 80% 넛지 — '컨텍스트 72% · ↻ 새 세션으로 이어가기'.
 * ✕ 로 숨기면 같은 대화에서 80% 아래로 내려갔다 다시 넘을 때까지 안 보인다.
 */
export const ContextNudge = memo(function ContextNudge({
  metrics,
  maxContextTokens,
  estimatedContextTokens,
  onManualRefresh,
}: Pick<ContextRingProps, "metrics" | "maxContextTokens" | "estimatedContextTokens" | "onManualRefresh">) {
  const u = computeContextUsage({ metrics, maxContextTokens, estimatedContextTokens });
  const high = u.contextUsage >= 80; // dzA (A·D) — 80% 이상일 때만 (평소엔 입력창 링이 % 를 보여 줌)
  const tone = u.contextOverflowed || u.contextUsage >= 90 ? "danger" : "warn";
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { if (!high) setDismissed(false); }, [high]);
  if (!high || dismissed || !onManualRefresh) return null;
  return (
    <div className={`context-nudge context-nudge--${tone}`} role="status">
      {/* fidA — 목업: '컨텍스트 72% 사용 중 · 응답이 느려질 수 있어요  [↻ 새 세션으로 이어가기]' */}
      <span className="context-nudge__text">컨텍스트 <span className="context-nudge__pct mono">{Math.round(u.contextUsage)}%</span> 사용 중 · 응답이 느려질 수 있어요</span>
      <button
        type="button"
        className="context-nudge__action"
        onClick={onManualRefresh}
        title="지금까지 대화를 요약해 넘기고, 같은 대화 안에서 AI 엔진 세션만 새로 시작합니다. 메시지는 지워지지 않습니다."
      >
        <Icon name="rotate" size={14} />새 세션으로 이어가기
      </button>
      <button type="button" className="context-nudge__close" aria-label="안내 숨기기" onClick={() => setDismissed(true)}>✕</button>
    </div>
  );
});
