// v0.7.86 UI 목업 충실도(fidA) — o2 헤더 아래 '작업 결과 확인 대기' 알림 띠 (목업 .notice).
// 한 줄: [파일 아이콘] 작업 결과 확인 대기 N건 · 첫 항목 · 사유  [확인 완료]  [외 N건 ⌄]  ×
// '외 N건' 을 누르면 나머지 항목이 아래로 펼쳐진다(각자 [확인 완료]). 동작(보관·숨김)은 classic 띠와 같은 함수를 쓴다.
// classic 은 App.tsx 의 예전 <Notice> 그대로.
import { useState } from "react";
import { Button, Notice } from "../ui";
import { Icon } from "../ui/icons";
import type { WaitingWatch } from "../utils/taskWatchRecovery";

interface Props {
  items: WaitingWatch[];
  labelFor: (reason: string) => string;
  onResolve: (w: WaitingWatch) => void;
  onDismiss: () => void;
  error?: string | null;
}

const RESOLVE_TITLE = "결과를 확인했으면 이 감시 기록을 보관 폴더(task-watch/archive/resolved)로 옮깁니다 · 삭제하지 않음";

export default function TaskWatchNotice({ items, labelFor, onResolve, onDismiss, error }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [first, ...rest] = items;
  if (!first) return null;
  return (
    <Notice tone="warn" role="status" className="task-watch-waiting task-watch-waiting--o2"
      onClose={onDismiss} closeLabel="이 알림 숨김 · 작업 감시는 계속됨"
      actions={<>
        {first.resolvable && (
          <Button size="sm" className="task-watch-resolve" onClick={() => onResolve(first)} title={RESOLVE_TITLE}>확인 완료</Button>
        )}
        {rest.length > 0 && (
          <button type="button" className="task-watch-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            외 {rest.length}건<Icon name="chevronDown" size={14} />
          </button>
        )}
      </>}>
      <div className="task-watch-line">
        <Icon name="file" />
        <span className="task-watch-text">
          작업 결과 확인 대기 {items.length}건 · <b>{first.title}</b> · {labelFor(first.reason)}
        </span>
      </div>
      {expanded && rest.map((w) => (
        <div key={w.id} className="ui-notice__row task-watch-row">
          <span>{w.title} · {labelFor(w.reason)}</span>
          {w.resolvable && (
            <Button size="sm" className="task-watch-resolve" onClick={() => onResolve(w)} title={RESOLVE_TITLE}>확인 완료</Button>
          )}
        </div>
      ))}
      {error && <div role="alert" className="ui-notice__error">보관 실패: {error}</div>}
    </Notice>
  );
}
