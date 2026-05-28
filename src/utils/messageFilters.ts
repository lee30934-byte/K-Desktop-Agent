/**
 * Phase 101 (v0.6.47) — message filter utilities.
 *
 * pitfall_frontend_filter_chain_bypass 의 "리팩터 후보: filter chain 을 한 곳에 모으기" 박은 fix.
 *
 * 함정 history (이 파일 분리 전):
 * - Phase 98.2 (v0.6.41) ~ Phase 98.4 (v0.6.43) 3 release 동안 `ToolMessageView` 의 `hasImages`
 *   분기가 `MainChat.tsx` 의 outer filter (`msg.role !== "tool"`) 때문에 호출 자체가 막힘.
 *   inner 분기 디버깅 + cache 의심 + react bundle stale 의심 등 헛 path 만 돌다가, line 312-314
 *   의 outer filter 보고 root cause 잡힘. 한 곳에 모아두면 다음 inner conditional 박을 때
 *   여기 와서 audit 가능.
 *
 * 규칙 (새 filter 추가 시):
 * 1. 이 파일 안에 함수 박기. 여러 컴포넌트에서 같은 의도 박지 말 것.
 * 2. JSDoc 에 "어떤 시나리오에 어떤 메시지가 빠지는지" 명시 — 미래 inner conditional 작성자가 audit 가능.
 * 3. 새 inner conditional 박을 때 (Message.tsx 의 분기 등) 호출자가 어떤 메시지를 받는지 명시.
 */

import type { ChatMessage } from "../types";

/**
 * 본문 list 의 visibleMessages — `showToolCards` toggle 의 default OFF (false) 일 때
 * 도구 메시지는 본문에서 숨김. 단 이미지가 있는 도구 메시지는 예외 (Phase 98.4).
 *
 * 호출자: `MainChat.tsx` 의 main rendering loop.
 *
 * 통과되는 메시지:
 * - role !== "tool" (user / assistant / system 등) → 항상 통과
 * - role === "tool" + images.length > 0 → 통과 (본문에 이미지 보임)
 * - role === "tool" + images 없음 → 차단 (도구 호출 panel 에만)
 *
 * showToolCards = true 면 모든 도구 메시지 통과 (필터 자체 skip).
 *
 * 새 inner 분기 박을 때 audit 필요:
 * - 새 분기가 ToolMessageView 안에 박힌다면, 이 filter 가 통과시킨 메시지에만 작동한다.
 * - 이미지 없는 도구 메시지에 새 분기가 작동해야 한다면 → 이 filter 도 수정 필요 (silent fail 방지).
 */
export function filterMessagesForBody(
  messages: ChatMessage[],
  showToolCards: boolean,
): ChatMessage[] {
  if (showToolCards) return messages;
  return messages.filter((msg) => {
    if (msg.role !== "tool") return true;
    // 이미지 있는 tool 메시지는 예외적으로 본문에 표시 (Phase 98.4)
    return Array.isArray(msg.images) && msg.images.length > 0;
  });
}

/**
 * 대화 복사 (clipboard) 시 도구 메시지를 제외한 user/assistant 텍스트만 추출.
 *
 * 호출자: `MainChat.tsx` 의 `handleCopyChat`.
 *
 * 의도: K 가 chat history 를 다른 곳에 paste 할 때 도구 호출 메시지 (대부분 K 의 본 대화와 무관)
 * 가 chat 흐름을 어지럽히지 않게. 이미지 도구 메시지도 텍스트 모드라 의미 적음 — 모두 제외.
 *
 * 만약 미래에 K 가 "도구 호출도 복사하고 싶다" 보고하면 이 filter 의 조건 완화 필요.
 */
export function filterMessagesForCopy(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((msg) => msg.role !== "tool");
}
