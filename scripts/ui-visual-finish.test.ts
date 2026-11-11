// v0.7.86 UI 개편 10단계 — 비주얼 마감 회귀 테스트 (evidence/ui-redesign-20261111/design-spec.md 7장, 8장 10단계).
// o2: 크롬 이모지 → 단색 라인 아이콘(src/ui/icons.tsx), 무채색 서피스·글로우 없음·L자 장식 숨김(기본 색 테마만), 대비 4.5:1.
// classic: 예전 이모지·L자 장식·글로우 그대로. 개성 테마 3종은 o2 에서도 자기 규칙 유지.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const sidebar = read("../src/components/Sidebar.tsx");
const chat = read("../src/components/MainChat.tsx");
const composer = read("../src/components/Composer.tsx");
const safety = read("../src/components/SafetyChip.tsx");
const app = read("../src/App.tsx");
const indexCss = read("../src/index.css");
const appCss = read("../src/App.css");
const pkg = JSON.parse(read("../package.json"));

const O2_DEFAULT = ':root[data-layout="o2"]:not([data-theme="terminal-phosphor"], [data-theme="glass-acrylic"], [data-theme="brutalist-bauhaus"])';

function fnBody(src: string, name: string) {
  const start = src.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `${name} 없음`);
  const next = src.indexOf("\n  const ", start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

test("Icon — 16px · stroke 1.75 · currentColor · aria-hidden, 모든 이름이 SVG 로 그려짐 (새 의존성 없음)", async () => {
  const { Icon, ICON_NAMES } = await import("../src/ui/icons");
  assert.ok(ICON_NAMES.length >= 20);
  for (const name of ICON_NAMES) {
    const html = renderToStaticMarkup(createElement(Icon, { name }));
    assert.match(html, /^<svg [^>]*width="16" height="16" viewBox="0 0 24 24"/, name);
    assert.match(html, /stroke="currentColor"/);
    assert.match(html, /stroke-width="1.75"/);
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /<(path|circle|rect)/, `${name} 모양 없음`);
  }
  assert.match(renderToStaticMarkup(createElement(Icon, { name: "plus", size: 18 })), /width="18"/);
  assert.equal(pkg.dependencies?.["lucide-react"], undefined, "lucide-react 대신 인라인 SVG 세트를 쓴다");
});

test("o2 사이드바·레일 — 이모지 대신 라인 아이콘, classic 은 예전 이모지 그대로", () => {
  const top = fnBody(sidebar, "renderO2Top");
  const rail = fnBody(sidebar, "renderRail");
  const foot = fnBody(sidebar, "renderO2Foot");
  const sec = fnBody(sidebar, "renderSectionHead");
  for (const [body, names] of [[top, ["plus", "search", "library", "zap"]], [rail, ["plus", "search", "library", "zap", "settings"]],
    [foot, ["settings"]], [sec, ["folderPlus", "checkSquare"]]] as const) {
    for (const n of names) assert.ok(body.includes(`<Icon name="${n}"`), `${n} 아이콘`);
    assert.doesNotMatch(body, /[🔍📚⚡⚙☑]|📁\+/u);
  }
  // classic 블록: 📁+ / 📚 버튼 줄, 🔍 검색창, 💾 백업, ⚙ 환경설정, + 새 대화
  assert.match(sidebar, /<span className="plus">\+<\/span>/);
  assert.match(sidebar, /<span className="plus">📁\+<\/span>/);
  assert.match(sidebar, /placeholder="🔍 제목 \/ 메시지 검색…"/);
  assert.match(sidebar, /<span className="tool-icon">💾<\/span>/);
  assert.match(sidebar, /<span className="tool-icon">⚙<\/span>/);
});

