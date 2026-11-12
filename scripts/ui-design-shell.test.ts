// dzA 디자인 고도화 1단계 회귀 테스트 — 토큰 · 상호작용 상태 · 메인 셸 (기준: evidence/ui-redesign-20261111/mockup-v2/mockup-v2.1.html, K 승인 + 추천 A~F).
// o2: 목업 v2.1 토큰(표면 4 · 선 3 · 글자 4 · 반경 6/10/14/pill · 떠 있는 레이어 전용 그림자 · 2px 포커스 링 · 120~180ms 움직임),
//     사이드바 고정됨/폴더/최근 + 줄 동작, 헤더 중복 정리, 무채색 알림 띠, 입력창 실행 확인 칩, 컨텍스트 80/90 경계.
// classic: src/styles/o2-design.css 를 받지 않고 :root 토큰·예전 구조 그대로.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = read("../src/styles/o2-design.css");
const indexCss = read("../src/index.css");
const app = read("../src/App.tsx");
const sidebar = read("../src/components/Sidebar.tsx");
const chat = read("../src/components/MainChat.tsx");
const composer = read("../src/components/Composer.tsx");
const safety = read("../src/components/SafetyChip.tsx");
const ring = read("../src/components/ContextRing.tsx");
const panel = read("../src/components/SessionUsagePanel.tsx");

const O2_DEFAULT = ':root[data-layout="o2"]:not([data-theme="terminal-phosphor"], [data-theme="glass-acrylic"], [data-theme="brutalist-bauhaus"])';
const block = (src: string, sel: string) => {
  const at = src.indexOf(`${sel} {`);
  assert.ok(at >= 0, `${sel} 블록 없음`);
  return src.slice(at, src.indexOf("\n}", at));
};
/** 주석을 지운 CSS 규칙 [선택자, 본문] (@media 안쪽도 펼침) */
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
  const parts: string[] = []; let depth = 0, cur = "";
  for (const ch of sel) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; } else cur += ch; }
  return [...parts, cur.trim()].filter(Boolean);
};
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("o2-design.css — 모든 선택자가 o2 한정, 맨 마지막에 불러옴 (classic 은 받지 않음)", () => {
  const all = rules(css);
  assert.ok(all.length > 150, `규칙 수 ${all.length}`);
  for (const [sel] of all) for (const part of splitSel(sel)) {
    assert.ok(part.startsWith(':root[data-layout="o2"]'), `o2 밖 선택자: ${part}`);
  }
  const imports = [...app.matchAll(/^import "\.\/styles\/(o2-[a-z-]+)\.css";/gm)].map((m) => m[1]);
  assert.deepEqual(imports.slice(-2), ["o2-spacing-settings", "o2-design"]);
  assert.doesNotMatch(css, /companion-widget/, "아바타 위치 규칙은 건드리지 않는다");
});

