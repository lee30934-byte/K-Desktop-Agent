// v0.7.86 UI 개편 3단계 — 헤더 '안전 칩' (design-spec.md 3.2).
// 항상 표시. OFF=회색 '확인 후 실행', ON=주황 '확인 없이 실행 중'. 클릭하면 팝오버:
// 스위치(같은 useApprovalMode 상태 — 설정·승인창·Ctrl+Alt+A 와 동기화) + 설정 바로가기.
import { useCallback, useState } from "react";
import { useApprovalMode } from "../utils/useApprovalMode";
import { Chip, Popover, Switch, Button } from "../ui";
import { Icon } from "../ui/icons";

// dzA (A) — 중복 정리: 평소 실행 확인 방식은 입력창 줄(variant="composer")에만 보이고,
// 헤더 칩(hideWhenSafe)은 '확인 없이 실행 중'(실제 주의 상태)일 때만 나타난다.
export default function SafetyChip({ onOpenSettings, variant = "header", hideWhenSafe = false }: {
  onOpenSettings?: () => void;
  variant?: "header" | "composer";
  hideWhenSafe?: boolean;
}) {
  const { enabled, toggle, error } = useApprovalMode();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (hideWhenSafe && !enabled && !open) return null;
  return (
    <span className={`safety-chip-wrap safety-chip-wrap--${variant}`} style={{ position: "relative" }}>
      <Chip tone={enabled ? "warn" : "neutral"} icon={<Icon name={enabled ? "zap" : "shield"} size={14} />} onClick={() => setOpen(o => !o)}
        pressed={open} title="실행 확인 방식 (Ctrl+Alt+A)">
        {enabled ? "확인 없이 실행 중" : "확인 후 실행"}
      </Chip>
      <Popover open={open} onClose={close} className="safety-popover">
        <div className="safety-popover__row">
          <div>
            <div className="safety-popover__title">확인 없이 실행</div>
            <div className="safety-popover__desc">Codex 명령·파일 승인과 MCP 입력 확인창을 띄우지 않습니다. Ctrl+Alt+A</div>
          </div>
          <Switch checked={enabled} onChange={() => toggle()} label="확인 없이 실행" />
        </div>
        <div className="safety-popover__note">기능별 허용 범위 · 개별 도구 잠금 · SafeMode 차단은 이 스위치와 상관없이 항상 적용됩니다.</div>
        {error && <div role="alert" className="safety-popover__error">{error}</div>}
        {onOpenSettings && (
          <Button size="sm" variant="ghost" onClick={() => { close(); onOpenSettings(); }}>권한과 안전 설정 →</Button>
        )}
      </Popover>
    </span>
  );
}
