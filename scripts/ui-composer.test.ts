// v0.7.86 UI 개편 7단계 — 메시지 열 · 입력창 회귀 테스트 (evidence/ui-redesign-20261111/design-spec.md 3.4, 3.5, 4.4, 8장 7단계, 10.1 F1/F12).
// o2: --chat-max-width 가운데 열, 카드 입력창, '>' 없음, ↑ 보내기, 응답 중 [■ 정지 ▾(전체 작업 정지)] + [↑ 지금 반영/예약] 나란히,
//     빈 화면 제안 카드 4개(팔레트 빠른 요청과 같은 목록), 대화 폭·문서형은 LS 값만 읽고 기본은 말풍선형.
// classic: 예전 입력창(> 접두어, SEND →, 정지 + 전체 정지 + 지금 반영/예약)과 예전 빈 화면 그대로.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const composer = read("../src/components/Composer.tsx");
const chat = read("../src/components/MainChat.tsx");
const palette = read("../src/components/CommandPalette.tsx");
const quick = read("../src/utils/quickPrompts.ts");
const display = read("../src/utils/chatDisplay.ts");
const css = read("../src/App.css");

const o2Branch = composer.slice(composer.indexOf("{isO2 ? (\n          <div className=\"composer-actions\">"), composer.indexOf(") : (<>"));
const classicBranch = composer.slice(composer.indexOf(") : (<>"), composer.indexOf("</form>"));

test("Composer 는 useUiLayout 으로 o2/classic 을 가른다", () => {
  assert.match(composer, /import \{ useUiLayout \} from "\.\.\/utils\/useUiLayout";/);
  assert.match(composer, /const \{ isO2 \} = useUiLayout\(\);/);
  assert.ok(o2Branch.length > 200 && classicBranch.length > 200, "두 분기 탐지");
});

test("o2: '>' 접두어 없음, 기본 안내 문구, ↑ 보내기", () => {
  assert.match(composer, /\{!isO2 && <div className="composer-prefix mono">\{">"\}<\/div>\}/);
  assert.match(composer, /const O2_PLACEHOLDER = "무엇이든 요청하세요 · Enter 전송 · Shift\+Enter 줄바꿈";/);
  assert.match(composer, /placeholder \?\? \(isO2 \? O2_PLACEHOLDER : "메시지를 입력하세요\. Enter로 전송, Shift\+Enter로 줄바꿈\."\)/);
  // 상태별 안내(연결 대기 / 응답 중)는 두 배치 공통 유지 (C10)
  assert.match(composer, /\? "연결 대기 중\.\.\."/);
  assert.match(o2Branch, /aria-label="보내기"/);
  assert.doesNotMatch(o2Branch, /SEND/);
});

