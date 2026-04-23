/**
 * 기본 프롬프트 템플릿 정의
 */

import type { PromptTemplate } from "./types";

export const DEFAULT_PROMPTS: PromptTemplate[] = [
  // ─── 파일 관리 ───────────────────────────────────────
  {
    id: "cleanup-downloads",
    name: "다운로드 폴더 정리",
    description: "다운로드 폴더의 파일을 확장자별로 자동 분류합니다",
    command: "cleanup-downloads",
    template: "다운로드 폴더(C:\\Users\\user\\Downloads)를 확장자별로 정리해줘. 먼저 dry_run으로 계획을 보여주고 확인 후 실행해.",
    icon: "📥",
    category: "files",
  },
  {
    id: "recent-files",
    name: "최근 수정 파일",
    description: "최근 7일 이내 수정된 파일들을 보여줍니다",
    command: "recent-files",
    template: "내 문서 폴더에서 최근 7일 이내 수정된 파일들을 보여줘.",
    icon: "🕐",
    category: "files",
  },
  {
    id: "find-large-files",
    name: "대용량 파일 찾기",
    description: "100MB 이상의 대용량 파일을 검색합니다",
    command: "find-large",
    template: "C 드라이브에서 100MB 이상의 큰 파일들을 찾아서 목록으로 보여줘. 경로와 크기를 알려줘.",
    icon: "💾",
    category: "files",
  },
  {
    id: "disk-usage",
    name: "디스크 용량 확인",
    description: "드라이브의 전체/사용/남은 용량을 확인합니다",
    command: "disk",
    template: "현재 디스크 용량을 확인해줘. 전체 용량, 사용량, 남은 공간을 알려줘.",
    icon: "💿",
    category: "files",
  },

  // ─── 화면/자동화 ─────────────────────────────────────
  {
    id: "screenshot-explain",
    name: "화면 캡처 & 설명",
    description: "현재 화면을 캡처하고 내용을 설명합니다",
    command: "screenshot",
    template: "현재 화면을 스크린샷 찍고 화면에 뭐가 있는지 설명해줘.",
    icon: "📸",
    category: "screen",
  },
  {
    id: "window-list",
    name: "열린 창 목록",
    description: "현재 실행 중인 모든 창 목록을 보여줍니다",
    command: "windows",
    template: "현재 열려있는 창 목록을 보여줘.",
    icon: "🪟",
    category: "screen",
  },
  {
    id: "running-apps",
    name: "실행 중인 앱",
    description: "현재 실행 중인 주요 프로세스를 보여줍니다",
    command: "apps",
    template: "지금 실행 중인 주요 앱/프로그램 목록을 보여줘.",
    icon: "📱",
    category: "screen",
  },

  // ─── 생산성 ──────────────────────────────────────────
  {
    id: "daily-summary",
    name: "오늘의 요약",
    description: "오늘 할 일과 메모를 요약합니다",
    command: "today",
    template: "오늘의 할 일 목록과 최근 메모들을 요약해서 보여줘.",
    icon: "📋",
    category: "productivity",
  },
  {
    id: "todo-list",
    name: "할 일 목록",
    description: "현재 등록된 할 일 목록을 보여줍니다",
    command: "todo",
    template: "현재 할 일 목록을 보여줘.",
    icon: "✅",
    category: "productivity",
  },
  {
    id: "add-todo",
    name: "할 일 추가",
    description: "새로운 할 일을 추가합니다",
    command: "add-todo",
    template: "할 일을 추가해줘: ",
    icon: "➕",
    category: "productivity",
  },
  {
    id: "habit-check",
    name: "습관 체크",
    description: "오늘의 습관 체크 현황을 보여줍니다",
    command: "habits",
    template: "오늘의 습관 체크 현황을 보여줘.",
    icon: "🎯",
    category: "productivity",
  },
  {
    id: "note-search",
    name: "메모 검색",
    description: "저장된 메모에서 검색합니다",
    command: "search-notes",
    template: "메모에서 다음 내용을 검색해줘: ",
    icon: "🔍",
    category: "productivity",
  },

  // ─── 앱 실행 ─────────────────────────────────────────
  {
    id: "open-browser",
    name: "브라우저 열기",
    description: "기본 브라우저에서 URL을 엽니다",
    command: "open",
    template: "브라우저에서 열어줘: ",
    icon: "🌐",
    category: "apps",
  },
  {
    id: "launch-preset",
    name: "앱 프리셋 실행",
    description: "등록된 앱 프리셋을 실행합니다",
    command: "preset",
    template: "앱 프리셋 목록을 보여주고, 원하는 프리셋을 실행할 수 있게 해줘.",
    icon: "🚀",
    category: "apps",
  },

  // ─── 클립보드 ────────────────────────────────────────
  {
    id: "clipboard-read",
    name: "클립보드 읽기",
    description: "현재 클립보드 내용을 보여줍니다",
    command: "clipboard",
    template: "현재 클립보드에 있는 내용을 보여줘.",
    icon: "📋",
    category: "clipboard",
  },
  {
    id: "snippet-list",
    name: "스니펫 목록",
    description: "저장된 스니펫 목록을 보여줍니다",
    command: "snippets",
    template: "저장된 스니펫 목록을 보여줘.",
    icon: "📝",
    category: "clipboard",
  },
];

/**
 * 명령어로 프롬프트 찾기
 */
export function findPromptByCommand(command: string): PromptTemplate | undefined {
  return DEFAULT_PROMPTS.find((p) => p.command === command);
}

/**
 * 검색어로 프롬프트 필터링
 */
export function filterPrompts(query: string): PromptTemplate[] {
  const q = query.toLowerCase().trim();
  if (!q) return DEFAULT_PROMPTS;

  return DEFAULT_PROMPTS.filter(
    (p) =>
      p.command.toLowerCase().includes(q) ||
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q)
  );
}

/**
 * 카테고리별 그룹핑
 */
export function groupPromptsByCategory(
  prompts: PromptTemplate[]
): Record<string, PromptTemplate[]> {
  return prompts.reduce((acc, prompt) => {
    const category = prompt.category || "other";
    if (!acc[category]) acc[category] = [];
    acc[category].push(prompt);
    return acc;
  }, {} as Record<string, PromptTemplate[]>);
}

/**
 * 카테고리 표시 이름
 */
export const CATEGORY_LABELS: Record<string, string> = {
  files: "파일 관리",
  screen: "화면/자동화",
  productivity: "생산성",
  apps: "앱 실행",
  clipboard: "클립보드",
  other: "기타",
};
