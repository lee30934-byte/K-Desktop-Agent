/**
 * Connector/Tool Safety Layer — Phase 84 (Lee #6).
 *
 * 목적:
 *   - 권한 카테고리 / 개별 도구를 위험도(low/medium/high/critical) + 위험 차원으로 분류
 *   - "Safe Mode" 토글 (off/balanced/strict) 로 일괄 강등 정책 적용
 *   - 위험도 high+ 도구 호출 시 sidecar.log + emit 으로 가시성 확보
 *
 * 설계 원칙 (memory/feedback_root_cause):
 *   - 순수 함수 모듈 — index.ts 의 buildToolFlags 가 호출
 *   - 백 호환: safeMode="off" 가 기본. 기존 동작 변경 없음
 *   - hard enforcement 는 기존 disallowed-tools path 재사용 (Claude CLI)
 *   - hardcode lookup 의 함정 (memory/pitfall_codex_model_context_window_dynamic):
 *     "위험도는 도구 ID 만으로 결정 안 됨" — 카테고리 + 도구별 override 양방향
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export type PermLevel = "auto" | "ask" | "manual";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type SafeMode = "off" | "balanced" | "strict";

/**
 * 위험 차원 (orthogonal). 한 도구가 여러 차원을 동시에 가질 수 있음.
 * 이 분류는 RiskLevel 산출의 근거 + UI 의 "왜 high 인가" 설명 둘 다 담당.
 */
export interface RiskDimensions {
  /** 단순 조회만 가능 (디스크/메모리/외부 상태 변경 X) */
  readOnly?: boolean;
  /** 파일/DB/외부 상태에 write 발생 */
  writes?: boolean;
  /** 복구 어려운 변경 — 대량 이동/덮어쓰기/프로세스 종료 */
  destructive?: boolean;
  /** K 의 개인 정보 노출 위험 — 클립보드/스크린샷/keylog 등 */
  privacy?: boolean;
  /** 외부 네트워크 호출 발생 */
  network?: boolean;
  /** K 의 마우스/키보드 점유 (cc_*) */
  controlsInput?: boolean;
  /** K 의 화면 캡처 / 보이는 윈도우 조작 */
  controlsScreen?: boolean;
  /** 임의 코드/명령 실행 가능 — Bash, app_launch */
  executesCode?: boolean;
}

export interface RiskInfo {
  level: RiskLevel;
  dimensions: RiskDimensions;
  summary: string;
}

// ─── Category-level risk ───────────────────────────────────────────────────
/**
 * 카테고리별 기본 위험도. 도구 단위 override 가 없으면 이 값 사용.
 * - file_read 만 low. 나머지는 medium 이상.
 * - destructive / executesCode 차원이 있으면 자동으로 high+.
 */
export const CATEGORY_RISK: Record<string, RiskInfo> = {
  file_read: {
    level: "low",
    dimensions: { readOnly: true },
    summary: "디스크 조회만 — 변경 없음",
  },
  file_write: {
    level: "medium",
    dimensions: { writes: true },
    summary: "파일 쓰기/복사 — 복구는 비교적 쉬움",
  },
  file_delete: {
    level: "high",
    dimensions: { writes: true, destructive: true },
    summary: "이동/정리/복원 — 대량 변경 시 복구 어려움",
  },
  app_launch: {
    level: "high",
    dimensions: { executesCode: true },
    summary: "외부 프로세스 spawn — 임의 코드 실행 우회 가능",
  },
  system_control: {
    level: "high",
    dimensions: { controlsInput: true, privacy: true, writes: true },
    summary: "마우스/키보드/클립보드 점유 — K 의 입력 흐름 침범",
  },
  screenshot: {
    level: "medium",
    dimensions: { privacy: true, controlsScreen: true, readOnly: true },
    summary: "화면 캡처 — K 가 보고 있는 모든 화면 노출",
  },
  web_fetch: {
    level: "medium",
    dimensions: { network: true },
    summary: "외부 HTTP 호출 — 응답 신뢰성/유출 가능",
  },
  db_access: {
    level: "medium",
    dimensions: { writes: true },
    summary: "개인 DB write — todo/note/habit 삭제 포함",
  },
  ui_automation: {
    level: "medium",
    dimensions: { writes: true, controlsScreen: true },
    summary: "백그라운드 UI 조작 — K 입력 무점유지만 앱 상태는 변경",
  },
  web_automation: {
    level: "medium",
    dimensions: { network: true, writes: true },
    summary: "헤드리스 브라우저 — 외부 사이트 클릭/입력 자동화",
  },
};