test("토큰 — 목업 v2.1 값(기본 색 테마)과 개성 테마용 기본값, 반경·그림자·링·움직임", () => {
  const d = block(indexCss, O2_DEFAULT);
  for (const v of ["--bg-1: #0b0c10;", "--bg-2: #101217;", "--bg-3: #161920;", "--bg-4: #1c2029;",
    "--o2-bg: #0b0c10;", "--o2-panel: #101217;", "--o2-raised: #161920;", "--o2-overlay: #1c2029;",
    "--o2-line-1: rgba(255, 255, 255, 0.06);", "--o2-line-2: rgba(255, 255, 255, 0.10);", "--o2-line-3: rgba(255, 255, 255, 0.16);",
    "--o2-fg-1: #eceef2;", "--o2-fg-body: #d9dce2;", "--o2-fg-2: #a6adb9;", "--o2-fg-3: #838b99;", "--o2-fg-4: #4b515d;",
    "--warn: #f2a93b;", "--error: #f0605d;", "--success: #4ade80;", "--info: #86adff;",
    '--font-mono: "Cascadia Code", "Cascadia Mono", Consolas, monospace;']) {
    assert.ok(d.includes(v), v);
  }
  assert.doesNotMatch(d, /JetBrains/, "o2 코드 글꼴은 Cascadia (JetBrains Mono 번들 안 함)");
  const g = block(indexCss.slice(indexCss.indexOf("dzA — o2 디자인 토큰")), ':root[data-layout="o2"]');
  for (const v of ["--o2-bg: var(--surface-app);", "--o2-fg-3: var(--fg-subtle);", "--r-sm: 6px; --r-md: 10px; --r-lg: 14px; --r-pill: 999px;",
    "--shadow-pop:", "--shadow-panel:", "--ring-color: color-mix(in srgb, var(--accent) 65%, transparent);",
    "--dur-fast: 120ms; --dur-pop: 160ms; --dur-slide: 180ms;", "--info-soft:"]) assert.ok(g.includes(v), v);
  assert.match(indexCss, /@media \(prefers-reduced-motion: reduce\) \{ :root\[data-layout="o2"\] \{ --dur-fast: 0ms; --dur-pop: 0ms; --dur-slide: 0ms; \} \}/);
  // classic(:root 기본) 토큰은 예전 값
  assert.match(indexCss, /:root \{\n  \/\* ─── 색상 시스템 ─── \*\/[\s\S]*?--bg-1: #0a0e18;[\s\S]*?--text-tertiary: #5e6780;/);
});

test("대비 — 읽는 글자(fg-1·본문·fg-2·fg-3)는 4표면 모두 4.5:1 이상, fg-4 는 비활성에만", () => {
  const d = block(indexCss, O2_DEFAULT);
  const v = (n: string) => d.match(new RegExp(`--${n}: (#[0-9a-f]{6});`, "i"))![1];
  for (const fg of ["o2-fg-1", "o2-fg-body", "o2-fg-2", "o2-fg-3"]) for (const bg of ["o2-bg", "o2-panel", "o2-raised", "o2-overlay"]) {
    const r = ratio(v(fg), v(bg));
    assert.ok(r >= 4.5, `${fg} on ${bg} = ${r.toFixed(2)}`);
  }
  assert.ok(ratio(v("o2-fg-3"), v("o2-overlay")) >= 4.7, "fg-3 on overlay ≈ 4.75");
  assert.ok(ratio(v("o2-fg-4"), v("o2-bg")) < 3, "fg-4 는 읽는 글자용이 아님");
  for (const [sel, body] of rules(css)) {
    if (/--o2-fg-4/.test(body)) assert.match(sel, /disabled/, `fg-4 를 비활성 아닌 곳에: ${sel}`);
  }
});

test("상태 — 포커스 링 2px+2px, 그림자는 떠 있는 레이어만, 비활성 기본 버튼은 무채색(F)", () => {
  assert.match(css, /:is\(button, a\[href\], summary, select, \[role="tab"\], \[role="switch"\], \[role="menuitem"\], \[role="option"\], \[tabindex\]:not\(\[tabindex="-1"\]\)\):focus-visible \{\n  outline: 2px solid var\(--ring-color\); outline-offset: 2px;/);
  for (const [sel, body] of rules(css)) {
    if (/var\(--shadow-pop\)/.test(body)) assert.match(sel, /popover|ctx-menu|chat-options-body|composer-stop-menu/, `떠 있지 않은 곳에 그림자: ${sel}`);
    if (/var\(--shadow-panel\)/.test(body)) assert.match(sel, /right-slideover/);
  }
  assert.match(css, /\.ui-btn--primary:disabled \{ background: var\(--o2-raised\); border-color: var\(--o2-line-1\); color: var\(--o2-fg-3\); \}/);
  assert.match(css, /\.composer-btn-send:disabled \{\n  background: var\(--o2-raised\); border-color: var\(--o2-line-1\); color: var\(--o2-fg-3\);/);
  // 호버 · 누름 · 선택 · 비활성이 공용 부품마다
  for (const c of ["ui-btn", "ui-iconbtn", "ui-chip", "ui-seg__opt", "ui-switch", "sb-nav-item", "explorer-item", "ctx-item"]) {
    assert.ok(new RegExp(`\\.${c}[^{]*:hover`).test(css), `${c} hover`);
  }
  for (const c of ["ui-btn", "ui-iconbtn", "sb-nav-item", "explorer-item", "ctx-item", "composer-btn-send"]) assert.ok(new RegExp(`\\.${c}[^{]*:active`).test(css), `${c} active`);
  assert.match(css, /\.ui-chip\[aria-pressed="true"\] \{ background: var\(--o2-sel\); border-color: var\(--o2-accent-line\);/);
  assert.match(css, /\.sb-tree \.explorer-item\.active,\n:root\[data-layout="o2"\] \.sb-tree \.explorer-item\.selected \{ background: var\(--o2-sel\);/);
  assert.match(css, /\.ui-seg__opt--on \{ background: var\(--o2-overlay\);/);
  assert.match(css, /scrollbar-width: thin; scrollbar-color: transparent transparent;/);
  assert.match(css, /@keyframes o2-pop \{/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  :root\[data-layout="o2"\] :is\(\.ui-popover/);
});

test("사이드바 (E) — 고정됨 · 폴더(도구) · 최근, 줄 동작은 기존 핸들러, 라인 아이콘", () => {
  assert.match(sidebar, /<span className="eyebrow section-label">폴더<\/span>/);
  assert.match(sidebar, /\{isO2 \? null : \(\n\s+<div className="eyebrow section-label">/, "따로 떨어진 '대화' 머리 없음");
  const acts = sidebar.slice(sidebar.indexOf("const renderConvActions = "), sidebar.indexOf("const renderExplorerItem = "));
  assert.match(acts, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); void onToggleFavorite\(c\.id\); \}\}/);
  assert.match(acts, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); startEditConv\(c\.id, c\.title\); \}\}/);
  assert.match(acts, /\{renderRowMore\("conversation", c\.id\)\}/);
  assert.match(css, /\.sb-tree \.explorer-item:is\(:hover, :focus-within\) \.explorer-acts \{ display: flex; \}/);
  // 대화·폴더 아이콘: 흔한 이모지는 라인 아이콘, classic 은 예전 이모지 그대로
  assert.match(sidebar, /\{isO2 \? o2Glyph\(c\.icon, "msg"\) : c\.isFavorite \? "★" : c\.icon \?\? "💬"\}/);
  assert.match(sidebar, /\{isO2 \? o2Glyph\(f\.icon, "folder"\) : f\.icon \?\? "📁"\}/);
  assert.match(sidebar, /\{isO2 \? o2MenuLabel\(it\.label\) : it\.label\}/, "우클릭 메뉴: o2 만 라인 아이콘");
  assert.match(sidebar, /"📊": "sheet"/);
  // 브랜드 줄 접기 버튼 = 같은 onToggleRail
  assert.match(sidebar, /<button type="button" className="sb-collapse" onClick=\{onToggleRail\}/);
  // classic 탐색기는 무수정
  const classic = sidebar.slice(sidebar.indexOf("const renderExplorer = "), sidebar.indexOf("const renderO2Explorer = "));
  assert.doesNotMatch(classic, /isO2|o2Glyph/);
});

test("헤더 중복 정리 (A·B) — 안전 칩은 주의 상태만, 작업 칩은 사이드바 배지로", () => {
  assert.match(safety, /if \(hideWhenSafe && !enabled && !open\) return null;/);
  assert.match(chat, /\{isO2 && <SafetyChip onOpenSettings=\{onOpenSafetySettings\} hideWhenSafe \/>\}/);
  assert.match(chat, /modeSlot=\{isO2 \? <SafetyChip onOpenSettings=\{onOpenSafetySettings\} variant="composer" \/> : undefined\}/);
  assert.match(composer, /\{modeSlot && <div className="composer-mode">\{modeSlot\}<\/div>\}/);
  assert.match(app, /\{!isO2 && <TaskActivityPanel \{\.\.\.taskPanelProps\} mode="popover" \/>\}/);
  assert.match(app, /taskQueued=\{\[\.\.\.conversationTurnGateRef\.current\.queues\.values\(\)\]\.reduce\(\(n, q\) => n \+ q\.length, 0\)\}/);
  assert.match(app, /onOpenTasks=\{isO2 \? \(\) => toggleRightPanel\("tasks"\) : undefined\}/);
  // classic 헤더는 예전 ApprovalToggle 그대로
  assert.match(chat, /\{!isO2 && <ApprovalToggle \/>\}/);
});

test("컨텍스트 경계 (D) — 80 미만 무채색 · 80~89 주황 · 90+ 빨강, 줄·배지·추천은 80% 부터", () => {
  assert.match(ring, /if \(overflowed \|\| pct >= 90\) return "danger";\n  if \(pct >= 80\) return "warn";\n  return "ok";/);
  assert.match(ring, /const high = u\.contextUsage >= 80;/);
  assert.match(panel, /const pctTone = u\.contextOverflowed \|\| u\.contextUsage >= 90 \? "danger" : u\.contextUsage >= 80 \? "warn" : "neutral";/);
  assert.match(panel, /const recommendRefresh = u\.contextUsage >= 80 \|\| u\.contextOverflowed;/);
  assert.match(css, /\.composer \.context-ring-btn--ok \.ui-ring__bar \{ stroke: var\(--o2-fg-3\); \}/);
  assert.match(css, /\.so-tone--neutral \{ color: var\(--o2-fg-1\); \}/);
  assert.match(css, /\.so-meter--neutral i \{ background: var\(--o2-fg-3\); \}/);
});

test("알림 띠 · 읽기 폭 · 슬라이드오버 (v2.1 · C) — 무채색 띠, 위 끝 흐림, 글 840, 개발자 문구 없음", () => {
  assert.match(css, /\.chat-notices--top \.ui-notice\.task-watch-waiting--o2 \{\n  min-height: 44px;[^}]*background: var\(--o2-raised\); border: 1px solid var\(--o2-line-2\);/);
  assert.match(css, /\.task-watch-waiting--o2 \.task-watch-line > \.ui-icon \{ color: var\(--o2-accent-text\); \}/);
  assert.match(css, /mask-image: linear-gradient\(transparent 0, #000 36px\);/);
  assert.match(css, /\.markdown-content > :is\(p, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, hr, dl\) \{ max-width: 840px; \}/);
  assert.match(css, /\.right-slideover\.ui-slideover \{\n  top: 0; background: var\(--o2-panel\); border-left: 0; box-shadow: var\(--shadow-panel\);/);
  assert.doesNotMatch(app, /폭 420~640 조절/);
  assert.match(app, /<kbd className="o2-kbd">Esc<\/kbd>닫기/);
});
