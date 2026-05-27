/**
 * SafeMode 자동 전환 스케줄 — Phase 91 (v0.6.33).
 *
 * localStorage 에 규칙 배열 저장. 매 분 (또는 turn 시작 시) 현재 시각이 매칭되는 규칙이 있으면
 * 그 mode 로 자동 전환. 매칭 규칙 없으면 K 의 마지막 manual 선택 유지.
 *
 * 예시 규칙:
 *   - 평일 9-18시 strict (회사 PC) → { days: [1..5], startHour: 9, endHour: 18, mode: "strict" }
 *   - 주말 종일 off → { days: [0, 6], startHour: 0, endHour: 24, mode: "off" }
 *   - 야간 자동 balanced → { days: [0..6], startHour: 22, endHour: 24, mode: "balanced" }
 *
 * 설계 원칙 (memory/feedback_root_cause):
 *   - 순수 함수 — App.tsx 가 1분마다 호출
 *   - 규칙 충돌 (같은 시각에 2개 매칭) 시 첫 번째 규칙 채택 (배열 순서)
 *   - K 의 manual override 보존: 최근 5분 안에 K 가 직접 변경했으면 자동 안 뜸 (다음 phase 후보)
 *   - localStorage 자체에 규칙만 박음, 적용 결과는 별도 키 (kda_safe_mode) 변경
 */

export type SafeMode = "off" | "balanced" | "strict";

/** 0=일, 1=월, 2=화, 3=수, 4=목, 5=금, 6=토 (JS Date.getDay() 기준) */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface SafeModeRule {
  id: string; // UUID — 삭제/편집 키
  label?: string; // K 가 보기 좋은 이름 (예: "회사 PC 평일")
  days: DayOfWeek[]; // 적용 요일들
  startHour: number; // 0-23 (포함)
  endHour: number; // 1-24 (배제) — 24 = 자정
  mode: SafeMode;
  enabled: boolean;
}

const STORAGE_KEY = "kda_safe_mode_schedule";
// Phase 92 (v0.6.34) — K manual override 보존.
// K 가 Settings 의 SafeMode 토글로 직접 mode 를 바꾸면 그 시각을 박아두고, schedule tick 은
// 5분 안엔 자동 전환 skip. K 가 "방금 잠깐 풀었는데 1분 만에 다시 strict 로 되돌아갔다" 같은
// 답답함 회피.
const OVERRIDE_KEY = "kda_safe_mode_manual_override_at";
const OVERRIDE_WINDOW_MS = 5 * 60 * 1000;

/** K 가 SafeMode 를 직접 변경했을 때 호출. localStorage 에 timestamp 박음. */
export function markManualOverride(now: number = Date.now()): void {
  try {
    localStorage.setItem(OVERRIDE_KEY, String(now));
  } catch {
    /* ignore */
  }
}

/** 현재 시점이 manual override 보호 윈도우 안인지 (5분). */
export function isWithinManualOverride(now: number = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return false;
    const t = Number(raw);
    if (!Number.isFinite(t)) return false;
    return now - t < OVERRIDE_WINDOW_MS;
  } catch {
    return false;
  }
}

/** override timestamp 와 남은 ms — UI 가 "K manual: 4:23 남음" 표시할 때 사용. */
export function getManualOverrideInfo(
  now: number = Date.now(),
): { at: number; remainingMs: number } | null {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return null;
    const t = Number(raw);
    if (!Number.isFinite(t)) return null;
    const remainingMs = OVERRIDE_WINDOW_MS - (now - t);
    if (remainingMs <= 0) return null;
    return { at: t, remainingMs };
  } catch {
    return null;
  }
}

export function clearManualOverride(): void {
  try {
    localStorage.removeItem(OVERRIDE_KEY);
  } catch {
    /* ignore */
  }
}

export const MANUAL_OVERRIDE_WINDOW_MS = OVERRIDE_WINDOW_MS;

export function loadSchedule(): SafeModeRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is SafeModeRule =>
          r &&
          typeof r.id === "string" &&
          Array.isArray(r.days) &&
          typeof r.startHour === "number" &&
          typeof r.endHour === "number" &&
          (r.mode === "off" || r.mode === "balanced" || r.mode === "strict") &&
          typeof r.enabled === "boolean",
      )
      .map((r) => ({
        ...r,
        days: r.days.filter((d): d is DayOfWeek => d >= 0 && d <= 6) as DayOfWeek[],
        startHour: Math.max(0, Math.min(23, r.startHour)),
        endHour: Math.max(1, Math.min(24, r.endHour)),
      }));
  } catch {
    return [];
  }
}

export function saveSchedule(rules: SafeModeRule[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  } catch {
    /* ignore — localStorage 꽉 차도 graceful */
  }
}

/**
 * 현재 시각에 매칭되는 첫 번째 규칙의 mode 반환. 없으면 null.
 * 매칭 = enabled true + 오늘 요일 in days + startHour ≤ 현재시 < endHour.
 */
export function evaluateScheduleAt(
  date: Date,
  rules: SafeModeRule[],
): { mode: SafeMode; rule: SafeModeRule } | null {
  const day = date.getDay() as DayOfWeek;
  const hour = date.getHours();
  for (const r of rules) {
    if (!r.enabled) continue;
    if (!r.days.includes(day)) continue;
    if (hour < r.startHour) continue;
    if (hour >= r.endHour) continue;
    return { mode: r.mode, rule: r };
  }
  return null;
}

const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;

export function formatDays(days: DayOfWeek[]): string {
  if (days.length === 0) return "(요일 없음)";
  if (days.length === 7) return "매일";
  // 연속 평일 = 월~금 같이 보이게
  const sorted = [...days].sort();
  const isWeekday =
    sorted.length === 5 &&
    sorted[0] === 1 &&
    sorted[1] === 2 &&
    sorted[2] === 3 &&
    sorted[3] === 4 &&
    sorted[4] === 5;
  if (isWeekday) return "평일";
  const isWeekend = sorted.length === 2 && sorted[0] === 0 && sorted[1] === 6;
  if (isWeekend) return "주말";
  return sorted.map((d) => DAY_LABELS[d]).join(",");
}

export function formatHourRange(startHour: number, endHour: number): string {
  const fmt = (h: number) => (h === 24 ? "24:00" : `${String(h).padStart(2, "0")}:00`);
  return `${fmt(startHour)}-${fmt(endHour)}`;
}

export function newRule(): SafeModeRule {
  return {
    id: (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? (crypto as Crypto).randomUUID()
      : `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    label: "",
    days: [1, 2, 3, 4, 5], // 평일 default
    startHour: 9,
    endHour: 18,
    mode: "balanced",
    enabled: true,
  };
}

export const DAYS_LIST: ReadonlyArray<{ value: DayOfWeek; label: string }> = [
  { value: 0, label: "일" },
  { value: 1, label: "월" },
  { value: 2, label: "화" },
  { value: 3, label: "수" },
  { value: 4, label: "목" },
  { value: 5, label: "금" },
  { value: 6, label: "토" },
];
