import { memo, useEffect, useRef, useState } from "react";
import type { SessionMetrics, RateLimitInfo, RateLimitWindow } from "../types";
import {
  SessionElapsed, computeContextUsage, contextHint, formatRemaining, formatTokens,
  showCodexRawPayload, useNowTick,
} from "./metricsShared";
import { Icon } from "../ui/icons";

// v0.7.86 UI 5단계 — o2 배치 우측 슬라이드오버 '세션·사용량' 탭.
// MetricsPanel(classic footer)과 같은 props·핸들러를 받는다. 매초 tick 은 SessionElapsed 만,
// 한도 카운트다운은 탭이 열려 있을 때만 30초 간격으로 갱신한다.
// fidB — 목업(evidence/ui-redesign-20261111/mockup.html '세션·사용량')과 같은 카드 구성:
// 컨텍스트 큰 % 카드 → 세션 이어가기 카드 2개 → 이번 세션 5칸 줄 → 사용 한도 카드 → 사용량 상태 줄.

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

/** 창 크기 표기 — 200000 → 200K, 1000000 → 1M (목업 'gpt-5 · 200K'). */
function windowLabel(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}K`;
}

/** 이번 세션 칸 — 1.2M · 86K · 512 (목업 표기). */
function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${+(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${+(n / 1_000_000).toFixed(1)}M`;
}

const num = (n: number) => Math.round(n).toLocaleString("en-US");

