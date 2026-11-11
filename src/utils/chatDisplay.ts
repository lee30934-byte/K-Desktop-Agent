// v0.7.86 UI 7단계 — 대화 표시 값(대화 폭 / 어시스턴트 표시 방식).
// 토글 UI 는 8단계 설정 '대화 표시'에서 생긴다. 이 단계는 LS 값만 읽어
// :root 의 data-chat-width / data-assistant-style 로 반영한다 (CSS 는 o2 에서만 사용).
// 기본값은 '보통' 폭 + 문서형(목업 충실도 fidA 에서 K 가 목업을 승인해 말풍선형 → 문서형으로 바꿈).
export type ChatWidth = "narrow" | "normal" | "wide";
export type AssistantStyle = "bubble" | "document";
export const CHAT_WIDTH_KEY = "kda_chat_width";
export const ASSISTANT_STYLE_KEY = "kda_assistant_style";
export const CHAT_DISPLAY_EVENT = "kda-chat-display-changed";

export function readChatWidth(): ChatWidth {
  try {
    const v = localStorage.getItem(CHAT_WIDTH_KEY);
    return v === "narrow" || v === "wide" ? v : "normal";
  } catch { return "normal"; }
}

export function readAssistantStyle(): AssistantStyle {
  // fidA (2026-11-11 K: 목업이 더 낫다) — 기본은 목업처럼 문서형. '말풍선형'을 직접 고른 경우만 말풍선.
  try { return localStorage.getItem(ASSISTANT_STYLE_KEY) === "bubble" ? "bubble" : "document"; }
  catch { return "document"; }
}

export function applyChatDisplay() {
  try {
    const root = document.documentElement;
    root.dataset.chatWidth = readChatWidth();
    root.dataset.assistantStyle = readAssistantStyle();
  } catch { /* ignore */ }
}
