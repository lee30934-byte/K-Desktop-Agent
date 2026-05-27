/**
 * Safety Stats — Phase 90 (v0.6.32).
 *
 * SafeMode 활성 시 high/critical 도구 호출(alerts) + REST path 의 strict+critical hard-block(blocks)
 * 횟수를 누적. ~/.kda/safety-stats.json 에 영속화. 7일 rolling day-bucket.
 *
 * Settings 의 "🛡️ SafeMode 주간 통계" 카드가 이걸 표시:
 *   "지난 7일: ⚠ alerts 14회 · 🚫 blocked 2회 · 활성 모드 strict(60%)/balanced(20%)/off(20%)"
 *
 * 설계 원칙 (memory/feedback_root_cause):
 *   - sidecar-config.json 과 분리 — 통계는 자주 write 됨, 다른 config 와 race 방지
 *   - day-bucket UTC date string ("2026-05-27") + 7일 trim
 *   - PAT 같은 secret 절대 박지 않음 (이 파일은 통계만)
 *   - 백 호환: 파일 없거나 형식 변경 → 기본값으로 재생성
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SafetyDayBucket {
  /** UTC 날짜 string (예: "2026-05-27") */
  date: string;
  /** safety_alert event 발생 횟수 (high + critical) */
  alerts: number;
  /** REST path strict+critical blocked 횟수 (Phase 86 의 hard-block) */
  blocks: number;
  /** SafeMode 별 alert 분포 — UI 에 어떤 모드에서 자주 발생했는지 */
  byMode: {
    off: number;
    balanced: number;
    strict: number;
  };
}

export interface SafetyStats {
  /** 누적 (모든 시간) — Settings 에 "설치 이후 총" 으로 표시 */
  totals: {
    alerts: number;
    blocks: number;
  };
  /** 최근 7일 (오늘 포함) day buckets — 오래된 쪽 trim */
  last7Days: SafetyDayBucket[];
  /** 마지막 update 시각 (epoch sec) */
  lastUpdatedAt: number;
  /** 최초 기록 시각 (epoch sec) */
  sinceAt: number;
  /** 자체 schema version (포맷 변경 대비) */
  schemaVersion: number;
}

const STATS_PATH = path.join(os.homedir(), ".kda", "safety-stats.json");
const SCHEMA_VERSION = 1;

const EMPTY_STATS = (): SafetyStats => ({
  totals: { alerts: 0, blocks: 0 },
  last7Days: [],
  lastUpdatedAt: 0,
  sinceAt: Math.floor(Date.now() / 1000),
  schemaVersion: SCHEMA_VERSION,
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/** UTC 기준 오늘 날짜 string ("YYYY-MM-DD") — day bucket key */
function todayDate(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 7일 이전 day-bucket 들 제거. 오래된 것 잘라내고 오늘 bucket 자리 보장.
 */
function trimAndEnsureToday(buckets: SafetyDayBucket[]): SafetyDayBucket[] {
  const today = todayDate();
  // 7일 전 cutoff (오늘 포함 8일 보관 X — 정확히 7 bucket)
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 6); // 오늘 - 6 = 7일 범위
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const filtered = buckets.filter((b) => b.date >= cutoffStr);
  if (!filtered.find((b) => b.date === today)) {
    filtered.push({
      date: today,
      alerts: 0,
      blocks: 0,
      byMode: { off: 0, balanced: 0, strict: 0 },
    });
  }
  // 날짜 정렬 (오래된 → 최신)
  filtered.sort((a, b) => a.date.localeCompare(b.date));
  return filtered;
}

// ─── Public API ────────────────────────────────────────────────────────────

export function loadSafetyStats(): SafetyStats {
  if (!existsSync(STATS_PATH)) return EMPTY_STATS();
  try {
    const raw = readFileSync(STATS_PATH, "utf-8");
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(stripped) as Partial<SafetyStats>;
    // schema version 다르면 reset (백 호환 안전 path)
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      return EMPTY_STATS();
    }
    return {
      totals: {
        alerts: parsed.totals?.alerts ?? 0,
        blocks: parsed.totals?.blocks ?? 0,
      },
      last7Days: Array.isArray(parsed.last7Days)
        ? trimAndEnsureToday(
            parsed.last7Days.filter(
              (b) =>
                b &&
                typeof b.date === "string" &&
                typeof b.alerts === "number" &&
                typeof b.blocks === "number",
            ).map((b) => ({
              date: b.date,
              alerts: b.alerts,
              blocks: b.blocks,
              byMode: {
                off: b.byMode?.off ?? 0,
                balanced: b.byMode?.balanced ?? 0,
                strict: b.byMode?.strict ?? 0,
              },
            })),
          )
        : [],
      lastUpdatedAt: parsed.lastUpdatedAt ?? 0,
      sinceAt: parsed.sinceAt ?? Math.floor(Date.now() / 1000),
      schemaVersion: SCHEMA_VERSION,
    };
  } catch {
    return EMPTY_STATS();
  }
}

function writeSafetyStats(stats: SafetyStats): void {
  try {
    writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), "utf-8");
  } catch {
    /* graceful — 통계는 일회성 정보, 실패해도 본체 동작 무관 */
  }
}

