import { useEffect, useRef, useState } from "react";
import type { PendingSend, RunView } from "../conversationControl";

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
}
export default function TaskActivityPanel(props: Props) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!panelRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const active = props.runs.filter((r) => r.state === "running" || r.state === "stopping");
  const queueCount = [...props.queues.values()].reduce((n, q) => n + q.length, 0);
  const ids = [...new Set([...props.runs.map((r) => r.conversationId), ...props.queues.keys()])];
  return <aside ref={panelRef} className="task-activity" aria-label="대화별 작업 현황">
    <button className="task-activity-toggle" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className={active.length ? "task-live-dot" : "task-idle-dot"} />
      작업 현황 <strong>{active.length} 실행</strong>{queueCount > 0 && <span>· {queueCount} 예약</span>}
      {props.allPaused && <span>· 자동 실행 보류</span>}
      <span aria-hidden="true">{open ? "▴" : "▾"}</span>
    </button>
    {open && <div className="task-activity-popover">
      <div className="task-activity-heading"><strong>대화별 작업</strong>
        <button type="button" onClick={props.onStopAll} disabled={!active.length && !queueCount}>전체 작업 정지</button>
      </div>
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
          <span className={'task-run-state state-' + (run?.state ?? 'stopped')}>{run?.detail ?? "예약 대기"}</span>
          <div className="task-activity-meta">
            {run && <time dateTime={new Date(run.updatedAt).toISOString()}>최근 진행 {new Date(run.updatedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time>}
            {queue.length > 0 && <span>예약 {queue.length}개{props.paused.has(id) || props.allPaused ? " · 보류" : ""}</span>}
          </div>
          <div className="task-activity-actions">
            {busy && <button onClick={() => props.onStop(id)}>{run?.state === "stopping" ? "정지 재요청" : "이 대화 정지"}</button>}
            {!busy && queue.length > 0 && <button onClick={() => props.onResume(id)}>예약 이어서 실행</button>}
          </div>
        </div>;
      })}</div>
      <p className="task-activity-footnote">정지는 KDA가 관리하는 실행에 적용됩니다. 분리된 외부 작업은 별도 확인이 필요합니다.</p>
    </div>}
  </aside>;
}
