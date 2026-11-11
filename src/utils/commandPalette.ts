// v0.7.86 UI 9단계 — 명령 팔레트 (두 배치 공통, Ctrl+K / Ctrl+P / 전역 Ctrl+Shift+P).
// 그룹: 동작 / 빠른 요청 / 대화 이동 / 설정. 옛 이름(세션 초기화, 자동 승인, 대화 압축 …)도 키워드로 찾는다.
// 설정 항목은 Settings.tsx 의 <section id="settings-sec-…"> 앵커로 그룹을 열고 그 섹션까지 스크롤한다.
import type { SettingsTabId } from "./settingsTabs";

export type PaletteGroup = "action" | "quick" | "conversation" | "settings";

export const PALETTE_GROUP_LABELS: Record<PaletteGroup, string> = {
  action: "동작",
  quick: "빠른 요청",
  conversation: "대화 이동",
  settings: "설정",
};

export const PALETTE_GROUP_ORDER: PaletteGroup[] = ["action", "quick", "conversation", "settings"];

export interface PaletteItem {
  id: string;
  label: string;
  group: PaletteGroup;
  icon?: string;
  shortcut?: string;
  hint?: string;
  keywords?: string[];
  run: () => void;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

// 라벨·키워드·힌트·그룹 이름 중 하나라도 검색어를 포함하면 맞음 (띄어쓰기 무시)
export function paletteItemMatches(item: Pick<PaletteItem, "label" | "keywords" | "hint" | "group">, query: string): boolean {
  const q = norm(query);
  if (!q) return true;
  return [item.label, item.hint ?? "", PALETTE_GROUP_LABELS[item.group], ...(item.keywords ?? [])].some((t) => norm(t).includes(q));
}

// 검색 결과: 그룹 순서를 지키고, 검색어가 없을 때는 대화 이동을 최근 limit 개로 줄인다.
export function filterPaletteItems<T extends PaletteItem>(items: T[], query: string, recentLimit = 6): T[] {
  const hits = items.filter((it) => paletteItemMatches(it, query));
  const out: T[] = [];
  for (const g of PALETTE_GROUP_ORDER) {
    const inGroup = hits.filter((it) => it.group === g);
    out.push(...(g === "conversation" && !query.trim() ? inGroup.slice(0, recentLimit) : inGroup));
  }
  return out;
}

export interface SettingsAnchor {
  id: string; // Settings.tsx 의 section id
  tab: SettingsTabId;
  title: string;
  keywords?: string[];
}

export const SETTINGS_SECTION_ANCHORS: SettingsAnchor[] = [
  // ① 일반
  { id: "settings-sec-startup", tab: "general", title: "시작", keywords: ["자동 시작", "부팅"] },
  { id: "settings-sec-shortcuts", tab: "general", title: "단축키", keywords: ["키보드", "핫키"] },
  { id: "settings-sec-update", tab: "general", title: "업데이트", keywords: ["버전", "새 버전"] },
  { id: "settings-sec-app", tab: "general", title: "앱", keywords: ["종료", "끄기"] },
  { id: "settings-sec-about", tab: "general", title: "정보", keywords: ["버전 정보"] },
  // ② AI 엔진
  { id: "settings-sec-active-model", tab: "ai", title: "활성 모델", keywords: ["모델", "엔진", "claude", "codex"] },
  { id: "settings-sec-providers", tab: "ai", title: "AI 모델 연동", keywords: ["api 키", "로그인", "엔진 연결"] },
  { id: "settings-sec-perf", tab: "ai", title: "성능 모드", keywords: ["추론", "속도"] },
  { id: "settings-sec-orchestration", tab: "ai", title: "멀티 엔진 오케스트레이션", keywords: ["멀티 엔진"] },
  { id: "settings-sec-usage-pages", tab: "ai", title: "사용량 페이지", keywords: ["사용량", "한도"] },
  { id: "settings-sec-usage-tracking", tab: "ai", title: "사용량 추적", keywords: ["ccusage", "rate limit", "한도"] },
  // ③ 권한과 안전
  { id: "settings-sec-safety-summary", tab: "safety", title: "안전 상태 요약", keywords: ["안전"] },
  { id: "settings-sec-safety-order", tab: "safety", title: "적용 순서", keywords: ["권한 순서"] },
  { id: "settings-sec-approval", tab: "safety", title: "실행 확인", keywords: ["확인 없이 실행", "자동 승인", "승인"] },
  { id: "settings-sec-categories", tab: "safety", title: "기능별 허용 범위", keywords: ["권한", "카테고리"] },
  { id: "settings-sec-precise-lock", tab: "safety", title: "정밀 잠금", keywords: ["도구 잠금", "권한"] },
  { id: "settings-sec-tool-safety", tab: "safety", title: "Connector/Tool Safety Layer", keywords: ["도구 안전"] },
  { id: "settings-sec-safemode-schedule", tab: "safety", title: "SafeMode 자동 전환 스케줄", keywords: ["세이프모드", "safemode"] },
  { id: "settings-sec-final-review", tab: "safety", title: "Final-Review Gate", keywords: ["최종 검토"] },
  // ④ 에이전트 동작
  { id: "settings-sec-experimental", tab: "agent", title: "실험 기능", keywords: ["실험"] },
  { id: "settings-sec-task-recovery", tab: "agent", title: "작업 복구", keywords: ["장시간 작업", "재개"] },
  { id: "settings-sec-profile", tab: "agent", title: "Lee Profile (개인 응답 규칙)", keywords: ["응답 규칙", "프로필"] },
  { id: "settings-sec-resources", tab: "agent", title: "리소스 (파일 시스템 감시)", keywords: ["폴더 감시", "리소스"] },
  // ⑤ 도구 (MCP)
  { id: "settings-sec-mcp-active", tab: "tools", title: "활성 MCP 도구", keywords: ["mcp", "도구"] },
  { id: "settings-sec-mcp-catalog", tab: "tools", title: "추가 가능한 MCP 서버", keywords: ["mcp 추가"] },
  { id: "settings-sec-mcp-builder", tab: "tools", title: "커스텀 도구 만들기", keywords: ["플러그인"] },
  // ⑥ 연결
  { id: "settings-sec-telegram", tab: "connect", title: "텔레그램 연동", keywords: ["텔레그램", "telegram", "모바일", "원격"] },
  // ⑦ 화면·비서
  { id: "settings-sec-ui-layout", tab: "display", title: "화면 스타일", keywords: ["화면 배치", "레이아웃", "o2", "클래식"] },
  { id: "settings-sec-theme", tab: "display", title: "테마", keywords: ["다크", "라이트", "색"] },
  { id: "settings-sec-bubble", tab: "display", title: "말풍선 색상", keywords: ["색상"] },
  { id: "settings-sec-chat-display", tab: "display", title: "대화 표시", keywords: ["폭", "글자"] },
  // ⑧ 데이터·백업
  { id: "settings-sec-data-folder", tab: "data", title: "데이터 폴더", keywords: ["저장 위치"] },
  { id: "settings-sec-app-backup", tab: "data", title: "앱 백업·복구", keywords: ["안전장치", "백업", "복구"] },
  { id: "settings-sec-conversation-backup", tab: "data", title: "대화 백업", keywords: ["내보내기", "가져오기", "전체 백업"] },
  { id: "settings-sec-memory-sync", tab: "data", title: "Memory Sync (Git)", keywords: ["메모리 동기화", "git"] },
  // ⑨ 고급·문제 해결
  { id: "settings-sec-setup", tab: "advanced", title: "필수 도구 (설치·진단)", keywords: ["설치", "진단", "의존성"] },
  { id: "settings-sec-runtime", tab: "advanced", title: "런타임", keywords: ["재기동", "다시 연결", "sidecar"] },
  { id: "settings-sec-zombie", tab: "advanced", title: "좀비 codex 프로세스", keywords: ["남은 프로세스"] },
  { id: "settings-sec-vm-compat", tab: "advanced", title: "화면 호환 (VM · 원격 데스크톱)", keywords: ["vm", "gpu", "원격"] },
  { id: "settings-sec-path-map", tab: "advanced", title: "경로 매핑 (WSL / VM)", keywords: ["wsl"] },
];
