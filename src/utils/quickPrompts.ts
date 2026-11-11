// v0.7.86 UI 7단계 — 빠른 요청 프리셋. CommandPalette 의 빠른 프롬프트와
// o2 빈 화면 제안 카드(SUGGESTION_IDS 4개)가 같은 목록을 쓴다.
export interface QuickPrompt {
  id: string;
  label: string;
  icon: string;
  prompt: string;
}

export const QUICK_PROMPTS: QuickPrompt[] = [
  { id: "screenshot", label: "현재 화면 스크린샷 분석", icon: "📷", prompt: "현재 화면을 스크린샷으로 캡처해서 분석해줘" },
  { id: "todo-list", label: "할 일 목록 보기", icon: "✅", prompt: "할 일 목록 보여줘" },
  { id: "notes", label: "메모 목록 보기", icon: "📝", prompt: "메모 목록 보여줘" },
  { id: "habits", label: "습관 체크 현황", icon: "📊", prompt: "습관 현황 보여줘" },
  { id: "disk-usage", label: "디스크 사용량 확인", icon: "💾", prompt: "C 드라이브 용량 확인해줘" },
  { id: "recent-files", label: "최근 수정된 파일", icon: "📁", prompt: "다운로드 폴더에서 최근 수정된 파일 보여줘" },
  { id: "running-apps", label: "실행 중인 앱 목록", icon: "🖥️", prompt: "실행 중인 프로세스 목록 보여줘" },
  { id: "clipboard", label: "클립보드 내용 확인", icon: "📋", prompt: "현재 클립보드에 뭐가 있어?" },
];

/** 빈 화면 제안 카드 4개 (스펙 3.4). 팔레트 순서는 그대로 두고 여기서 고른다. */
export const SUGGESTION_IDS = ["screenshot", "recent-files", "disk-usage", "todo-list"] as const;

export function suggestionPrompts(): QuickPrompt[] {
  return SUGGESTION_IDS.map((id) => QUICK_PROMPTS.find((p) => p.id === id)).filter((p): p is QuickPrompt => !!p);
}
