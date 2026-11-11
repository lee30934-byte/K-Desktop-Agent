// v0.7.86 fidC — o2 설정 전체 페이지 조각 (evidence/ui-redesign-20261111/mockup.html '설정' 화면).
// 모양만 담당한다. 상태·저장은 Settings.tsx 의 기존 state/핸들러를 그대로 받아 쓴다 (로직 변경 없음).
// classic 배치에서는 렌더되지 않는다.
import { Fragment, type ReactNode } from "react";
import { Icon, type IconName } from "../ui";
import type { SettingsTabId } from "../utils/settingsTabs";

/** 그룹 nav 의 단색 라인 아이콘 (목업 스프라이트와 같은 모양) */
export const SETTINGS_GROUP_ICONS: Record<SettingsTabId, IconName> = {
  general: "sliders",
  ai: "cpu",
  safety: "shieldCheck",
  agent: "bot",
  tools: "wrench",
  connect: "plug",
  display: "palette",
  data: "db",
  advanced: "buoy",
};

/** 번호 붙은 섹션 제목 + 작은 태그 + 경로 복사 버튼. h2 는 설정 검색이 읽도록 eyebrow 클래스를 함께 단다. */
export function O2SecHead({ title, badge, path, desc }: { title: string; badge?: string; path: string; desc?: ReactNode }) {
  const copy = () => { try { void navigator.clipboard?.writeText(path); } catch { /* ignore */ } };
  return (
    <div className="o2s-head">
      <div className="o2s-head__row">
        <h2 className="eyebrow o2s-head__title">{title}</h2>
        {badge && <span className="o2s-badge">{badge}</span>}
        <button type="button" className="o2s-copy" onClick={copy} aria-label="섹션 경로 복사" title={`섹션 경로 복사 — ${path}`}>
          <Icon name="link" size={14} />
        </button>
      </div>
      {desc && <p className="o2s-head__desc">{desc}</p>}
    </div>
  );
}

export type O2SegTone = "a" | "q" | "x";
/** 세그먼트 버튼. tone: a=허용(초록) · q=묻기/중립(파랑) · x=차단(빨강) */
export function O2Seg<T extends string>({ value, options, onChange, label }:
  { value: T; options: Array<{ value: T; label: string; tone: O2SegTone; title?: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="o2s-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} title={o.title}
          className={`o2s-seg__opt o2s-seg__opt--${o.tone}${o.value === value ? " is-on" : ""}`}
          onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** 테두리 목록의 한 줄: 아이콘 칸 · 제목/설명 · 오른쪽 컨트롤 */
export function O2Row({ icon, title, sub, children, mono }:
  { icon: IconName; title: ReactNode; sub?: ReactNode; children?: ReactNode; mono?: boolean }) {
  return (
    <div className="o2s-row">
      <span className="o2s-row__ico" aria-hidden="true"><Icon name={icon} size={16} /></span>
      <div className="o2s-row__tx">
        <b className={mono ? "o2s-row__title settings-row-title o2s-mono" : "o2s-row__title settings-row-title"}>{title}</b>
        {sub && <small>{sub}</small>}
      </div>
      {children}
    </div>
  );
}

/** 목업과 같은 스위치 (role=switch). 켜짐 색은 tone 으로 (확인 없이 실행 = warn) */
export function O2Switch({ checked, onChange, label, tone = "accent" }:
  { checked: boolean; onChange: () => void; label: string; tone?: "accent" | "warn" }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={onChange}
      className={`o2s-switch o2s-switch--${tone}${checked ? " is-on" : ""}`} />
  );
}

export interface O2SafetyCounts { auto: number; ask: number; manual: number }

/** 권한과 안전 맨 위 요약 카드: 상태 칩 + 4단계 흐름 */
export function O2SafetySummary({ autoApproval, counts, locked, safeModeLabel }:
  { autoApproval: boolean; counts: O2SafetyCounts; locked: number; safeModeLabel: string }) {
  const approvalLabel = autoApproval ? "확인 없이 실행 중" : "확인 후 실행";
  const steps: Array<{ n: number; title: string; sub: ReactNode; hl?: boolean }> = [
    { n: 1, title: "기능별 허용 범위", sub: "허용 · 묻기 · 차단" },
    { n: 2, title: "실행 확인", sub: <span className={autoApproval ? "o2s-warn" : undefined}>{approvalLabel}</span>, hl: true },
    { n: 3, title: "개별 도구 잠금", sub: locked > 0 ? `${locked}개 잠김` : "잠긴 도구 없음" },
    { n: 4, title: "SafeMode", sub: "위험도 기반 차단" },
  ];
  return (
    <div className="o2s-summary" data-testid="o2-safety-summary" style={{ order: 1 }}>
      <div className="o2s-summary__pills">
        <span className="o2s-pill"><Icon name={autoApproval ? "zap" : "shield"} size={14} /><b className={autoApproval ? "o2s-warn" : undefined}>{approvalLabel}</b></span>
        <span className="o2s-pill">기능별 허용 범위 <b className="o2s-g">허용 {counts.auto}</b> · <b className="o2s-y">묻기 {counts.ask}</b> · <b className="o2s-r">차단 {counts.manual}</b></span>
        <span className="o2s-pill"><Icon name="lock" size={14} />잠긴 도구 <b>{locked}</b></span>
        <span className="o2s-pill">SafeMode <b>{safeModeLabel}</b></span>
      </div>
      <div className="o2s-flow">
        {steps.map((s, i) => (
          <Fragment key={s.n}>
            {i > 0 && <span className="o2s-flow__arrow" aria-hidden="true"><Icon name="chevronRight" size={14} /></span>}
            <div className={`o2s-step${s.hl ? " o2s-step--hl" : ""}`}>
              <small>{s.n}</small><b>{s.title}</b><span>{s.sub}</span>
            </div>
          </Fragment>
        ))}
      </div>
      <p className="o2s-flow-note">뒤 단계가 막으면 앞에서 허용해도 실행되지 않습니다. 확인 없이 실행은 확인창만 건너뜁니다.</p>
    </div>
  );
}