// ─── Tool-level overrides ─────────────────────────────────────────────────
/**
 * 카테고리만으로 부족한 도구 단위 override.
 * 키 = namespacedToolName 또는 Claude CLI built-in 이름.
 *
 * 추가 기준:
 *   - "복구 거의 불가" (대량 이동/덮어쓰기) → critical
 *   - "K 의 다른 작업 중단" (프로세스 종료) → critical
 *   - "프라이버시 직격" (클립보드 raw 읽기) → high
 *   - "임의 셸" → critical (이미 HIGH_RISK_BUILTINS 가 잡지만 명시)
 */
export const TOOL_RISK_OVERRIDE: Record<string, RiskInfo> = {
  // ── Critical: 결과 되돌리기 거의 불가 ──
  "mcp__k-personal__fm_organize_folder": {
    level: "critical",
    dimensions: { writes: true, destructive: true },
    summary: "폴더 통째 자동 정리 — 대량 이동, 사전 시뮬레이션 권장",
  },
  "mcp__k-personal__fm_restore_file": {
    level: "critical",
    dimensions: { writes: true, destructive: true },
    summary: "백업 복원으로 현재 파일 덮어쓰기 — 최신 작업 손실 위험",
  },
  "mcp__k-personal__app_kill": {
    level: "critical",
    dimensions: { destructive: true, executesCode: true },
    summary: "다른 앱 강제 종료 — 저장 안 된 작업 손실",
  },
  Bash: {
    level: "critical",
    dimensions: { executesCode: true, destructive: true },
    summary: "임의 셸 명령 — 파일 삭제/네트워크/원격 실행 모두 가능",
  },
  BashOutput: {
    level: "critical",
    dimensions: { executesCode: true },
    summary: "백그라운드 셸 출력 — Bash 와 동등 위험",
  },
  KillShell: {
    level: "high",
    dimensions: { destructive: true },
    summary: "실행 중 셸 강제 종료",
  },

  // ── High: 프라이버시 직격 ──
  "mcp__k-personal__clip_get": {
    level: "high",
    dimensions: { privacy: true, readOnly: true },
    summary: "클립보드 raw 읽기 — 비밀번호/토큰 포함 가능",
  },
  "mcp__k-personal__cc_keyboard_type": {
    level: "high",
    dimensions: { controlsInput: true, executesCode: true, privacy: true },
    summary: "임의 키 입력 주입 — 잘못된 창에 입력 시 폭주",
  },
  "mcp__k-personal__cc_keyboard_hotkey": {
    level: "high",
    dimensions: { controlsInput: true, executesCode: true },
    summary: "Win+R 등 시스템 단축키 실행 가능",
  },
  "mcp__k-personal__cc_screenshot": {
    level: "high",
    dimensions: { privacy: true, controlsScreen: true, readOnly: true },
    summary: "전체 화면 캡처 — 다른 앱의 민감 정보 노출 가능",
  },
  "mcp__k-personal__fm_move_file": {
    level: "high",
    dimensions: { writes: true, destructive: true },
    summary: "단건 이동 — 원본 위치에서 사라짐",
  },

  // ── Web Fetch 풀세트 (built-in) — privacy + network ──
  WebFetch: {
    level: "medium",
    dimensions: { network: true },
    summary: "지정 URL fetch — 응답 자동 분석",
  },
  WebSearch: {
    level: "medium",
    dimensions: { network: true },
    summary: "검색 엔진 조회 — 검색어가 외부로 나감",
  },
};

// ─── Always-blocked-when-strict critical tools ─────────────────────────────
/**
 * SafeMode = strict 일 때 자동 호출 자체를 막을 도구.
 * (백 호환: SafeMode = "off" 면 미적용 — 기존 동작 유지)
 *
 * 이미 ALWAYS_BLOCKED_BYPASS 가 잡는 Task/Monitor/Skill/NotebookEdit 와 다른 layer:
 * 여기 도구들은 "정상 도구지만 K 가 직접 의도해야 안전" 한 도구. strict 모드의 ack 라인.
 */
export const STRICT_BLOCKED_TOOLS: readonly string[] = [
  "mcp__k-personal__fm_organize_folder",
  "mcp__k-personal__fm_restore_file",
  "mcp__k-personal__app_kill",
];

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * 카테고리 ID → 위험도. 알려지지 않은 ID 는 medium 으로 보수적 fallback.
 */
export function riskOfCategory(categoryId: string): RiskInfo {
  return (
    CATEGORY_RISK[categoryId] ?? {
      level: "medium",
      dimensions: {},
      summary: `알려지지 않은 카테고리 "${categoryId}" — medium 으로 가정`,
    }
  );
}

/**
 * 도구 namespacedName 의 위험도. override 우선, 없으면 카테고리.
 * 카테고리도 모르면 medium fallback.
 */
