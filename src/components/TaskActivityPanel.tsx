import { useEffect, useRef, useState } from "react";
import type { PendingSend, RunView } from "../conversationControl";
import { TASK_PANEL_OPEN_KEY } from "../conversationWorkspace";
import { Icon } from "../ui/icons";

interface Props {
  runs: RunView[];
  queues: Map<string, PendingSend[]>;
  paused: Set<string>;
  allPaused: boolean;
  conversations: { id: string; title: string }[];
  onSelect: (id: string) => void;
  onStop: (id: string) => void;
  onStopAll: () => void;
  onResume: (id: string) => void;
  onResumeAutomation: () => void;
  tracked?: string[];
  onNew?: () => void;
  onAdd?: (id: string) => void;
  onClose?: (id: string) => void;
  onRecover?: () => void;
  recovering?: boolean;
  /** v0.7.86 UI 4단계 — popover: 예전 칩+팝오버 / chip: 칩만(누르면 onOpenPanel) / inline: 슬라이드오버 '작업' 탭 본문 */
  mode?: "popover" | "chip" | "inline";
  panelOpen?: boolean;
  onOpenPanel?: () => void;
}
export default function TaskActivityPanel(props: Props) {
  const mode = props.mode ?? "popover";
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(TASK_PANEL_OPEN_KEY) === "1"; } catch { return false; } });
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (mode === "popover") try { localStorage.setItem(TASK_PANEL_OPEN_KEY, open ? "1" : "0"); } catch {} }, [open, mode]);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open || mode !== "popover") return;
    const outside = (event: PointerEvent) => { if (!panelRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open, mode]);
  const active = props.runs.filter((r) => r.state === "running" || r.state === "stopping");
  const queueCount = [...props.queues.values()].reduce((n, q) => n + q.length, 0);
  const ids = [...new Set([...(props.tracked ?? []), ...props.runs.map((r) => r.conversationId), ...props.queues.keys()])];
  const expanded = mode === "chip" ? !!props.panelOpen : open;
  const toggle = <button className="task-activity-toggle" type="button" aria-expanded={expanded}
    onClick={() => { if (mode === "chip") props.onOpenPanel?.(); else setOpen(!open); }}
    title={mode === "chip" ? "작업 패널 열기" : undefined}>
    <span className={active.length ? "task-live-dot" : "task-idle-dot"} />
    작업 현황 <strong>{active.length} 실행</strong>{queueCount > 0 && <span>· {queueCount} 예약</span>}
    {props.allPaused && <span>· 자동 실행 보류</span>}
    {mode === "popover" && <span aria-hidden="true">{open ? "▴" : "▾"}</span>}
  </button>;
  // v0.7.86 fidA (o2 헤더 칩) — 목업 '⚡ 2 실행 · 1 예약'. 누르면 작업 패널. (popover/inline 은 예전 문구 그대로)
  if (mode === "chip") return <aside className="task-activity" aria-label="대화별 작업 현황">
    <button className="task-activity-toggle task-activity-toggle--chip" type="button" aria-expanded={expanded}
      onClick={() => props.onOpenPanel?.()} title="작업 패널 열기" aria-label={`작업 현황: ${active.length}개 실행${queueCount > 0 ? ` · ${queueCount}개 예약` : ""}`}>
      <Icon name="zap" size={14} />
      <span><strong className="n">{active.length}</strong> 실행{queueCount > 0 && <> · <strong className="n">{queueCount}</strong> 예약</>}</span>
      {props.allPaused && <span>· 자동 실행 보류</span>}
    </button>
  </aside>;
  const titleOf = (id: string) => props.conversations.find((c) => c.id === id)?.title ?? "대화";
  const elapsed = (from: number) => {
    const sec = Math.max(0, Math.floor((Date.now() - from) / 1000));
    const m = Math.floor(sec / 60);
    return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : m > 0 ? `${m}분 ${sec % 60}초` : `${sec}초`;
  };
  const inlineBody = () => {
    const runningIds = ids.filter((id) => { const st = props.runs.find((r) => r.conversationId === id)?.state; return st === "running" || st === "stopping"; });
    const queuedIds = ids.filter((id) => (props.queues.get(id)?.length ?? 0) > 0);
    const otherIds = ids.filter((id) => !runningIds.includes(id) && !queuedIds.includes(id));
    return <div className="task-activity-inline">
      {props.allPaused && <div className="task-automation-paused">자동 실행을 보류 중입니다.
        <button type="button" className="so-sm so-sm--acc" onClick={props.onResumeAutomation}>자동 실행 허용</button>
      </div>}
      <div className="so-sect">
        <h5 className="so-sect__h">실행 중<span className="so-sect__c">{runningIds.length}</span></h5>
        {!runningIds.length && <p className="so-empty">실행 중인 작업이 없어요.</p>}
        {runningIds.map((id) => {
          const run = props.runs.find((r) => r.conversationId === id)!;
          return <div className="so-task task-activity-row" key={id}>
            <div className="so-task__top"><span className="so-spin" aria-hidden="true" /><b title={titleOf(id)}>{titleOf(id)}</b>
              {run.state === "stopping" && <span className="so-tag so-tag--warn">정지 중</span>}</div>
            <div className="so-task__sub">{run.detail} · {elapsed(run.startedAt)}</div>
            <div className="so-task__acts">
              <button type="button" className="so-sm task-conversation-link" onClick={() => props.onSelect(id)}>대화 열기</button>
              <button type="button" className="so-sm so-sm--dan" onClick={() => props.onStop(id)}><Icon name="square" size={14} />{run.state === "stopping" ? "정지 재요청" : "이 작업 정지"}</button>
            </div>
          </div>;
        })}
      </div>
      {queuedIds.length > 0 && <div className="so-sect">
        <h5 className="so-sect__h">예약<span className="so-sect__c">{queueCount}</span></h5>
        {queuedIds.map((id) => {
          const queue = props.queues.get(id) ?? [];
          const busy = runningIds.includes(id);
          const held = props.paused.has(id) || props.allPaused;
          return <div className={busy ? "so-task" : "so-task task-activity-row"} key={id}>
            <div className="so-task__top"><Icon name="clock" size={14} className="so-task__ic" /><b title={titleOf(id)}>{titleOf(id)}</b>
              {queue.length > 1 && <span className="so-tag">{queue.length}개</span>}{held && <span className="so-tag so-tag--warn">보류</span>}</div>
            <div className="so-task__sub" title={queue[0]?.text}>완료 후 보냄: "{(queue[0]?.text ?? "").slice(0, 60)}"</div>
            <div className="so-task__acts">
              {!busy && <button type="button" className="so-sm so-sm--acc" onClick={() => props.onResume(id)}>예약 이어서 실행</button>}
              <button type="button" className="so-sm" onClick={() => props.onSelect(id)}>대화 열기</button>
            </div>
          </div>;
        })}
      </div>}
      {otherIds.length > 0 && <div className="so-sect">
        <h5 className="so-sect__h">작업 목록<span className="so-sect__c">{otherIds.length}</span></h5>
        {otherIds.map((id) => {
          const run = props.runs.find((r) => r.conversationId === id);
          return <div className="so-task task-activity-row" key={id}>
            <div className="so-task__top"><span className={'task-run-state state-' + (run?.state ?? 'stopped')} aria-hidden="true" /><b title={titleOf(id)}>{titleOf(id)}</b></div>
            <div className="so-task__sub">{run?.detail ?? "작업 대기"}{run && <> · 최근 진행 {new Date(run.updatedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</>}</div>
            <div className="so-task__acts">
              <button type="button" className="so-sm task-conversation-link" onClick={() => props.onSelect(id)}>대화 열기</button>
              {props.onClose && <button type="button" className="so-sm" onClick={() => props.onClose?.(id)} title="대화는 보존하고 작업 목록에서만 닫기">목록에서 닫기</button>}
            </div>
          </div>;
        })}
      </div>}
      <div className="so-tools">
        {props.onNew && <button type="button" className="so-sm" onClick={props.onNew}><Icon name="plus" size={14} />새 대화 추가</button>}
        {props.onAdd && <button type="button" className="so-sm" onClick={() => setAdding(!adding)}>기존 대화 추가</button>}
        {props.onRecover && <button type="button" className="so-sm" onClick={props.onRecover} disabled={props.recovering}>
          {props.recovering ? "실행 엔진 복구 중…" : "정지 불응 시 실행 엔진 복구"}
        </button>}
      </div>
      {adding && <select className="so-select" aria-label="작업 목록에 추가할 대화" value="" onChange={event => { if (event.target.value) { props.onAdd?.(event.target.value); setAdding(false); } }}>
        <option value="">대화 선택</option>
        {props.conversations.filter(c => !ids.includes(c.id)).map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
      </select>}
      <p className="so-explain">정지는 KDA가 관리하는 실행에 적용됩니다. 분리된 외부 작업은 별도 확인이 필요합니다.</p>
    </div>;
  };
  const body = <div className={mode === "inline" ? "task-activity-inline" : "task-activity-popover"}>
      <div className="task-activity-heading"><strong>대화별 작업</strong>
        <button type="button" onClick={props.onStopAll} disabled={!active.length && !queueCount}>전체 작업 정지</button>
      </div>
      <div className="task-activity-actions">
        {props.onNew && <button onClick={props.onNew}>새 대화 추가</button>}
        {props.onAdd && <button onClick={() => setAdding(!adding)}>기존 대화 추가</button>}
      </div>
      {adding && <select aria-label="작업 목록에 추가할 대화" value="" onChange={event => { if (event.target.value) { props.onAdd?.(event.target.value); setAdding(false); } }}>
        <option value="">대화 선택</option>
        {props.conversations.filter(c => !ids.includes(c.id)).map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
      </select>}
      {props.onRecover && <div className="task-activity-actions"><button onClick={props.onRecover} disabled={props.recovering}>
        {props.recovering ? "실행 엔진 복구 중…" : "정지 불응 시 실행 엔진 복구"}
      </button></div>}
      {props.allPaused && <div className="task-automation-paused">자동 실행을 보류 중입니다.
        <button type="button" onClick={props.onResumeAutomation}>자동 실행 허용</button>
      </div>}
      {!ids.length && <p className="task-empty">진행 중인 작업이 없습니다. 다른 대화에서도 작업을 시작할 수 있습니다.</p>}
      <div className="task-activity-list">{ids.map((id) => {
        const run = props.runs.find((r) => r.conversationId === id);
        const title = props.conversations.find((c) => c.id === id)?.title ?? "대화";
        const queue = props.queues.get(id) ?? [];
        const busy = run?.state === "running" || run?.state === "stopping";
        return <div className="task-activity-row" key={id}>
          <button className="task-conversation-link" onClick={() => props.onSelect(id)} title={title}>{title}</button>
          <span className={'task-run-state state-' + (run?.state ?? 'stopped')}>{run?.detail ?? (queue.length ? "예약 대기" : "작업 대기")}</span>
          <div className="task-activity-meta">
            {run && <time dateTime={new Date(run.updatedAt).toISOString()}>최근 진행 {new Date(run.updatedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time>}
            {queue.length > 0 && <span>예약 {queue.length}개{props.paused.has(id) || props.allPaused ? " · 보류" : ""}</span>}
          </div>
          <div className="task-activity-actions">
            {busy && <button onClick={() => props.onStop(id)}>{run?.state === "stopping" ? "정지 재요청" : "이 대화 정지"}</button>}
            {!busy && queue.length > 0 && <button onClick={() => props.onResume(id)}>예약 이어서 실행</button>}
            {props.onClose && <button disabled={busy || queue.length > 0} onClick={() => props.onClose?.(id)} title="대화는 보존하고 작업 목록에서만 닫기">목록에서 닫기</button>}
          </div>
        </div>;
      })}</div>
      <p className="task-activity-footnote">정지는 KDA가 관리하는 실행에 적용됩니다. 분리된 외부 작업은 별도 확인이 필요합니다.</p>
    </div>;
  // fidB (o2 슬라이드오버 '작업' 탭) — 목업처럼 '실행 중 · 예약 · 최근 작업' 카드. 전체 작업 정지는 패널 아래 줄(App)에 있다.
  if (mode === "inline") return <section className="task-activity task-activity--inline" aria-label="대화별 작업 현황">{inlineBody()}</section>;
  return <aside ref={panelRef} className="task-activity" aria-label="대화별 작업 현황">
    {toggle}
    {open && body}
  </aside>;
}