/**
 * Alert 카운트 1 증가 — safety_alert event 발생 시 호출.
 *
 * @param mode 발생 시점의 SafeMode (off 면 alert 안 띄우지만 그래도 일관성 위해 받음)
 */
export function recordAlert(mode: "off" | "balanced" | "strict"): SafetyStats {
  const stats = loadSafetyStats();
  stats.totals.alerts += 1;
  stats.last7Days = trimAndEnsureToday(stats.last7Days);
  const today = stats.last7Days[stats.last7Days.length - 1];
  today.alerts += 1;
  today.byMode[mode] += 1;
  stats.lastUpdatedAt = Math.floor(Date.now() / 1000);
  writeSafetyStats(stats);
  return stats;
}

/**
 * Block 카운트 1 증가 — REST path 의 strict+critical hard-block 발생 시 호출 (Phase 86).
 */
export function recordBlock(): SafetyStats {
  const stats = loadSafetyStats();
  stats.totals.blocks += 1;
  stats.last7Days = trimAndEnsureToday(stats.last7Days);
  const today = stats.last7Days[stats.last7Days.length - 1];
  today.blocks += 1;
  stats.lastUpdatedAt = Math.floor(Date.now() / 1000);
  writeSafetyStats(stats);
  return stats;
}

/**
 * Stats reset — UI 의 "지우기" 버튼 (옵션, 다음 phase 후보).
 */
export function resetSafetyStats(): SafetyStats {
  const fresh = EMPTY_STATS();
  writeSafetyStats(fresh);
  return fresh;
}

/**
 * UI 표시용 요약 — 누적 alerts/blocks + 7일 trend.
 */
export interface SafetyStatsSummary {
  totalAlerts: number;
  totalBlocks: number;
  last7DaysAlerts: number;
  last7DaysBlocks: number;
  byMode: { off: number; balanced: number; strict: number };
  buckets: SafetyDayBucket[];
  sinceAt: number;
  lastUpdatedAt: number;
}

export function summariseSafetyStats(stats: SafetyStats): SafetyStatsSummary {
  const trimmed = trimAndEnsureToday(stats.last7Days);
  let last7DaysAlerts = 0;
  let last7DaysBlocks = 0;
  const byMode = { off: 0, balanced: 0, strict: 0 };
  for (const b of trimmed) {
    last7DaysAlerts += b.alerts;
    last7DaysBlocks += b.blocks;
    byMode.off += b.byMode.off;
    byMode.balanced += b.byMode.balanced;
    byMode.strict += b.byMode.strict;
  }
  return {
    totalAlerts: stats.totals.alerts,
    totalBlocks: stats.totals.blocks,
    last7DaysAlerts,
    last7DaysBlocks,
    byMode,
    buckets: trimmed,
    sinceAt: stats.sinceAt,
    lastUpdatedAt: stats.lastUpdatedAt,
  };
}
