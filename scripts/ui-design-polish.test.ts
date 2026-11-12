// dzC 디자인 고도화 3단계 회귀 테스트 — 설정 전체 페이지 · 명령 팔레트 · ⋯ 메뉴 · 대화상자 (기준: mockup-v2.1 ?screen=settings · palette · main-hover).
// o2: 설정 nav/카드/행/세그먼트(무채색 판 + 색 점)/토글/입력/버튼 토큰화, 4단계 흐름 모두 무채색, 잠긴 도구 칩, 위험도 태그,
//     남은 이모지 → 라인 아이콘(EmojiLabel/EmojiIcon), 팔레트 범위 칩·검색어 강조·키캡, ⋯ 메뉴 아이콘·구분선·'패널' 머리.
// classic: o2-polish.css 를 받지 않고, EmojiLabel/EmojiIcon 은 글자 그대로, 팔레트·메뉴는 예전 분기 그대로.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = read("../src/styles/o2-polish.css");
const indexCss = read("../src/index.css");
const app = read("../src/App.tsx");
const settings = read("../src/components/Settings.tsx");
const o2 = read("../src/components/SettingsO2.tsx");
const palette = read("../src/components/CommandPalette.tsx");
const chat = read("../src/components/MainChat.tsx");

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
(globalThis as any).window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, location: { search: "" } };
(globalThis as any).document ??= { documentElement: { dataset: {} } };