test("o2 헤더·입력창·슬라이드오버 — 라인 아이콘, classic 은 ◐ ⋯ 📎 📄 그대로", () => {
  assert.match(chat, /icon=\{<Icon name="alert" size=\{14\} \/>\}/);
  assert.match(chat, /\{isO2 \? <Icon name="assistant" \/> : "◐"\}/);
  assert.match(chat, /\{isO2 \? <Icon name="more" \/> : "⋯"\}/);
  assert.match(chat, /icon=\{isO2 \? <Icon name="file" size=\{14\} \/> : "📄"\}/);
  assert.match(chat, /\{isO2 \? menuText\(label\) : label\}/);
  assert.match(chat, /copyStatus === "copied" \? "✓ 복사됨" : isO2 \? "복사" : "📋 복사"/);
  assert.doesNotMatch(chat, /empty-hint-o2">[^<]*📎/u);
  assert.match(chat, /💡 파일을 드래그하거나 📎 버튼으로 첨부 가능/, "classic 빈 화면 문구 유지");
  assert.match(composer, /\{isO2 \? <Icon name="paperclip" size=\{18\} \/> : "📎"\}/);
  assert.match(composer, /aria-label="보내기"[\s\S]{0,80}<Icon name="arrowUp" \/>/);
  assert.match(composer, /\{!isO2 && <div className="composer-prefix mono">\{">"\}<\/div>\}/, "classic '>' 유지");
  assert.match(safety, /icon=\{<Icon name=\{enabled \? "zap" : "shield"\} size=\{14\} \/>\}/);
  assert.match(app, /onClick=\{\(\) => setSlideOverPinned\(\(p\) => !p\)\}><Icon name="pin" \/><\/button>/);
});

test("메뉴 문구 앞 기호는 o2 에서만 뗀다 (↻ 📦 📤), 다른 문구는 그대로", () => {
  const m = chat.match(/const menuText = \(label: string\) => ([^;]+);/);
  assert.ok(m);
  const menuText = new Function("label", `return ${m![1]};`) as (l: string) => string;
  assert.equal(menuText("↻ 새 세션으로 이어가기"), "새 세션으로 이어가기");
  assert.equal(menuText("📦 요약해서 새 대화로 이어가기"), "요약해서 새 대화로 이어가기");
  assert.equal(menuText("📤 이 대화 내보내기"), "이 대화 내보내기");
  assert.equal(menuText("세션·사용량 보기"), "세션·사용량 보기");
});

test("토큰 — o2 기본 색 테마만: 무채색 서피스, 글로우 투명, L자 장식 숨김, Space Grotesk 대신 UI 글꼴", () => {
  const at = indexCss.indexOf(`${O2_DEFAULT} {`);
  assert.ok(at > 0, "o2 기본 테마 토큰 블록");
  const block = indexCss.slice(at, indexCss.indexOf("}", at));
  assert.match(block, /--accent-glow: transparent !important;/);
  assert.match(block, /--accent-strong-glow: transparent !important;/);
  assert.match(block, /--accent-soft: color-mix\(in srgb, var\(--accent\) 12%, transparent\);/);
  assert.match(block, /--show-corner-brackets: 0;/);
  assert.match(block, /--font-display: var\(--font-body\);/);
  assert.match(indexCss, new RegExp(`${O2_DEFAULT.replace(/[[\]().*+?^$|\\]/g, "\\$&")} \\.eyebrow \\{[^}]*text-transform: none;`));
  // classic(:root 기본) · terminal-phosphor 는 예전대로 L자 장식 보임
  assert.match(indexCss, /:root \{\n  \/\* 데코 토글[^\n]*\n  --show-corner-brackets: 1;/);
  assert.match(indexCss, /:root\[data-theme="terminal-phosphor"\] \{[^}]*--show-corner-brackets: 1;/);
  assert.match(indexCss, /--accent-glow: rgba\(79, 232, 225, 0\.15\);/, "classic 글로우 토큰 유지");
  // 하드코딩 글로우 정리도 기본 색 테마 o2 로만 한정
  assert.ok(appCss.includes(`${O2_DEFAULT} .new-chat-btn {`));
  assert.ok(appCss.includes(`${O2_DEFAULT} .status-dot-live,`));
  assert.match(appCss, /\.new-chat-btn:hover \{\n  background: linear-gradient\(/, "classic 새 대화 버튼 그라데이션 유지");
  // classic 이 쓰는 L자 장식 컴포넌트는 지우지 않는다
  for (const src of [sidebar, chat, read("../src/components/MetricsPanel.tsx")]) assert.match(src, /<CornerBrackets /);
});

test("대비 — o2 기본 테마 글자색은 모든 서피스(bg-1~bg-4)에서 4.5:1 이상", () => {
  const at = indexCss.indexOf(`${O2_DEFAULT} {`);
  const block = indexCss.slice(at, indexCss.indexOf("}", at));
  const v = (name: string) => {
    const m = block.match(new RegExp(`--${name}: (#[0-9a-f]{6});`, "i"));
    assert.ok(m, `--${name}`);
    return m![1];
  };
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const fg of ["text-primary", "text-secondary", "text-tertiary"]) {
    for (const bg of ["bg-1", "bg-2", "bg-3", "bg-4"]) {
      const r = ratio(v(fg), v(bg));
      assert.ok(r >= 4.5, `${fg} on ${bg} = ${r.toFixed(2)}`);
    }
  }
  assert.ok(ratio("#04201f", "#4fe8e1") >= 4.5, "전송 버튼 글자(accent-fg) on accent");
});

test("960x640 — 낮은 창에서 비서 아바타가 헤더(안전 칩)를 덮지 않음, 좁은 창은 제목 먼저 말줄임", () => {
  assert.match(appCss, /@media \(max-height: 650px\) \{\n  :root\[data-layout="o2"\] \.companion-widget:not\(\[style\*="left"\]\) \{ top: 100px;/);
  assert.match(appCss, /@media \(max-width: 1100px\) \{\n  :root\[data-layout="o2"\] \.main-header \.main-title \{ max-width: 32vw; \}/);
  // 작업 칩은 다른 칩과 같은 모양 (밝은 테마에서 글자가 묻히지 않게)
  assert.match(appCss, /:root\[data-layout="o2"\] \.main-header-right \.task-activity-toggle \{[^}]*background: transparent;/);
});
