import { memo } from "react";
import type { SessionMetrics, RateLimitInfo } from "../types";
import {
  RateLimitCard, SessionElapsed, computeContextUsage, contextHint, formatTokens,
  showCodexRawPayload, useNowTick,
} from "./metricsShared";

// v0.7.86 UI 5단계 — o2 배치 우측 슬라이드오버 '세션·사용량' 탭.
// MetricsPanel(classic footer)과 같은 props·핸들러를 받는다. 매초 tick 은 SessionElapsed 만,
// 한도 카운트다운은 탭이 열려 있을 때만 30초 간격으로 갱신한다.

export interface SessionUsagePanelProps {
  metrics: SessionMetrics;
  mcpConnected: boolean;
  currentModel?: string;
  maxContextTokens?: number;
  maxContextSource?: string;
  estimatedContextTokens?: number;
  onManualRefresh?: () => void;
  onCompressContext?: () => void;
  isCompressing?: boolean;
  rateLimit?: RateLimitInfo | null;
  codexUsageError?: string | null;
  codexUsageRawPayload?: unknown;
  onRetryCodexUsage?: () => void;
  /** 탭이 보일 때만 타이머를 돌린다 */
  active?: boolean;
}

function SessionUsagePanel({
  metrics,
  mcpConnected,
  currentModel = "",
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
  active = true,
}: SessionUsagePanelProps) {
  useNowTick(30_000, active && !!(rateLimit?.primary || rateLimit?.secondary));
  const u = computeContextUsage({ metrics, maxContextTokens, estimatedContextTokens });
  const tone = u.contextColor ? `context-bar-${u.contextColor}` : "";
  const sourceWarn = !!maxContextSource && maxContextSource.startsWith("⚠");

  return (
    <div className="session-usage">
      <section className="session-usage__section" aria-labelledby="su-context">
        <h3 id="su-context" className="session-usage__heading">컨텍스트</h3>
        <div className="context-bar-wrapper">
          <div className="context-bar">
            <div className={`context-bar-fill ${tone}`} style={{ width: `${u.contextUsage}%` }} />
            {u.contextUsage >= 60 && <div className="context-bar-threshold" style={{ left: "80%" }} />}
          </div>
          <span className={`context-percent mono ${u.contextColor ? `text-${u.contextColor}` : ""}`}>
            {u.contextUsage.toFixed(1)}%{u.contextOverflowed ? "+ ⚠" : ""}
          </span>
        </div>
        <dl className="session-usage__rows">
          <div><dt>사용 ({u.contextSource === "measured" ? "실측" : "추정"})</dt><dd className="mono">{formatTokens(u.displayContext)}</dd></div>
          <div><dt>최대</dt><dd className="mono">{formatTokens(maxContextTokens)}</dd></div>
          <div><dt>남은</dt><dd className="mono">{formatTokens(u.remainingTokens)}</dd></div>
          {u.contextSource === "measured" && u.estimatedContext > 0 && (
            <div title="messages.slice(-20) 기반 추정치. 실측과 크게 차이나면 메시지 누락 / 누적 의심.">
              <dt>추정 (참고)</dt><dd className="mono">{formatTokens(u.estimatedContext)}</dd>
            </div>
          )}
          {u.rawTurnContext > 0 && (
            <div title="result.usage 의 raw 합. 한 턴에 sub-agent / 반복 도구 호출이 있으면 누적되어 윈도우보다 클 수 있음 — billing 용 지표.">
              <dt>최근 턴 raw</dt><dd className="mono">{formatTokens(u.rawTurnContext)}</dd>
            </div>
          )}
          <div title="분모는 모델 ID 매칭으로 추정. GPT-5/codex=400K, Claude default=1M, gpt-5-nano=1M, 그 외=200K">
            <dt>분모 출처</dt><dd className="mono">{currentModel} → {formatTokens(maxContextTokens)}</dd>
          </div>
          {maxContextSource && (
            <div className={sourceWarn ? "is-warn" : undefined}
              title={sourceWarn ? "모델 ID 매칭 실패 — 설정에서 모델을 명시하세요. 200K 기준이라 빠르게 100% 에 닿습니다." : undefined}>
              <dt>매칭</dt><dd className="mono">{maxContextSource}</dd>
            </div>
          )}
        </dl>
        <p className="session-usage__hint">{contextHint(u, maxContextTokens)}</p>
        {u.contextSource === "measured" && u.estimatedContext > 0 && Math.abs(u.displayContext - u.estimatedContext) > maxContextTokens * 0.3 && (
          <p className="session-usage__hint session-usage__hint--muted">
            💡 실측({formatTokens(u.displayContext)})과 추정({formatTokens(u.estimatedContext)}) 차이가 큽니다 — 누적 기록이 큰 대화일 수 있어요. 수치는 모델이 보고한 값입니다.
          </p>
        )}
      </section>

      <section className="session-usage__section" aria-labelledby="su-session">
        <h3 id="su-session" className="session-usage__heading">세션</h3>
        <div className="session-usage__actions">
          {onManualRefresh && (
            <button
              type="button"
              className="context-refresh-btn"
              onClick={() => onManualRefresh()}
              title="지금까지 대화를 요약해 넘기고, 같은 대화 안에서 AI 엔진 세션만 새로 시작합니다. 메시지는 지워지지 않고 컨텍스트 사용량과 세션 통계만 0부터 다시 쌓입니다."
            >
              ↻ 새 세션으로 이어가기 <span className="btn-sub">맥락 유지 · 같은 대화</span>
            </button>
          )}
          {onCompressContext && (
            <button
              type="button"
              className="context-compress-btn"
              onClick={() => onCompressContext()}
              disabled={isCompressing}
              title="지금까지 대화를 요약해 새 대화를 만들고 그곳에서 이어갑니다. 현재 대화는 그대로 보존됩니다."
            >
              {isCompressing ? "⏳ 요약 중..." : "📦 요약해서 새 대화로 이어가기"} <span className="btn-sub">새 대화 · 현재 대화는 보존</span>
            </button>
          )}
        </div>
        <p className="session-usage__hint session-usage__hint--muted">
          같은 대화에서 계속 → 새 세션으로 이어가기 / 새 대화로 분리 → 요약해서 새 대화로 이어가기
        </p>
      </section>

      <section className="session-usage__section" aria-labelledby="su-stats">
        <h3 id="su-stats" className="session-usage__heading">이번 세션</h3>
        <div className="session-usage__stats">
          <div><span>턴</span><strong className="mono">{metrics.turnCount}</strong></div>
          <div><span>도구</span><strong className="mono">{metrics.toolCallCount}</strong></div>
          <div><span>입력</span><strong className="mono">{formatTokens(metrics.totalInputTokens)}</strong></div>
          <div><span>출력</span><strong className="mono">{formatTokens(metrics.totalOutputTokens)}</strong></div>
        </div>
        <dl className="session-usage__rows">
          <div><dt>경과</dt><dd className="mono"><SessionElapsed startedAt={metrics.startedAt} active={active} /></dd></div>
          <div className={mcpConnected ? undefined : "is-warn"}>
            <dt>컴퓨터 도구</dt><dd>{mcpConnected ? "연결됨" : "끊김"}</dd>
          </div>
        </dl>
      </section>

      <section className="session-usage__section" aria-labelledby="su-limits">
        <h3 id="su-limits" className="session-usage__heading">사용 한도</h3>
        {(rateLimit?.primary || rateLimit?.secondary) ? (
          <div className="session-usage__limits">
            {rateLimit?.primary && <RateLimitCard label="5시간" window={rateLimit.primary} />}
            {rateLimit?.secondary && <RateLimitCard label="주간" window={rateLimit.secondary} />}
          </div>
        ) : !codexUsageError ? (
          <p className="session-usage__hint session-usage__hint--muted">아직 받은 한도 정보가 없어요.</p>
        ) : null}
        {codexUsageError && (
          <div className="session-usage__error" role="alert"
            title={`로그인 만료면 설정 → AI 엔진 → Codex → [Codex 로그인].`}>
            <div>⚠ Codex 사용량 조회 오류: {codexUsageError}</div>
            <div className="session-usage__error-actions">
              {onRetryCodexUsage && (
                <button type="button" className="settings-btn" onClick={() => onRetryCodexUsage()} title="Codex 사용량 다시 가져오기">재시도</button>
              )}
              {codexUsageRawPayload != null && (
                <button type="button" className="settings-btn" onClick={() => showCodexRawPayload(codexUsageRawPayload)}
                  title="chatgpt.com 응답 raw JSON 보기 (schema 진단용)">Raw 보기</button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default memo(SessionUsagePanel);