/** '오늘 15:40에 초기화' · '내일 09:00에 초기화' · '11월 14일 (금) 09:00에 초기화' */
function resetLabel(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "초기화 시각 모름";
  if (at <= Date.now()) return "초기화됨";
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return `오늘 ${hm}에 초기화`;
  if (d.toDateString() === tomorrow.toDateString()) return `내일 ${hm}에 초기화`;
  const wd = "일월화수목금토"[d.getDay()];
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${wd}) ${hm}에 초기화`;
}

/** 사용 한도 한 줄. used_pct(한도 %) 가 우선, 없으면 time_pct(시간 진행률 ⏳), 둘 다 없으면 누적 토큰. */
function LimitRow({ label, window: w }: { label: string; window: RateLimitWindow }) {
  const hasUsed = typeof w.used_pct === "number";
  const hasTime = typeof w.time_pct === "number";
  const pct = Math.max(0, Math.min(100, hasUsed ? w.used_pct! : hasTime ? w.time_pct! : 0));
  const remainMs = Math.max(0, w.reset_at - Date.now());
  const burnDanger = typeof w.projection_remaining_min === "number" && w.projection_remaining_min > 0
    && w.projection_remaining_min < remainMs / 60_000;
  const tone = burnDanger ? "warn" : hasUsed ? (pct >= 90 ? "danger" : pct >= 70 ? "warn" : "calm") : "calm";
  const title = [
    hasUsed ? `${label} 한도 ${pct.toFixed(1)}% 사용` : hasTime ? `${label} 시간 진행률 ${pct.toFixed(0)}% (한도 % 아님 — 공식 비공개)` : `${label} 사용량`,
    `초기화까지 ${formatRemaining(remainMs)}`,
    w.used_tokens != null ? `누적 ${formatTokens(w.used_tokens)}${w.limit_tokens != null ? ` / ${formatTokens(w.limit_tokens)}` : ""} 토큰` : null,
    burnDanger ? `⚠ 이 페이스면 ${Math.round(w.projection_remaining_min!)}분 안에 한도 도달` : null,
  ].filter(Boolean).join("\n");
  return (
    <div className={`so-lim so-lim--${tone}`} title={title}>
      <div className="so-lim__top">
        <span>{label}{!hasUsed && hasTime ? " ⏳" : ""}</span>
        <span className="so-lim__v mono">{hasUsed || hasTime ? `${Math.round(pct)}%` : w.used_tokens != null ? formatTokens(w.used_tokens) : "—"}</span>
      </div>
      {(hasUsed || hasTime) && <div className="so-meter"><i style={{ width: `${pct}%` }} /></div>}
      <small>{resetLabel(w.reset_at)}{burnDanger ? " · 이 페이스면 먼저 닿아요" : ""}</small>
    </div>
  );
}

function agoLabel(at: number): string {
  const m = Math.floor(Math.max(0, Date.now() - at) / 60_000);
  return m < 1 ? "방금" : m < 60 ? `${m}분 전` : `${Math.floor(m / 60)}시간 전`;
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
  const sourceWarn = !!maxContextSource && maxContextSource.startsWith("⚠");
  const known = maxContextTokens > 0;
  // dzA (D) — 80% 미만 무채색 · 80~89% 주황 · 90% 이상 빨강 (입력창 링·넛지와 같은 경계). '여유 적음' 배지·추천도 80% 부터
  const pctTone = u.contextOverflowed || u.contextUsage >= 90 ? "danger" : u.contextUsage >= 80 ? "warn" : "neutral";
  const recommendRefresh = u.contextUsage >= 80 || u.contextOverflowed;

  // 최근 턴 증가량 — 실측 컨텍스트가 바뀔 때의 차이 (추정→실측 전환은 세지 않음). 탭은 항상 마운트돼 턴마다 갱신된다.
  const prevCtx = useRef(u.measuredContext);
  const [turnDelta, setTurnDelta] = useState<number | null>(null);
  useEffect(() => {
    const prev = prevCtx.current;
    const cur = u.measuredContext;
    prevCtx.current = cur;
    if (cur <= 0) setTurnDelta(null);
    else if (prev > 0 && cur !== prev) setTurnDelta(cur - prev);
  }, [u.measuredContext]);
  // 추정·raw 는 실측과 크게 어긋날 때만 줄로 펼친다 (평소엔 '측정 방식' 툴팁). Phase 12 갭 추적용.
  const estimateGap = u.contextSource === "measured" && u.estimatedContext > 0
    && Math.abs(u.displayContext - u.estimatedContext) > maxContextTokens * 0.3;
  const rawGap = u.rawTurnContext > maxContextTokens;
  const measureTitle = [
    u.contextSource === "measured" ? "실측: 모델이 보고한 턴 최대 컨텍스트" : "추정: 최근 메시지로 계산한 값 (첫 응답 전)",
    u.estimatedContext > 0 ? `추정 (참고) ${formatTokens(u.estimatedContext)}` : null,
    u.rawTurnContext > 0 ? `최근 턴 raw ${formatTokens(u.rawTurnContext)} (billing 합계)` : null,
  ].filter(Boolean).join("\n");

  const hasLimits = !!(rateLimit?.primary || rateLimit?.secondary);
  const usageName = rateLimit?.provider === "anthropic" ? "Claude" : "Codex";

  return (
    <div className="session-usage">
      <section className="so-sect" aria-labelledby="su-context">
        <h5 id="su-context" className="so-sect__h">컨텍스트<span className="so-sect__c mono">{currentModel || "—"} · {windowLabel(maxContextTokens)}</span></h5>
        <div className="so-box">
          <div className="so-big">
            <span className={`so-big__v mono so-tone--${pctTone}`}>{known ? `${Math.round(u.contextUsage)}%${u.contextOverflowed ? "+" : ""}` : "—"}</span>
            <span className="so-big__sub mono">{known ? `${num(u.displayContext)} / ${num(maxContextTokens)} 토큰` : "분모를 모름"}</span>
            {known && pctTone !== "neutral" && <span className={`so-tag so-tag--${pctTone} so-big__lvl`}>여유 적음</span>}
          </div>
          <div className={`so-meter so-meter--${pctTone}`}><i style={{ width: `${known ? u.contextUsage : 0}%` }} /></div>
          <div className="so-grid3">
            <div><span>남은 양</span><b className="mono">{known ? num(u.remainingTokens) : "—"}</b></div>
            <div><span>최근 턴</span><b className="mono">{turnDelta == null ? "—" : `${turnDelta >= 0 ? "+" : "−"}${num(Math.abs(turnDelta))}`}</b></div>
            <div title={measureTitle}><span>측정 방식</span><b>{u.contextSource === "measured" ? "실측" : "추정"}</b></div>
          </div>
          <dl className="so-diag">
            <div title="분모는 모델 ID 매칭으로 추정. GPT-5/codex=400K, Claude default=1M, gpt-5-nano=1M, 그 외=200K">
              <dt>분모 출처</dt><dd className="mono">{currentModel || "—"} → {formatTokens(maxContextTokens)}</dd>
            </div>
            {maxContextSource && (
              <div className={sourceWarn ? "is-warn" : undefined}
                title={sourceWarn ? "모델 ID 매칭 실패 — 설정에서 모델을 명시하세요. 200K 기준이라 빠르게 100% 에 닿습니다." : undefined}>
                <dt>모델 매칭</dt><dd>{maxContextSource}</dd>
              </div>
            )}
            {estimateGap && (
              <div title="messages.slice(-20) 기반 추정치. 실측과 크게 차이나면 메시지 누락 / 누적 의심.">
                <dt>추정 (참고)</dt><dd className="mono">{formatTokens(u.estimatedContext)}</dd>
              </div>
            )}
            {rawGap && (
              <div title="result.usage 의 raw 합. 한 턴에 sub-agent / 반복 도구 호출이 있으면 누적되어 윈도우보다 클 수 있음 — billing 용 지표.">
                <dt>최근 턴 raw</dt><dd className="mono">{formatTokens(u.rawTurnContext)}</dd>
              </div>
            )}
          </dl>
        </div>
        {(u.contextOverflowed || u.contextUsage >= 90) && <p className="so-explain so-explain--warn">{contextHint(u, maxContextTokens)}</p>}
        {estimateGap && (
          <p className="so-explain">
            실측({formatTokens(u.displayContext)})과 추정({formatTokens(u.estimatedContext)}) 차이가 큽니다 — 누적 기록이 큰 대화일 수 있어요. 수치는 모델이 보고한 값입니다.
          </p>
        )}
      </section>

      <section className="so-sect" aria-labelledby="su-session">
        <h5 id="su-session" className="so-sect__h">세션 이어가기</h5>
        {onManualRefresh && (
          <button
            type="button"
            className={`so-sbtn context-refresh-btn${recommendRefresh ? " is-primary" : ""}`}
            onClick={() => onManualRefresh()}
            title="지금까지 대화를 요약해 넘기고, 같은 대화 안에서 AI 엔진 세션만 새로 시작합니다. 메시지는 지워지지 않고 컨텍스트 사용량과 세션 통계만 0부터 다시 쌓입니다."
          >
            <span className="so-sbtn__ic"><Icon name="rotate" /></span>
            <span className="so-sbtn__t"><b>새 세션으로 이어가기</b><small>같은 대화 · 맥락 요약 유지</small></span>
            {recommendRefresh && <span className="so-rec">추천</span>}
          </button>
        )}
        {onCompressContext && (
          <button
            type="button"
            className="so-sbtn context-compress-btn"
            onClick={() => onCompressContext()}
            disabled={isCompressing}
            title="지금까지 대화를 요약해 새 대화를 만들고 그곳에서 이어갑니다. 현재 대화는 그대로 보존됩니다."
          >
            <span className="so-sbtn__ic"><Icon name="split" /></span>
            <span className="so-sbtn__t"><b>{isCompressing ? "요약 중…" : "요약해서 새 대화로 이어가기"}</b><small>새 대화 생성 · 현재 대화는 보존</small></span>
            <Icon name="chevronRight" size={14} className="so-sbtn__go" />
          </button>
        )}
        <p className="so-explain">
          같은 대화에서 계속 → <b>새 세션으로 이어가기</b><br />새 대화로 분리 → <b>요약해서 새 대화로 이어가기</b>
        </p>
      </section>

      <section className="so-sect" aria-labelledby="su-stats">
        <h5 id="su-stats" className="so-sect__h">이번 세션</h5>
        <div className="so-stats">
          <div><span>턴</span><b className="mono">{metrics.turnCount}</b></div>
          <div><span>도구</span><b className="mono">{metrics.toolCallCount}</b></div>
          <div><span>입력</span><b className="mono">{compactTokens(metrics.totalInputTokens)}</b></div>
          <div><span>출력</span><b className="mono">{compactTokens(metrics.totalOutputTokens)}</b></div>
          <div><span>경과</span><b className="mono"><SessionElapsed startedAt={metrics.startedAt} active={active} clock /></b></div>
        </div>
        <div className={`so-okline so-okline--sub${mcpConnected ? "" : " is-warn"}`}>
          <span className="so-dot" aria-hidden="true" />컴퓨터 도구 {mcpConnected ? "연결됨" : "끊김"}
        </div>
      </section>

      <section className="so-sect" aria-labelledby="su-limits">
        <h5 id="su-limits" className="so-sect__h">사용 한도</h5>
        {hasLimits ? (
          <div className="so-box so-lims">
            {rateLimit?.primary && <LimitRow label="5시간" window={rateLimit.primary} />}
            {rateLimit?.secondary && <LimitRow label="주간" window={rateLimit.secondary} />}
          </div>
        ) : !codexUsageError ? (
          <p className="so-empty">아직 받은 한도 정보가 없어요.</p>
        ) : null}
      </section>

      {(hasLimits || codexUsageError) && (
        <section className="so-sect so-sect--last" aria-labelledby="su-usage">
          <h5 id="su-usage" className="so-sect__h">{codexUsageError ? "Codex" : usageName} 사용량</h5>
          {codexUsageError ? (
            <div className="so-box so-error" role="alert"
              title={`로그인 만료면 설정 → AI 엔진 → Codex → [Codex 로그인].`}>
              <div className="so-okline is-danger"><span className="so-dot" aria-hidden="true" />조회 오류 · {codexUsageError}</div>
              <div className="so-task__acts">
                {onRetryCodexUsage && (
                  <button type="button" className="so-sm" onClick={() => onRetryCodexUsage()} title="Codex 사용량 다시 가져오기">재시도</button>
                )}
                {codexUsageRawPayload != null && (
                  <button type="button" className="so-sm" onClick={() => showCodexRawPayload(codexUsageRawPayload)}
                    title="chatgpt.com 응답 raw JSON 보기 (schema 진단용)">Raw 보기</button>
                )}
              </div>
            </div>
          ) : (
            <div className="so-okline"><span className="so-dot" aria-hidden="true" />정상 · {agoLabel(rateLimit!.receivedAt)} 갱신</div>
          )}
        </section>
      )}
    </div>
  );
}

export default memo(SessionUsagePanel);
