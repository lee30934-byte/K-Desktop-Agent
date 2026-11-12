// v0.7.86 이후 여백·글자 다듬기 spA — 메인 화면 · 우측 슬라이드오버 (o2 전용).
// ① Pretendard Variable 을 로컬 번들(동적 서브셋, font-display: swap, 네트워크 없음)하고 o2 글꼴 맨 앞에 둔다.
// ② o2 글자 크기·높이·폭 토큰을 한 단계 키우고, 대화 열을 본문 폭의 74%(720~1040)로 넓힌다.
// ③ 알림 띠·입력창은 메시지 글자 열과 같은 폭. ④ classic 은 토큰·글꼴·사이드바 폭 모두 예전 그대로.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const pkg = JSON.parse(read("../package.json"));
const main = read("../src/main.tsx");
const app = read("../src/App.tsx");
const indexCss = read("../src/index.css");
const spacing = read("../src/styles/o2-spacing.css");
const fidelity = read("../src/styles/o2-fidelity.css");
const fontCss = read("../node_modules/pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css");

/** index.css 에서 '의미 토큰 레이어' 의 첫 :root { ... } 블록 (classic 과 o2 가 같이 받는 기본값) */
function baseTokenBlock(): string {
  const at = indexCss.indexOf("UI 개편 1단계 — 의미 토큰 레이어");
  assert.ok(at > 0, "의미 토큰 레이어 블록이 있어야 함");
  const start = indexCss.indexOf(":root {", at);
  return indexCss.slice(start, indexCss.indexOf("\n}", start)).replace(/\/\*[\s\S]*?\*\//g, "");
}

test("Pretendard Variable — 로컬 번들(동적 서브셋 · swap), CDN 없음, OFL 의존성", () => {
  assert.match(pkg.dependencies.pretendard, /^\^1\.3\./);
  assert.match(main, /import "pretendard\/dist\/web\/variable\/pretendardvariable-dynamic-subset\.css";\nimport "\.\/index\.css";/);
  assert.match(fontCss, /font-family: 'Pretendard Variable';/);
  assert.match(fontCss, /font-display: swap;/);
  assert.match(fontCss, /url\(\.\/woff2-dynamic-subset\/PretendardVariable\.subset\.0\.woff2\)/);
  assert.doesNotMatch(fontCss, /url\(["']?https?:/, "글꼴은 네트워크에서 받지 않는다");
  assert.match(fontCss, /SIL Open Font License, Version 1\.1/);
});

test("classic — 기본 토큰은 예전 값 그대로, 기본 글꼴 묶음에 Pretendard 없음 (번들돼도 classic 은 안 씀)", () => {
  const base = baseTokenBlock();
  assert.match(base, /--font-ui: var\(--font-body\), "Malgun Gothic", system-ui, sans-serif;/);
  assert.doesNotMatch(base, /Pretendard/);
  for (const t of [
    "--fs-caption: 12px; --fs-sub: 13px; --fs-ui: 14px; --fs-body: 15px;",
    "--fs-title: 17px; --fs-page: 22px; --fs-hero: 28px;",
    "--lh-body: 1.65;",
    "--header-h: 48px; --row-h: 32px; --rail-w: 56px;",
    "--sidebar-w: 264px; --slideover-w: 380px; --settings-nav-w: 232px;",
    "--chat-max-width: 760px;",
  ]) assert.ok(base.includes(t), `classic 토큰 유지: ${t}`);
  assert.match(indexCss, /^:root\[data-density="compact"\] \{ --row-h: 28px; --fs-body: 14px; \}$/m);
  // Pretendard 라는 이름은 o2 블록 안에서만
  const noComments = indexCss.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const line of noComments.split("\n").filter((l) => l.includes("Pretendard"))) {
    assert.match(line, /--font-(ui|body): /, `Pretendard 를 쓰는 줄은 o2 글꼴 토큰뿐: ${line.trim()}`);
  }
});

test("o2 — 글자 크기·높이·폭 토큰 (spA 값)", () => {
  const at = indexCss.indexOf("spA — o2 여백·글자 다듬기");
  assert.ok(at > 0);
  const block = indexCss.slice(indexCss.indexOf(':root[data-layout="o2"] {', at), indexCss.indexOf("\n}", at));
  assert.match(block, /--font-ui: var\(--font-body\), "Pretendard Variable", "Pretendard", "Malgun Gothic", system-ui, sans-serif;/);
  assert.ok(block.includes("--fs-caption: 12.5px; --fs-sub: 13.5px; --fs-ui: 14.5px; --fs-body: 16px;"));
  assert.ok(block.includes("--fs-title: 18px; --fs-page: 26px; --fs-hero: 30px; --fs-mono: 13.5px;"));
  assert.ok(block.includes("--lh-body: 1.75;"));
  assert.ok(block.includes("--header-h: 60px; --row-h: 38px;"));
  assert.ok(block.includes("--sidebar-w: 280px; --slideover-w: 420px; --settings-nav-w: 264px;"));
  // 대화 열: 본문 폭(창 − 사이드바 − 열린 패널)의 74%, 720~1040. 메시지 열과 입력창이 같은 값을 얻도록 % 가 아닌 vw
  assert.ok(block.includes("--o2-main-w: calc(100vw - var(--sidebar-width, 280px) - var(--slideover-offset, 0px));"));
  assert.ok(block.includes("--chat-max-width: clamp(720px, calc(var(--o2-main-w) * 0.74), 1040px);"));
  assert.match(indexCss, /:root\[data-layout="o2"\]\[data-chat-width="narrow"\] \{ --chat-max-width: 760px; \}/);
  assert.match(indexCss, /:root\[data-layout="o2"\]\[data-chat-width="wide"\] \{ --chat-max-width: min\(1200px, /);
  assert.match(indexCss, /@media \(max-width: 1000px\) \{ :root\[data-layout="o2"\] \{ --o2-gutter: 24px; \} \}/);
  // 기본 o2 색 테마 글꼴은 Pretendard 맨 앞 (fidelity 10단계 값 유지)
  assert.match(indexCss, /--font-body: "Pretendard Variable", "Pretendard", "Inter", "Malgun Gothic", system-ui, sans-serif;/);
});

test("o2-spacing.css — 모든 규칙이 o2 아래, App 에서 마지막에 불러옴", () => {
  const body = spacing.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line === "}" || line.startsWith("@media") || !/[{,]$/.test(line) && !line.includes("{")) continue;
    if (/^[\w-]+\s*:/.test(line)) continue; // 선언 줄
    assert.match(line, /^:root\[data-layout="o2"\]/, `o2 밖 규칙: ${line}`);
  }
  assert.match(app, /import "\.\/styles\/o2-settings\.css";\nimport "\.\/styles\/o2-spacing\.css";/);
});

test("메인 화면 — 글자 열·알림 띠·입력창 같은 폭, 턴 간격 28, 표 10/14, 코드 14/16, 입력창 16px · 전송 36", () => {
  assert.match(spacing, /:root\[data-layout="o2"\] \.chat-col \{ padding: 0 var\(--o2-gutter\); \}/);
  assert.match(spacing, /--o2-col-inset: max\(var\(--o2-gutter\), calc\(\(100% - var\(--o2-col-reserve\) - var\(--chat-max-width\)\) \/ 2 \+ var\(--o2-gutter\)\)\);/);
  assert.match(spacing, /margin: 14px calc\(var\(--o2-col-inset\) \+ var\(--o2-col-reserve\)\) 0 var\(--o2-col-inset\);/);
  assert.match(spacing, /\.composer-wrapper \{\n  margin-bottom: 22px;\n  padding: 0 var\(--o2-col-inset\);/);
  assert.match(spacing, /\.chat-col > \.msg-user \{ margin: 4px 0 28px;/);
  assert.match(spacing, /\.chat-col > \.msg-assistant \{ margin: 0 0 28px; \}/);
  assert.match(spacing, /\.markdown-content p \{ margin: 0 0 0\.85em; \}/);
  assert.match(spacing, /\.markdown-content th \{ padding: 10px 14px; \}/);
  assert.match(spacing, /\.markdown-content td \{ padding: 10px 14px;/);
  assert.match(spacing, /\.md-code-block \{\n  padding: 14px 16px; font-size: var\(--fs-mono\);/);
  assert.match(spacing, /\.composer textarea \{ min-height: 52px;[^}]*font-size: var\(--fs-body\);/);
  assert.match(spacing, /\.composer-btn-send--icon \{ width: 36px; height: 36px; \}/);
  assert.match(spacing, /\.main-header \{ gap: 14px; padding: 0 22px 0 28px; \}/);
});

test("사이드바 280 (o2 전용 저장 키) · 슬라이드오버 420 — classic 은 예전 키·기본값 그대로", () => {
  assert.match(app, /const classic = readSidebarWidth\("kda_sidebar_width", 260\);/);
  assert.match(app, /o2: readSidebarWidth\("kda_sidebar_width_o2", Math\.max\(280, classic\)\)/);
  assert.match(app, /const sidebarWidth = isO2 \? sidebarWidths\.o2 : sidebarWidths\.classic;/);
  assert.match(app, /const O2_SLIDEOVER_MIN = 420;/);
  assert.match(app, /const slideOverW = isO2 \? Math\.max\(O2_SLIDEOVER_MIN, slideOverWidth\) : slideOverWidth;/);
  assert.match(app, /width=\{slideOverW\}\n\s+onResize=\{setSlideOverWidth\}\n\s+minWidth=\{O2_SLIDEOVER_MIN\}\n\s+defaultWidth=\{O2_SLIDEOVER_MIN\}/);
  // 저장 값(classic SidePanel 과 공유하는 kda_side_panel_width)은 바꾸지 않는다 — 기본 380 그대로
  assert.match(app, /if \(!Number\.isNaN\(saved\)\) return Math\.max\(360, Math\.min\(640, saved\)\);\n\s+\} catch \{\}\n\s+return 380;/);
  assert.match(spacing, /\.right-slideover \.ui-tab \{ height: 44px;/);
  assert.match(spacing, /\.companion-popover\.is-hosted \{ padding: 20px; \}/);
});

test("비서 아바타 기본 위치 규칙은 그대로 (헤더·알림 띠 아래, 패널 열리면 숨김) — spA 파일은 아바타를 건드리지 않음", () => {
  assert.match(fidelity, /top: calc\(var\(--o2-chrome-bottom, 100px\) \+ 12px\);/);
  assert.match(fidelity, /:root\[data-layout="o2"\]\[data-slideover\] \.companion-widget:not\(\[style\*="left"\]\) \{ display: none; \}/);
  assert.doesNotMatch(spacing, /companion-widget/);
});