test("o2: 응답 중 [■ 정지 ▾] 와 [↑ 지금 반영 / 예약] 이 나란히 (F1 — 제출 버튼을 없애지 않음)", () => {
  assert.match(o2Branch, /onClick=\{onInterrupt\}[\s\S]*?\{isStopping \? "정지 재요청" : "정지"\}/);
  assert.match(o2Branch, /aria-label="정지 옵션"[\s\S]*?aria-haspopup="menu"/);
  assert.match(o2Branch, /role="menuitem"[\s\S]*?onHardStop\(\);[\s\S]*?전체 작업 정지/);
  assert.match(o2Branch, /\{isStreaming \? \(\n\s+<button\n\s+type="submit"[\s\S]*?\{sendMode === "steer" \? "지금 반영" : "예약"\}/);
  // 정지 묶음과 제출 버튼이 같은 composer-actions 안에 동시에 존재
  assert.ok(o2Branch.indexOf("composer-stop-split") < o2Branch.indexOf('"지금 반영"'));
  // ▾ 메뉴는 바깥 클릭·Esc·응답 종료 시 닫힘
  assert.match(composer, /useEffect\(\(\) => \{ if \(!isStreaming\) setStopMenuOpen\(false\); \}, \[isStreaming\]\);/);
  assert.match(composer, /e\.key === "Escape"\) setStopMenuOpen\(false\)/);
});

test("classic: 예전 버튼 구성 그대로 (SEND → / 정지 + 전체 정지 / 지금 반영·예약)", () => {
  assert.match(classicBranch, /className="composer-stop-group"/);
  assert.match(classicBranch, /onClick=\{onHardStop\}[\s\S]*?전체 정지/);
  assert.match(classicBranch, /SEND\n\s+<span className="send-arrow">→<\/span>/);
  assert.match(classicBranch, /\{isStreaming && <button type="submit" className="composer-btn composer-btn-send"[\s\S]*?\{sendMode === "steer" \? "지금 반영" : "예약"\}/);
  assert.match(composer, /<div className="composer-corner composer-corner-tl" \/>/);
});

test("카드 위 줄(세그먼트·예약 칩·넛지)과 드래그·붙여넣기·'/' 피커·높이 grip 은 두 배치 공통", () => {
  for (const s of ['aria-label="작업 중 메시지 전송 방식"', 'className="queue-chip"', "{contextNudge}", "onPaste={handlePaste}",
    "<PromptPicker", 'aria-label="Composer 높이 조절"', "파일을 여기에 놓으세요", "onDrop={handleDrop}"]) {
    assert.ok(composer.includes(s), s);
  }
});

test("o2 빈 화면: 제안 카드 4개, 팔레트 빠른 요청과 같은 목록, 누르면 입력창에 채움(바로 실행 안 함)", () => {
  assert.match(quick, /export const SUGGESTION_IDS = \["screenshot", "recent-files", "disk-usage", "todo-list"\] as const;/);
  const ids = [...quick.matchAll(/\{ id: "([\w-]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 8, "팔레트 빠른 요청 8개 유지");
  for (const id of ["screenshot", "recent-files", "disk-usage", "todo-list"]) assert.ok(ids.includes(id), id);
  assert.match(palette, /import \{ QUICK_PROMPTS \} from "\.\.\/utils\/quickPrompts";/);
  assert.match(palette, /\.\.\.QUICK_PROMPTS\.map\(\(p\): Command => \(\{[\s\S]*?onSendMessage\(p\.prompt\)/);
  const empty = chat.slice(chat.indexOf("function EmptyState()"), chat.indexOf("// 진행 중 표시"));
  assert.match(empty, /if \(isO2\) \{[\s\S]*?무엇을 도와드릴까요\?[\s\S]*?suggestionPrompts\(\)\.map/);
  assert.match(empty, /onClick=\{\(\) => fillComposer\(p\.prompt\)\}/);
  assert.match(chat, /new CustomEvent\("kda-builder-prompt", \{ detail: \{ prompt \} \}\)/);
  assert.match(composer, /window\.addEventListener\("kda-builder-prompt", handler\);/);
  // classic 빈 화면은 예전 그대로
  const classic = empty.slice(empty.indexOf("\n  return ("));
  assert.match(classic, /<div className="empty-grid" \/>/);
  assert.match(classic, /<div className="eyebrow">Ready<\/div>/);
  assert.match(classic, /예시: "다운로드 폴더 정리해줘 \(먼저 미리보기\)"/);
});

test("메시지 열: 항목을 chat-col 로 감싸고 o2 CSS 만 가운데 --chat-max-width", () => {
  assert.match(chat, /<div className="chat-col" style=\{dimmed \? DIM_STYLE : NORMAL_STYLE\}>/);
  assert.match(css, /:root\[data-layout="o2"\] \.chat-col \{[^}]*max-width: var\(--chat-max-width\); margin: 0 auto;/);
  assert.match(css, /:root\[data-layout="o2"\] \.composer-wrapper \{[^}]*padding: 0 max\(var\(--space-5, 24px\), calc\(\(100% - var\(--o2-composer-reserve\) - var\(--chat-max-width\)\) \/ 2\)\);/);
  assert.match(css, /:root\[data-layout="o2"\] \.composer-corner \{ display: none; \}/);
  // 새 구조 규칙은 모두 o2 로 한정 (classic .composer / .chat-col 무변경)
  const section = css.slice(css.indexOf("v0.7.86 UI 7단계 (o2 전용)"));
  for (const line of section.split("\n")) {
    // 새 클래스(composer-actions / composer-stop-split / composer-stop-menu / empty-suggestion…)는 o2 에서만 렌더되므로 예외
    if (/^\.(composer|composer-wrapper|composer-btn[\w-]*|composer-attach-btn|composer-steering-bar|chat-col|messages|empty-state)[\s{.:,]/.test(line)) {
      assert.fail(`o2 범위 밖 규칙: ${line}`);
    }
  }
});

// fidA (2026-11-11) — K 가 목업을 승인해 o2 답변 기본 표시를 문서형으로 바꿈 (말풍선형은 직접 고를 때만).
test("대화 폭·문서형: LS 값만 읽고 기본은 보통 폭 + 문서형 (F12, fidA)", () => {
  assert.match(display, /export const CHAT_WIDTH_KEY = "kda_chat_width";/);
  assert.match(display, /export const ASSISTANT_STYLE_KEY = "kda_assistant_style";/);
  assert.match(display, /=== "bubble" \? "bubble" : "document"/);
  assert.match(display, /v === "narrow" \|\| v === "wide" \? v : "normal"/);
  assert.match(chat, /applyChatDisplay\(\);\n\s+window\.addEventListener\(CHAT_DISPLAY_EVENT, applyChatDisplay\);/);
  assert.match(css, /:root\[data-chat-width="narrow"\] \{ --chat-max-width: 680px; \}/);
  assert.match(css, /:root\[data-chat-width="wide"\] \{ --chat-max-width: 960px; \}/);
  assert.match(css, /:root\[data-layout="o2"\]\[data-assistant-style="document"\] \.chat-col > \.msg-assistant/);
});
