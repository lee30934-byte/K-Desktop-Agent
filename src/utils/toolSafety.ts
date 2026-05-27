/**
 * Connector/Tool Safety Layer — Frontend lookup (Phase 84 / Lee #6).
 *
 * sidecar/src/toolSafety.ts 의 CATEGORY_RISK 와 동일한 값을 frontend 에서도 표시.
 * sidecar 가 진실 source — 변경 시 양쪽 모두 동기화 (DRY 위반 의식적 — TS 모듈 공유 안 됨).
 *
 * frontend 는 카테고리 ID → 위험 배지 + Safety Layer 섹션 UI 표시만 담당.
 * 실제 권한 게이트 (disallowed-tools, safeMode 강등) 는 sidecar 가 강제 집행.
 */

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type SafeMode = "off" | "balanced" | "strict";

export interface RiskBadgeInfo {
  icon: string;
  label: string;
  color: string;
}

export const RISK_BADGES: Record<RiskLevel, RiskBadgeInfo> = {
  low: { icon: "🟢", label: "낮음", color: "#22c55e" },
  medium: { icon: "🟡", label: "보통", color: "#eab308" },
  high: { icon: "🟠", label: "높음", color: "#f97316" },
  critical: { icon: "🔴", label: "치명", color: "#ef4444" },
};

export interface CategoryRiskRow {
  level: RiskLevel;
  summary: string;
  dimensions: string[]; // 한국어 요약
}

// sidecar/src/toolSafety.ts CATEGORY_RISK 미러
export const CATEGORY_RISK: Record<string, CategoryRiskRow> = {
  file_read: {
    level: "low",
    summary: "디스크 조회만 — 변경 없음",
    dimensions: ["읽기 전용"],
  },
  file_write: {
    level: "medium",
    summary: "파일 쓰기/복사 — 복구는 비교적 쉬움",
    dimensions: ["쓰기"],
  },
  file_delete: {
    level: "high",
    summary: "이동/정리/복원 — 대량 변경 시 복구 어려움",
    dimensions: ["쓰기", "파괴적"],
  },
  app_launch: {
    level: "high",
    summary: "외부 프로세스 spawn — 임의 코드 실행 우회 가능",
    dimensions: ["코드 실행"],
  },
  system_control: {
    level: "high",
    summary: "마우스/키보드/클립보드 점유 — K 의 입력 흐름 침범",
    dimensions: ["입력 점유", "개인정보", "쓰기"],
  },
  screenshot: {
    level: "medium",
    summary: "화면 캡처 — K 가 보고 있는 모든 화면 노출",
    dimensions: ["개인정보", "화면 점유"],
  },
  web_fetch: {
    level: "medium",
    summary: "외부 HTTP 호출 — 응답 신뢰성/유출 가능",
    dimensions: ["네트워크"],
  },
  db_access: {
    level: "medium",
    summary: "개인 DB write — todo/note/habit 삭제 포함",
    dimensions: ["쓰기"],
  },
  ui_automation: {
    level: "medium",
    summary: "백그라운드 UI 조작 — K 입력 무점유지만 앱 상태는 변경",
    dimensions: ["쓰기", "화면 점유"],
  },
  web_automation: {
    level: "medium",
    summary: "헤드리스 브라우저 — 외부 사이트 클릭/입력 자동화",
    dimensions: ["네트워크", "쓰기"],
  },
};

// strict 모드에서 추가 차단되는 도구 — UI 미리보기용
export const STRICT_BLOCKED_TOOLS: readonly string[] = [
  "mcp__k-personal__fm_organize_folder",
  "mcp__k-personal__fm_restore_file",
  "mcp__k-personal__app_kill",
];

export function riskOfCategory(id: string): CategoryRiskRow {
  return (
    CATEGORY_RISK[id] ?? {
      level: "medium",
      summary: `알려지지 않은 카테고리 "${id}" — medium 으로 가정`,
      dimensions: [],
    }
  );
}

/**
 * SafeMode 의 정책 요약 (UI 표시용). sidecar 의 applySafeMode 와 동일한 규칙.
 */
export interface SafeModePolicy {
  mode: SafeMode;
  title: string;
  description: string;
  effect: string[];
}

export const SAFE_MODE_POLICIES: Record<SafeMode, SafeModePolicy> = {
  off: {
    mode: "off",
    title: "🟢 끔",
    description: "K 가 직접 설정한 카테고리 권한만 적용. 기본값 — 백 호환.",
    effect: ["사용자 토글 그대로", "강등 없음"],
  },
  balanced: {
    mode: "balanced",
    title: "🟡 균형",
    description: "위험도 높음 이상 카테고리를 자동 ask 로 강등 (auto 였던 것만).",
    effect: [
      "🟠 높음 카테고리 → 매번 확인",
      "🔴 치명 카테고리 → 매번 확인",
      "🟢 낮음 / 🟡 보통 카테고리는 그대로",
    ],
  },
  strict: {
    mode: "strict",
    title: "🔴 엄격",
    description: "보통 이상은 ask 로, 높음 이상은 manual 로. 일부 치명 도구는 자동 차단.",
    effect: [
      "🟡 보통 카테고리 → 매번 확인",
      "🟠 높음 카테고리 → 수동만",
      "🔴 치명 카테고리 → 수동만",
      "fm_organize_folder / fm_restore_file / app_kill 자동 차단",
    ],
  },
};

/**
 * SafeMode 가 카테고리에 미치는 영향 (UI 의 "이 모드 적용 시 X 변경" 미리보기용).
 *  - 입력 effective 가 K 의 현재 설정
 *  - mode 가 적용된 후 어떤 카테고리가 어떤 level 로 강등되는지 반환
 */
export function previewSafeModeImpact(
  effective: Record<string, "auto" | "ask" | "manual">,
  mode: SafeMode,
): Array<{ id: string; from: string; to: string; risk: RiskLevel }> {
  if (mode === "off") return [];
  const changes: Array<{ id: string; from: string; to: string; risk: RiskLevel }> = [];
  for (const [id, level] of Object.entries(effective)) {
    if (level !== "auto") continue;
    const info = riskOfCategory(id);
    let to = level as string;
    if (mode === "balanced") {
      if (info.level === "high" || info.level === "critical") to = "ask";
    } else if (mode === "strict") {
      if (info.level === "medium") to = "ask";
      else if (info.level === "high" || info.level === "critical") to = "manual";
    }
    if (to !== level) {
      changes.push({ id, from: level, to, risk: info.level });
    }
  }
  return changes;
}
