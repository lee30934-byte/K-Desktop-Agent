// v0.7.86 UI 개편 1단계 — 공통 프리미티브 (design-spec.md 7장).
// 업무 로직 없음. 모양·접근성만 담당한다. 의미 토큰(index.css 하단)만 사용.
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import "./ui.css";

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "default";
  size?: "sm" | "md";
};
export function Button({ variant = "default", size = "md", className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={cx("ui-btn", `ui-btn--${variant}`, `ui-btn--${size}`, className)} {...rest} />;
}

export function IconButton({ label, className, type = "button", children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type={type} aria-label={label} title={rest.title ?? label} className={cx("ui-iconbtn", className)} {...rest}>{children}</button>;
}

export type ChipTone = "neutral" | "warn" | "danger" | "accent" | "ok";
export function Chip({ tone = "neutral", icon, children, onClick, title, className, pressed }:
  { tone?: ChipTone; icon?: ReactNode; children?: ReactNode; onClick?: () => void; title?: string; className?: string; pressed?: boolean }) {
  const cls = cx("ui-chip", `ui-chip--${tone}`, onClick && "ui-chip--clickable", className);
  const body = <>{icon && <span className="ui-chip__icon" aria-hidden>{icon}</span>}{children != null && <span className="ui-chip__text">{children}</span>}</>;
  return onClick
    ? <button type="button" className={cls} onClick={onClick} title={title} aria-pressed={pressed}>{body}</button>
    : <span className={cls} title={title}>{body}</span>;
}

export function Switch({ checked, onChange, label, disabled }:
  { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      className={cx("ui-switch", checked && "ui-switch--on")} onClick={() => onChange(!checked)}>
      <span className="ui-switch__thumb" />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }:
  { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ui-seg" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value}
          className={cx("ui-seg__opt", o.value === value && "ui-seg__opt--on")} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export type NoticeTone = "info" | "warn" | "danger" | "ok";
/** 본문 상단 알림 띠. 기존 배너의 className·role 을 그대로 넘겨 테스트·자동화 셀렉터를 유지한다. */
export function Notice({ tone = "info", className, role, children, actions, onClose, closeLabel = "닫기" }:
  { tone?: NoticeTone; className?: string; role?: string; children: ReactNode; actions?: ReactNode; onClose?: () => void; closeLabel?: string }) {
  return (
    <div className={cx("ui-notice", `ui-notice--${tone}`, className)} role={role ?? (tone === "danger" ? "alert" : "status")}>
      <div className="ui-notice__body">{children}</div>
      {actions && <div className="ui-notice__actions">{actions}</div>}
      {onClose && <button type="button" className="ui-notice__close" aria-label={closeLabel} onClick={onClose}>×</button>}
    </div>
  );
}

export function NoticeStack({ children }: { children: ReactNode }) {
  return <div className="ui-notice-stack">{children}</div>;
}

/** 우측 슬라이드오버. 오버레이(그리드 열 아님) — 본문 폭을 줄이지 않는다. Esc 로 닫힘. */
export function SlideOver({ open, title, onClose, children, tabs, width }:
  { open: boolean; title?: ReactNode; onClose: () => void; children: ReactNode; tabs?: ReactNode; width?: number }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <aside ref={ref} className={cx("ui-slideover", open && "ui-slideover--open")} aria-hidden={!open}
      style={width ? { width } : undefined} role="complementary">
      <header className="ui-slideover__head">
        {tabs ?? <div className="ui-slideover__title">{title}</div>}
        <button type="button" className="ui-iconbtn" aria-label="패널 닫기" onClick={onClose}>×</button>
      </header>
      <div className="ui-slideover__body">{open ? children : null}</div>
    </aside>
  );
}

/** 원형 진행률 (컨텍스트 사용량 등). value 0~100. */
export function Ring({ value, size = 22, stroke = 3, tone, label }:
  { value: number; size?: number; stroke?: number; tone?: "ok" | "warn" | "danger"; label?: string }) {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const t = tone ?? (v >= 85 ? "danger" : v >= 70 ? "warn" : "ok");
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return (
    <svg className={cx("ui-ring", `ui-ring--${t}`)} width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label ?? `${Math.round(v)}%`}>
      <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="ui-ring__track" fill="none" />
      <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="ui-ring__bar" fill="none"
        strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`} strokeLinecap="round" />
    </svg>
  );
}

/** 간단한 팝오버: 바깥 클릭·Esc 로 닫힘. 위치는 부모(position:relative) 기준. */
export function Popover({ open, onClose, children, align = "end", className }:
  { open: boolean; onClose: () => void; children: ReactNode; align?: "start" | "end"; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const t = setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open, onClose]);
  if (!open) return null;
  return <div ref={ref} className={cx("ui-popover", `ui-popover--${align}`, className)} role="dialog">{children}</div>;
}