export function riskOfTool(
  namespacedName: string,
  categoryId?: string,
): RiskInfo {
  const override = TOOL_RISK_OVERRIDE[namespacedName];
  if (override) return override;
  if (categoryId) return riskOfCategory(categoryId);
  return {
    level: "medium",
    dimensions: {},
    summary: `미분류 도구 "${namespacedName}" — medium 으로 가정`,
  };
}

/**
 * SafeMode 정책에 따라 카테고리 권한을 강등.
 *   - off:      변경 없음
 *   - balanced: high+ 카테고리를 ask 로 강등 (auto → ask, manual 은 유지)
 *   - strict:   medium+ 카테고리를 ask 로, high+ 카테고리는 manual 로 강등
 *
 * 강등 결과를 새 PermissionsMap 으로 반환. 입력은 mutate 하지 않음.
 */
export function applySafeMode(
  effective: Record<string, PermLevel>,
  mode: SafeMode,
): Record<string, PermLevel> {
  if (mode === "off") return { ...effective };

  const out: Record<string, PermLevel> = { ...effective };
  for (const [id, level] of Object.entries(out)) {
    if (level !== "auto") continue; // K 의 명시 다운그레이드는 존중
    const info = riskOfCategory(id);

    if (mode === "balanced") {
      // high+ 만 ask 로 강등
      if (info.level === "high" || info.level === "critical") {
        out[id] = "ask";
      }
    } else if (mode === "strict") {
      // medium 은 ask, high+ 는 manual
      if (info.level === "medium") {
        out[id] = "ask";
      } else if (info.level === "high" || info.level === "critical") {
        out[id] = "manual";
      }
    }
  }
  return out;
}

/**
 * SafeMode + strict 결합 시 추가로 자동 차단할 도구 목록 (STRICT_BLOCKED_TOOLS).
 * 카테고리 토글이 auto 여도 박힘 — 정밀 잠금과 같은 layer.
 */
export function strictExtraDisallowed(mode: SafeMode): string[] {
  if (mode !== "strict") return [];
  return [...STRICT_BLOCKED_TOOLS];
}

/**
 * UI 표시용 위험도 라벨. emoji + 한국어 한 단어.
 */
export function riskBadge(level: RiskLevel): { icon: string; label: string; color: string } {
  switch (level) {
    case "low":
      return { icon: "🟢", label: "낮음", color: "#22c55e" };
    case "medium":
      return { icon: "🟡", label: "보통", color: "#eab308" };
    case "high":
      return { icon: "🟠", label: "높음", color: "#f97316" };
    case "critical":
      return { icon: "🔴", label: "치명", color: "#ef4444" };
  }
}

/**
 * 위험 차원을 사람용 한국어 문자열 배열로.
 */
export function dimensionsToKorean(d: RiskDimensions): string[] {
  const out: string[] = [];
  if (d.readOnly) out.push("읽기 전용");
  if (d.writes) out.push("쓰기");
  if (d.destructive) out.push("파괴적");
  if (d.privacy) out.push("개인정보");
  if (d.network) out.push("네트워크");
  if (d.controlsInput) out.push("입력 점유");
  if (d.controlsScreen) out.push("화면 점유");
  if (d.executesCode) out.push("코드 실행");
  return out;
}

/**
 * SafeMode 가 적용된 결과 요약 — UI 미리보기 / sidecar 로그용.
 */
export interface SafeModeImpact {
  mode: SafeMode;
  downgraded: Array<{ id: string; from: PermLevel; to: PermLevel; risk: RiskLevel }>;
  extraDisallowed: string[];
  summary: string;
}

export function summariseSafeModeImpact(
  before: Record<string, PermLevel>,
  after: Record<string, PermLevel>,
  mode: SafeMode,
): SafeModeImpact {
  const downgraded: SafeModeImpact["downgraded"] = [];
  for (const [id, fromLevel] of Object.entries(before)) {
    const toLevel = after[id] ?? fromLevel;
    if (toLevel !== fromLevel) {
      downgraded.push({
        id,
        from: fromLevel,
        to: toLevel,
        risk: riskOfCategory(id).level,
      });
    }
  }
  const extraDisallowed = strictExtraDisallowed(mode);
  const lines: string[] = [];
  if (mode === "off") {
    lines.push("SafeMode off — 사용자 설정 그대로");
  } else {
    lines.push(`SafeMode ${mode}: ${downgraded.length}개 카테고리 강등, ${extraDisallowed.length}개 도구 추가 차단`);
  }
  return {
    mode,
    downgraded,
    extraDisallowed,
    summary: lines.join("\n"),
  };
}
