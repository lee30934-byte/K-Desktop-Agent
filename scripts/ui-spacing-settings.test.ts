// 여백·글자 다듬기 spB — 설정 전체 페이지 · 명령 팔레트(Ctrl+K) · 헤더 ⋯ 메뉴 (o2 전용).
// ① 설정 왼쪽 열 줄 40, 내용 열 고정 696 → 최대 1040(좌우 48), 행 최소 56·안쪽 16/20, 설명 13, 버튼 34·스위치 40×22·입력 40.
// ② 카드 밖 부품(오류·버튼 줄)과 하위 행 목록이 카드에 붙지 않게. 한글은 단어 중간에서 줄바꿈하지 않음(keep-all).
// ③ 팔레트 폭 640·줄 42, ⋯ 메뉴 폭 248·줄 38. ④ classic 모달·팔레트·메뉴 규칙은 예전 그대로.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = read("../src/App.tsx");
const appCss = read("../src/App.css");
const fidSettings = read("../src/styles/o2-settings.css");
const css = read("../src/styles/o2-spacing-settings.css");

test("o2-spacing-settings.css — 모든 규칙이 o2 아래, o2-spacing.css 다음에 불러옴", () => {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line === "}" || line.startsWith("@media") || !/[{,]$/.test(line) && !line.includes("{")) continue;
    if (/^[\w-]+\s*:/.test(line)) continue; // 선언 줄
    assert.match(line, /^:root\[data-layout="o2"\]/, `o2 밖 규칙: ${line}`);
  }
  assert.match(app, /import "\.\/styles\/o2-spacing\.css";[^\n]*\nimport "\.\/styles\/o2-spacing-settings\.css";/);
  assert.doesNotMatch(css, /:is\(\s*>/, ":is() 안에 > 로 시작하는 선택자는 무효 — 규칙 전체가 버려진다");
  assert.doesNotMatch(css, /companion-widget/, "아바타 규칙은 건드리지 않는다");
});

test("설정 페이지 — 왼쪽 열 줄 40, 내용 열 최대 1040 · 좌우 48, 좁은 창 232/28", () => {
  assert.match(css, /\.settings-overlay--page \.settings-tab \{ height: 40px;/);
  assert.match(css, /\.settings-nav-col \.settings-back \{ height: 36px;/);
  assert.match(css, /\.settings-overlay--page \.settings-search \{ height: 38px;/);
  assert.match(css, /\.settings-overlay--page \.settings-body \{ padding: 36px 48px 88px; gap: 44px; word-break: keep-all; overflow-wrap: break-word; \}/);
  assert.match(css, /\.settings-overlay--page \.settings-body > \* \{ max-width: min\(1040px, 100%\); \}/);
  assert.match(css, /@media \(max-width: 1100px\) \{\n[^}]*grid-template-columns: 232px minmax\(0, 1fr\);[^}]*\}\n[^}]*padding: 28px 28px 72px;/);
});

test("설정 행 · 부품 — 행 56 · 16/20, 설명 13, 버튼 34, 스위치 40×22, 입력 40, 권한 세그먼트 30", () => {
  assert.match(css, /\.settings-section > \.settings-row \{ min-height: 56px; padding: 16px 20px; gap: 24px;/);
  assert.match(css, /\.settings-row-desc \{ font-size: 13px; line-height: 1\.65; \}/);
  assert.match(css, /:is\(\.settings-btn, \.settings-btn-oauth\) \{ height: 34px;/);
  assert.match(css, /\.settings-overlay--page \.toggle \{ width: 40px; height: 22px;/);
  assert.match(css, /\.toggle input:checked \+ \.toggle-slider:before \{ transform: translateX\(18px\); \}/);
  assert.match(css, /\.o2s-switch\.is-on::after \{ transform: translateX\(18px\); \}/);
  assert.match(css, /input\[type="url"\]\) \{\n  min-height: 40px;/);
  assert.match(css, /\.o2s-row \{ min-height: 60px; gap: 16px; padding: 12px 20px;/);
  assert.match(css, /\.o2s-seg__opt \{ height: 30px;/);
  // 카드 밖 부품 간격 · 하위 행 목록
  assert.match(css, /\.settings-section > \.settings-row ~ :not\(\.settings-row, \.eyebrow, \[class\*="o2s-"\]\) \{ margin-top: 14px !important; \}/);
  assert.match(css, /\.settings-section > div:not\(\[class\]\) > \.settings-row,\n[^\n]*\.settings-section > \.settings-row div:not\(\[class\]\) > \.settings-row \{/);
});

test("명령 팔레트 640 · 줄 42, 헤더 ⋯ 메뉴 248 · 줄 38", () => {
  assert.match(css, /\.command-palette \{ width: min\(640px, calc\(100vw - 48px\)\); \}/);
  assert.match(css, /\.command-palette-item \{ min-height: 42px;/);
  assert.match(css, /\.command-palette-input:focus-visible \{ outline: none;/);
  assert.match(css, /\.chat-options-body \{\n  width: 248px;/);
  assert.match(css, /\.chat-options-body button \{\n  min-height: 38px;/);
});

test("classic — 설정 모달 · 팔레트 · ⋯ 메뉴 기본 규칙은 예전 값 그대로, fidC o2 값도 그대로 (spB 는 덮어쓰기만)", () => {
  assert.match(appCss, /\.settings-overlay--page \.settings-body > \* \{ width: 100%; max-width: 760px;/);
  assert.match(appCss, /\.command-palette \{\n  width: 560px;/);
  assert.match(appCss, /\.command-palette-item \{\n  display: flex;\n  align-items: center;\n  gap: var\(--space-md\);\n  padding: 10px var\(--space-lg\);/);
  assert.match(appCss, /\.chat-options-body \{ position: absolute; right: 0; top: calc\(100% \+ 8px\); z-index: 65; width: 184px;/);
  assert.match(appCss, /\.chat-options-body button \{ width: 100%; padding: 10px;[^}]*font-size: 12px; \}/);
  assert.match(fidSettings, /\.settings-overlay--page \.settings-body > \* \{ max-width: 696px; \}/);
  assert.match(fidSettings, /\.settings-overlay--page \.settings-tab \{\n  height: 34px;/);
});