function rules(src: string): [string, string][] {
  const out: [string, string][] = [];
  const body = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const sel = m[1].replace(/@media[^{]*\{/g, "").trim();
    if (!sel.startsWith("@") && !/^(from|to|\d+%)$/.test(sel)) out.push([sel, m[2]]);
  }
  return out;
}
const splitSel = (sel: string) => {
  const parts: string[] = []; let depth = 0, quote = "", cur = "";
  for (const ch of sel) {
    if (quote) { if (ch === quote) quote = ""; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  return [...parts, cur.trim()].filter(Boolean);
};

test("o2-polish.css — 모든 선택자가 o2 한정, o2-content 다음 맨 마지막에 불러옴", () => {
  const all = rules(css);
  assert.ok(all.length > 150, `규칙 수 ${all.length}`);
  for (const [sel] of all) for (const part of splitSel(sel)) assert.ok(part.startsWith(':root[data-layout="o2"]'), `o2 밖 선택자: ${part}`);
  const imports = [...app.matchAll(/^import "\.\/styles\/(o2-[a-z-]+)\.css";/gm)].map((m) => m[1]);
  assert.deepEqual(imports.slice(-2), ["o2-content", "o2-polish"]);
  assert.doesNotMatch(css, /companion-widget/, "아바타 위치 규칙은 건드리지 않는다");
});

test("토큰 규칙 — fg-4 는 비활성에만, 그림자는 떠 있는 레이어(팔레트·대화상자·메뉴)에만, 글로우 없음", () => {
  for (const [sel, body] of rules(css)) {
    if (/--o2-fg-4/.test(body)) assert.match(sel, /disabled/, `fg-4 를 비활성 아닌 곳에: ${sel}`);
    if (/--shadow-(pop|panel)/.test(body)) assert.match(sel, /command-palette|folder-delete-box|folder-instructions-dialog|elicitation|chat-options-body/, `떠 있지 않은 곳에 그림자: ${sel}`);
    assert.doesNotMatch(body, /(?:box-shadow:\s*|,\s*)(?:inset\s+)?0 0 [1-9]\d*px[^,;]*accent/, `글로우 금지: ${sel}`);
  }
  // 반경은 토큰(--r-*) 또는 목업의 작은 고정값(4~9px)만
  for (const [sel, body] of rules(css)) for (const m of body.matchAll(/border-radius:\s*([^;]+)/g)) {
    assert.match(m[1].trim(), /^(var\(--r-(sm|md|lg|pill)\)|[4-9]px|50%|0)( !important)?$/, `${sel}: ${m[1]}`);
  }
});

test("설정 — 4단계 흐름 모두 무채색(선택 모양 없음) · 칩 줄 없음 · 번호 01 · 세그먼트 무채색 판 + 색 점 · 위험도 태그 · 잠긴 도구 칩", () => {
  assert.doesNotMatch(o2, /o2s-step--hl|hl: true|o2s-summary__pills/);
  assert.match(o2, /<small>\{String\(s\.n\)\.padStart\(2, "0"\)\}<\/small>/);
  assert.match(o2, /<span className="o2s-head__num">\{num\[1\]\.padStart\(2, "0"\)\}<\/span>/);
  assert.match(o2, /\{o\.value === value && <i className="o2s-seg__dot" aria-hidden="true" \/>\}/);
  assert.match(css, /\.o2s-seg__opt\.is-on \{ background: var\(--o2-overlay\); color: var\(--o2-fg-1\);/);
  assert.match(css, /\.o2s-seg__opt--x\.is-on \{ color: var\(--o2-danger-text\); \}/);
  assert.match(css, /\.o2s-step \{ padding: 12px 14px; border: 0; border-radius: var\(--r-md\); background: var\(--o2-panel\); box-shadow: inset 0 0 0 1px var\(--o2-line-1\); \}/);
  assert.doesNotMatch(css, /o2s-step--hl/);
  assert.match(settings, /className=\{`o2s-lvl o2s-lvl--\$\{riskOfCategory\(perm\.id\)\.level\}`\}/);
  assert.match(settings, /<O2LockChips names=\{\[\.\.\.lockedTools\]\.sort\(\)\} onUnlock=\{toggleLockTool\} \/>/);
  assert.match(o2, /onClick=\{\(\) => onUnlock\(n\)\} aria-label=\{`\$\{n\} 잠금 해제`\}/);
  // F — 비활성 기본 버튼은 무채색 판 + fg-3
  assert.match(css, /\.settings-btn\.settings-btn-primary:disabled \{ background: var\(--o2-raised\); box-shadow: inset 0 0 0 1px var\(--o2-line-1\); color: var\(--o2-fg-3\); \}/);
  // 상태: 호버 · 누름 · 선택 · 포커스 · 비활성
  for (const c of ["settings-tab", "o2s-seg__opt", "settings-btn", "command-palette-scope", "command-palette-item", "folder-delete-btn", "o2s-lockchip__x"]) {
    assert.ok(new RegExp(`\\.${c}[^{]*:hover`).test(css), `${c} hover`);
  }
  for (const c of ["settings-tab", "o2s-seg__opt", "settings-btn", "command-palette-scope", "folder-delete-btn"]) assert.ok(new RegExp(`\\.${c}[^{]*:active`).test(css), `${c} active`);
  for (const c of ["settings-tab", "o2s-seg__opt", "o2s-switch"]) assert.ok(new RegExp(`\\.${c}[^{]*:focus-visible \\{ outline: 2px solid var\\(--ring-color\\)`).test(css), `${c} focus`);
});

test("이모지 → 라인 아이콘: o2 만 바꾸고 classic 은 글자 그대로", async () => {
  const { splitLeadEmoji, emojiIconName, EmojiLabel, EmojiIcon, EMOJI_ICONS } = await import("../src/ui/emojiIcon");
  const { ICON_NAMES } = await import("../src/ui/icons");
  for (const n of Object.values(EMOJI_ICONS)) assert.ok(ICON_NAMES.includes(n), `없는 아이콘 ${n}`);
  assert.deepEqual(splitLeadEmoji("🔄 새로고침"), { emoji: "🔄", rest: "새로고침" });
  assert.deepEqual(splitLeadEmoji("🛡️ SafeMode"), { emoji: "🛡️", rest: "SafeMode" });
  assert.deepEqual(splitLeadEmoji("✓ 완료"), { emoji: null, rest: "✓ 완료" }, "✓ 같은 글자 기호는 그대로");
  assert.equal(emojiIconName("💾"), "save");
  assert.equal(emojiIconName("⚠️"), "alert");
  store.set("kda_ui_layout", "classic");
  assert.equal(renderToStaticMarkup(createElement(EmojiLabel, null, "💾 지금 백업하기")), "💾 지금 백업하기");
  assert.equal(renderToStaticMarkup(createElement(EmojiIcon, { e: "📁" })), "📁");
  store.set("kda_ui_layout", "o2");
  const o2Label = renderToStaticMarkup(createElement(EmojiLabel, null, "💾 지금 백업하기"));
  assert.match(o2Label, /^<svg[^>]*class="ui-icon o2-emo"[\s\S]*<\/svg>지금 백업하기$/);
  assert.match(renderToStaticMarkup(createElement(EmojiLabel, null, "🟢 끔")), /^<span class="o2-dot o2-dot--ok" aria-hidden="true"><\/span>끔$/);
  assert.match(renderToStaticMarkup(createElement(EmojiIcon, { e: "🐳", fallback: "plug" })), /^<svg/, "모르는 이모지는 fallback 아이콘");
  // 설정의 남은 이모지 자리를 감쌌다 (버튼·상태 상자·카탈로그 아이콘)
  assert.ok((settings.match(/<EmojiLabel>/g) ?? []).length >= 70, `EmojiLabel ${(settings.match(/<EmojiLabel>/g) ?? []).length}`);
  for (const t of ["💾 지금 백업하기", "📤 대화 내보내기", "🔄 새로고침", "📖 문서", "🛡️ SafeMode"]) assert.ok(settings.includes(t), `classic 문구 유지: ${t}`);
  assert.match(settings, /<EmojiIcon e=\{entry\.icon\} fallback="plug" \/>/);
  assert.match(settings, /<EmojiIcon e=\{provider\.icon\} fallback="cpu" noDot \/>/);
});

test("명령 팔레트 — o2: 라인 아이콘·범위 칩(Tab)·검색어 강조·키캡, classic: 예전 그대로", async () => {
  assert.match(palette, /const SCOPES: Array<\[PaletteScope, string\]> = \[\["all", "전체"\], \["action", "동작"\], \["conversation", "대화"\], \["settings", "설정"\]\];/);
  assert.match(palette, /case "Tab":\n\s+\/\/ o2: Tab \/ Shift\+Tab 으로 범위 칩 이동 \(classic 은 기본 동작\)\n\s+if \(!isO2\) break;/);
  assert.match(palette, /return isO2 \? all\.filter\(\(c\) => inScope\(scope, c\)\) : all;/);
  const P = (await import("../src/components/CommandPalette")).default;
  const props = { open: true, onClose() {}, onSendMessage() {}, onOpenSettings() {}, onNewChat() {}, onSessionRefresh() {}, onSelectConversation() {},
    conversations: [{ id: "a", title: "보고서 정리", lastActive: Date.UTC(2026, 10, 9), messageCount: 2 }], panels: ["session"] } as any;
  store.set("kda_ui_layout", "o2");
  const o2Html = renderToStaticMarkup(createElement(P, props));
  assert.match(o2Html, /class="command-palette-scopes" role="tablist" aria-label="검색 범위"/);
  assert.match(o2Html, /<kbd class="o2-kbd">Ctrl<\/kbd><kbd class="o2-kbd">Alt<\/kbd><kbd class="o2-kbd">A<\/kbd>/);
  assert.match(o2Html, /class="command-item-crumb">일반<svg/, "설정 항목은 '그룹 › 섹션'");
  assert.match(o2Html, /class="command-item-meta">11월 9일</);
  assert.doesNotMatch(o2Html, /💬|📦|⚙️|🔧|🎨|🛡️/, "o2 팔레트에 이모지 없음");
  for (const g of ["동작", "빠른 요청", "대화 이동", "설정"]) assert.ok(o2Html.includes(`>${g}</div>`), g);
  store.set("kda_ui_layout", "classic");
  const classic = renderToStaticMarkup(createElement(P, props));
  assert.ok(classic.includes(">⌘</span>") && classic.includes("ESC") && classic.includes("💬"), "classic 은 ⌘ · ESC · 이모지 그대로");
  assert.ok(!classic.includes("command-palette-scopes") && !classic.includes("o2-kbd"));
});

test("⋯ 메뉴 — o2: 아이콘 · 상태 배지 · 키캡 · 구분선 · '패널' 머리 (classic 분기 그대로)", () => {
  const menu = chat.slice(chat.indexOf('<div className="chat-options-body">'), chat.indexOf("</details>", chat.indexOf('<div className="chat-options-body">')));
  assert.match(menu, /<span className="o2-keys"><kbd className="o2-kbd">Ctrl<\/kbd><kbd className="o2-kbd">Alt<\/kbd><kbd className="o2-kbd">A<\/kbd><\/span>/);
  assert.match(menu, /\{isO2 && \(onOpenPreview \|\| onOpenSession\) && <><div className="chat-options-sep" role="separator" \/><div className="chat-options-label">패널<\/div><\/>\}/);
  assert.match(menu, /\{isO2 && <Icon name=\{MENU_ICONS\[menuText\(label\)\] \?\? "chevronRight"\} \/>\}/);
  assert.match(menu, /\{isO2 \? menuText\(label\) : label\}/, "classic 라벨(이모지 포함) 그대로");
  assert.match(css, /\.chat-options-body \{ width: 288px; padding: 6px; gap: 0; \}/);
});

// ── 대비 (WCAG, 기본 색 테마) ──
const tokenBlock = indexCss.slice(indexCss.indexOf("/* dzA — 승인 목업 v2.1 값"));
const hex = (name: string) => { const m = tokenBlock.match(new RegExp(`--${name}: (#[0-9a-f]{6})`)); assert.ok(m, name); return m![1]; };
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (top: number[], a: number, base: number[]) => top.map((c, i) => Math.round(c * a + base[i] * (1 - a)));
const lum = (c: number[]) => { const l = c.map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; };
const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export const CONTRAST_PAIRS = () => {
  const panel = rgb(hex("o2-panel")), overlay = rgb(hex("o2-overlay")), bg = rgb(hex("o2-bg")), raised = rgb(hex("o2-raised"));
  const white = [255, 255, 255], cyan = [79, 232, 225], warn = [242, 169, 59], danger = [240, 96, 93];
  return {
    "설정 설명 fg-3 / panel": ratio(rgb(hex("o2-fg-3")), panel),
    "팔레트 그룹 머리·힌트 fg-3 / overlay": ratio(rgb(hex("o2-fg-3")), overlay),
    // 선택 줄 위 fg-3 은 3.5:1 → 힌트·메타·키캡을 fg-2 로 올렸다 (o2-polish.css §7)
    "팔레트 선택 줄 힌트·키캡 fg-2 / 시안 13%+overlay": ratio(rgb(hex("o2-fg-2")), mix(cyan, 0.13, overlay)),
    "nav 선택 줄 섹션 수 fg-3 / 시안 8.5%+panel": ratio(rgb(hex("o2-fg-3")), mix(cyan, 0.085, panel)),
    "팔레트 강조 글자 accent-text / 시안 13%+overlay": ratio(rgb("#7cece7"), mix(cyan, 0.13, overlay)),
    "키캡(설정) fg-3 / 흰 4%+panel": ratio(rgb(hex("o2-fg-3")), mix(white, 0.04, panel)),
    // overlay 위 fg-3 키캡은 4.24:1 → 팔레트·⋯ 메뉴 안 키캡은 fg-2
    "키캡(팔레트·메뉴) fg-2 / 흰 4%+overlay": ratio(rgb(hex("o2-fg-2")), mix(white, 0.04, overlay)),
    "범위 칩 fg-2 / overlay": ratio(rgb(hex("o2-fg-2")), overlay),
    "nav 선택 fg-1 / 시안 8.5%+panel": ratio(rgb(hex("o2-fg-1")), mix(cyan, 0.085, panel)),
    "nav 글자 fg-2 / panel": ratio(rgb(hex("o2-fg-2")), panel),
    "세그먼트 선택 fg-1 / overlay": ratio(rgb(hex("o2-fg-1")), overlay),
    "세그먼트 미선택 fg-3 / bg": ratio(rgb(hex("o2-fg-3")), bg),
    "차단 선택 danger-text / overlay": ratio(rgb("#f59a97"), overlay),
    "위험도 보통 warn-text / 주황 9%+panel": ratio(rgb("#f5c478"), mix(warn, 0.09, panel)),
    "위험도 높음 danger-text / 빨강 9%+panel": ratio(rgb("#f59a97"), mix(danger, 0.09, panel)),
    "흐름 묻기 info / panel": ratio(rgb("#86adff"), panel),
    "오류 상자 danger-text / 빨강 9%+bg": ratio(rgb("#f59a97"), mix(danger, 0.09, bg)),
    "비활성 기본 버튼 fg-3 / raised (F)": ratio(rgb(hex("o2-fg-3")), raised),
    "⋯ 메뉴 '패널' 머리 fg-3 / overlay": ratio(rgb(hex("o2-fg-3")), overlay),
    "잠긴 도구 칩 fg-2 / panel": ratio(rgb(hex("o2-fg-2")), panel),
  };
};
test("대비 — 읽는 글자(설명·힌트·키캡·태그·선택 줄)는 모두 4.5:1 이상", () => {
  assert.match(css, /:is\(\.command-palette, \.chat-options-body\) kbd\.o2-kbd \{ color: var\(--o2-fg-2\); \}/);
  assert.match(css, /\.command-palette-item\.selected :is\(\.command-item-hint, \.command-item-meta, kbd\.o2-kbd\) \{ color: var\(--o2-fg-2\); \}/);
  for (const [name, r] of Object.entries(CONTRAST_PAIRS())) {
    assert.ok(r >= 4.5, `${name} = ${r.toFixed(2)}`);
    if (process.env.KDA_PRINT_CONTRAST) console.log(`${name}	${r.toFixed(2)}`);
  }
});
