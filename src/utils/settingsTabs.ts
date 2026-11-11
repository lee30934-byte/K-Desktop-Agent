// v0.7.86 UI 8단계 — 설정 9개 그룹 (두 배치 공통).
// 섹션 블록은 Settings.tsx 에 그대로 두고 data-tab 값과 style order 만 바꿨다.
// 'tools'·'ai' id 는 유지한다 (Settings.tsx 의 activeTab === "tools" effect 가 MCP 목록을 불러온다).
export type SettingsTabId = "general" | "ai" | "safety" | "agent" | "tools" | "connect" | "display" | "data" | "advanced";

export const SETTINGS_TABS: { id: SettingsTabId; icon: string; label: string; desc: string }[] = [
  { id: "general", icon: "⚙️", label: "일반", desc: "시작, 단축키, 업데이트, 앱 종료와 버전 정보" },
  { id: "ai", icon: "🤖", label: "AI 엔진", desc: "엔진 연결과 모델, 성능 모드, 사용량·한도" },
  { id: "safety", icon: "🛡️", label: "권한과 안전", desc: "무엇을 허용하고 언제 묻는지 정합니다. 위에서 아래 순서로 적용됩니다" },
  { id: "agent", icon: "🧠", label: "에이전트 동작", desc: "실험 기능, 장시간 작업 재개, 개인 응답 규칙, 폴더 감시" },
  // Phase 67 (v0.6.2) — MCP 도구 인스펙터 + 카탈로그 + 커스텀 plugin 빌더
  { id: "tools", icon: "🔧", label: "도구 (MCP)", desc: "연결된 도구 확인, 도구 추가, 직접 만들기" },
  { id: "connect", icon: "📱", label: "연결", desc: "텔레그램·모바일로 밖에서 원격 조작" },
  { id: "display", icon: "🎨", label: "화면·비서", desc: "화면 스타일, 테마, 말풍선 색, 대화 표시" },
  { id: "data", icon: "💾", label: "데이터·백업", desc: "데이터 위치, 앱 백업·복구, 대화 백업, 메모리 동기화" },
  { id: "advanced", icon: "🩺", label: "고급·문제 해결", desc: "설치·진단, 런타임 재기동, 남은 프로세스, 호환 모드" },
];

export const LS_ACTIVE_SETTINGS_TAB = "kda_active_settings_tab";
export const LS_SETTINGS_TAB_V2 = "kda_settings_tab_v2";

// 옛 6탭 id → 새 그룹 id. 'agent' 는 의미가 바뀌어(예전 권한 → 지금 에이전트 동작)
// kda_settings_tab_v2 플래그가 없을 때(옛 값)만 이 표로 옮긴다.
const LEGACY_SETTINGS_TAB_MAP: Record<string, SettingsTabId> = {
  ai: "ai", agent: "safety", appearance: "display", system: "general", tools: "tools", safety: "safety",
};

// 저장된 값 → 열 그룹. 모르는 값이면 'ai'.
export function resolveSettingsTab(saved: string | null, migrated: boolean): SettingsTabId {
  if (!saved) return "ai";
  if (!migrated && Object.prototype.hasOwnProperty.call(LEGACY_SETTINGS_TAB_MAP, saved)) return LEGACY_SETTINGS_TAB_MAP[saved];
  return SETTINGS_TABS.some((t) => t.id === saved) ? (saved as SettingsTabId) : "ai";
}

// localStorage 에서 읽고 v2 플래그를 남긴다 (Settings 는 앱 시작 때 마운트되므로 첫 읽기에서 이전이 끝난다)
export function readSettingsTab(): SettingsTabId {
  try {
    const saved = localStorage.getItem(LS_ACTIVE_SETTINGS_TAB);
    const tab = resolveSettingsTab(saved, localStorage.getItem(LS_SETTINGS_TAB_V2) === "1");
    // 이전한 값을 바로 써 둔다 — StrictMode 가 초기화 함수를 두 번 불러도 두 번째가 옛 값을 '모르는 값'으로 읽지 않게
    if (saved !== tab) localStorage.setItem(LS_ACTIVE_SETTINGS_TAB, tab);
    localStorage.setItem(LS_SETTINGS_TAB_V2, "1");
    return tab;
  } catch {
    return "ai";
  }
}

// 설정 검색: eyebrow 와 settings-row-title 텍스트로 섹션을 찾는다 (그룹을 가로질러)
export function settingsSectionMatches(texts: string[], query: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const q = norm(query);
  if (!q) return false;
  return texts.some((t) => norm(t).includes(q));
}
