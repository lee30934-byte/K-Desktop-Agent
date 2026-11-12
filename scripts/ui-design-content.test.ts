// dzB 디자인 고도화 2단계 회귀 테스트 — 메시지 콘텐츠 부품 (기준: evidence/ui-redesign-20261111/mockup-v2/mockup-v2.1.html ?screen=content · empty).
// o2: 말풍선 r14/14/6/14 · 글 리듬 · 인라인 코드 · 파일 칩(타일+종류) · 표 틀(머리 옅은 판·숫자 고정폭) · 코드 블록(언어+복사·줄 번호) ·
//     도구 카드(상태 원·인자·실패 이유·실행 중 선, 라인 아이콘) · 시스템 카드(오류/주의/안내) · 작성 중 점 3개 · 빈 화면 제안 카드.
// classic: src/styles/o2-content.css 를 받지 않고 Message/MainChat 의 예전 분기(이모지·영문 라벨) 그대로.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = read("../src/styles/o2-content.css");
const indexCss = read("../src/index.css");
const app = read("../src/App.tsx");
const message = read("../src/components/Message.tsx");
const chat = read("../src/components/MainChat.tsx");
const fixtureSrc = read("../src/dev/mockupFixture.ts");

const O2_DEFAULT = ':root[data-layout="o2"]:not([data-theme="terminal-phosphor"], [data-theme="glass-acrylic"], [data-theme="brutalist-bauhaus"])';
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
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (c: number[]) => {
  const l = c.map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
};
const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** 위에 겹친 반투명 색(top, alpha)을 바탕(base)에 섞은 결과 */
const over = (base: number[], top: number[], a: number) => base.map((v, i) => Math.round(top[i] * a + v * (1 - a)));

test("o2-content.css — 모든 선택자가 o2 한정, o2-design 다음 맨 마지막에 불러옴 (classic 은 받지 않음)", () => {
  const all = rules(css);
  assert.ok(all.length > 120, `규칙 수 ${all.length}`);
  for (const [sel] of all) for (const part of splitSel(sel)) {
    assert.ok(part.startsWith(':root[data-layout="o2"]'), `o2 밖 선택자: ${part}`);
  }
  const imports = [...app.matchAll(/^import "\.\/styles\/(o2-[a-z-]+)\.css";/gm)].map((m) => m[1]);
  // dzC — 설정·팔레트·메뉴·대화상자(o2-polish)가 그 뒤 맨 마지막 (scripts/ui-design-polish.test.ts)
  assert.deepEqual(imports.slice(-2), ["o2-content", "o2-polish"]);
  assert.doesNotMatch(css, /companion-widget/, "아바타 위치 규칙은 건드리지 않는다");
});

test("토큰·대비 — fg-4 는 비활성에만, 그림자는 떠 있는 승인 창에만, 콘텐츠 글자는 4.5:1 이상", () => {
  for (const [sel, body] of rules(css)) {
    if (/--o2-fg-4/.test(body)) assert.match(sel, /disabled/, `fg-4 를 비활성 아닌 곳에: ${sel}`);
    if (/--shadow-(pop|panel)/.test(body)) assert.match(sel, /elicitation/, `떠 있지 않은 곳에 그림자: ${sel}`);
    assert.doesNotMatch(body, /(?:box-shadow:\s*|,\s*)(?:inset\s+)?0 0 [1-9]\d*px[^,;]*accent/, `글로우 금지: ${sel}`);
  }
  // 하드코딩 색은 기본 색 테마 블록(목업 값)에서만
  const d = indexCss.slice(indexCss.indexOf(`${O2_DEFAULT} {`));
  const v = (n: string) => rgb(d.match(new RegExp(`--${n}: (#[0-9a-f]{6});`, "i"))![1]);
  const [bg, panel, fg2, fg3] = [v("o2-bg"), v("o2-panel"), v("o2-fg-2"), v("o2-fg-3")];
  const codeBg = rgb(css.match(/--o2-code-bg: (#[0-9a-f]{6});/)![1]);
  const codeFg = rgb(css.match(/--o2-code-fg: (#[0-9a-f]{6});/)![1]);
  const inlineFg = rgb(css.match(/--o2-code-inline-fg: (#[0-9a-f]{6});/)![1]);
  const pairs: [string, number[], number[]][] = [
    ["코드 글자 / 코드 판", codeFg, codeBg],
    ["줄 번호 fg-3 / 코드 판", fg3, codeBg],
    ["인라인 코드 / 본문 위 5.5% 판", inlineFg, over(bg, [255, 255, 255], 0.055)],
    ["표 머리 fg-3 / 2.5% 판", fg3, over(bg, [255, 255, 255], 0.025)],
    ["도구 인자 fg-3 / panel", fg3, panel],
    ["오류 카드 본문 fg-2 / panel+danger 9%", fg2, over(panel, rgb("#f0605d"), 0.09)],
    ["실패 이유 danger-text / panel", rgb("#f59a97"), panel],
  ];
  for (const hex of ["#a9b8ff", "#a6d9a0", "#f0c27e", "#7cece7"]) pairs.push([`구문 ${hex} / 코드 판`, rgb(hex), codeBg]);
  for (const [name, a, b] of pairs) assert.ok(ratio(a, b) >= 4.5, `${name} = ${ratio(a, b).toFixed(2)}`);
  assert.match(css, /\.md-code-lines \{[^}]*color: var\(--o2-fg-3\)/, "줄 번호는 읽히는 fg-3");
  assert.match(css, /\.msg-tool-o2 \.msg-time \{[^}]*opacity: 1;/, "classic .msg-time 의 opacity .4 를 o2 도구 카드에서 되돌림");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  :root\[data-layout="o2"\] :is\(\.chat-col > \.msg,/);
});

test("Message — o2 코드 블록(언어·복사·줄 번호) · 파일 칩 · 표 틀 · 숫자 칸, classic 은 예전 그대로", () => {
  assert.match(message, /<span className="md-code-lang">\{codeLanguage\(children\) \?\? "코드"\}<\/span>/);
  assert.match(message, /<span className="md-code-lines" aria-hidden="true">/);
  assert.match(message, /<Icon name=\{copied \? "check" : "copy"\} size=\{14\} \/>\n\s+\{copied \? "복사됨" : "복사"\}/);
  assert.match(message, /\{copied \? "✓ 복사됨" : "📋 복사"\}/, "classic 코드 복사 버튼 문구 유지");
  assert.match(message, /<span className="md-file-chip__tile" aria-hidden="true"><Icon name="file" size=\{18\} \/><\/span>/);
  assert.match(message, /<Icon name="eye" className="md-file-chip__go" \/>/);
  assert.match(message, /isO2 \? <div className="md-table-wrap"><table>\{children\}<\/table><\/div> : <table>\{children\}<\/table>/);
  assert.match(message, /<td style=\{style\} className="is-num">/);
  // 이모지 → 라인 아이콘 (o2 만)
  assert.match(message, /\{isO2 \? <Icon name="image" size=\{14\} \/> : "🖼️"\}/);
  assert.match(message, /\{isO2 \? <Icon name=\{o2AttachmentIcon\(att\.type\)\} size=\{18\} \/> : getAttachmentIcon\(att\.type\)\}/);
  assert.match(message, /\{isO2 \? "클릭하면 원본" : "🔍 클릭 = 원본"\}/);
  assert.match(message, /\{isO2 \? <Icon name="camera" size=\{13\} \/> : "📷"\}/);
});

test("Message — o2 도구 카드(상태 원 · 인자 · 실패 이유 · 실행 중 선)와 시스템 카드, classic 도구 카드 무수정", async () => {
  const o2Tool = message.slice(message.indexOf("  if (isO2) {\n    const args = toolArgsPreview(shownInput);"), message.indexOf("  // 이미지 없는 일반 케이스: 기존 도구 카드"));
  assert.ok(o2Tool.length > 500);
  assert.match(o2Tool, /<Icon name=\{displayStatus === "pending" \? "loader" : displayStatus === "error" \? "x" : "check"\}/);
  assert.match(o2Tool, /className=\{`msg-tool-compact msg-tool-\$\{message\.status\}`\}/, "기존 className 유지");
  assert.match(o2Tool, /onFilterToggle\("risk", message\.risk\.level\)/);
  assert.match(o2Tool, /onFilterToggle\("category", message\.risk\.categoryId\)/);
  assert.match(o2Tool, /<div className="msg-tool-why"><Icon name="alertCircle" size=\{14\} \/>\{why\}<\/div>/);
  assert.match(o2Tool, /<div className="msg-tool-runbar" aria-hidden="true" \/>/);
  assert.match(o2Tool, /msg-tool-load-full/, "잘린 원문 '전체 불러오기' 유지");
  assert.doesNotMatch(o2Tool, /[🟢🟡🟠🔴📁📋]/u, "o2 도구 카드에 이모지 없음");
  // classic 카드: 영문 상태 라벨·이모지 분류 그대로
  assert.match(message, /\{outcome\.observationWarning \? "완료 · 화면 읽기 실패" : statusLabel\(displayStatus\)\}/);
  assert.match(message, /📁 \{message\.risk\.categoryId\}/);
  assert.match(message, /case "pending":\n\s+return "RUNNING";/);
  // 시스템 카드
  assert.match(message, /if \(isO2 && message\.role === "system"\) \{/);
  assert.match(message, /className=\{`msg msg-system msg-system--\$\{level\}`\} role=\{level === "error" \? "alert" : "status"\}/);
  assert.match(message, /\{level === "error" && <div className="msg-system__title">문제가 생겼어요<\/div>\}/);
  const { ICON_NAMES } = await import("../src/ui/icons");
  for (const n of ["download", "eye", "layers", "loader", "alertCircle", "info", "film", "music"]) assert.ok(ICON_NAMES.includes(n as never), n);
});

test("MainChat — o2 빈 화면(마크·부제·라인 아이콘 카드) · 작성 중 점 3개 · 도구 카드 줄, classic 은 예전 그대로", () => {
  assert.match(chat, /<img className="empty-mark" src=\{o2Mark\} width=\{44\} height=\{44\} alt="" draggable=\{false\} \/>/);
  assert.match(chat, /<div className="empty-sub">파일, 앱, 웹을 대신 다뤄 드려요\. 위험한 작업은 실행 전에 꼭 물어봅니다\.<\/div>/);
  assert.match(chat, /: <Icon name="msg" size=\{18\} \/>\}<\/span>/, "제안 카드 아이콘 대체도 라인 아이콘");
  assert.match(chat, /💡 파일을 드래그하거나 📎 버튼으로 첨부 가능/, "classic 빈 화면 문구 유지");
  assert.match(chat, /<span className="progress-dots" aria-hidden="true"><i \/><i \/><i \/><\/span>/);
  assert.match(chat, /currentTool \? `\$\{formatToolName\(currentTool\.toolName\)\} 실행 중` : "답변 작성 중"/);
  assert.match(chat, /: "응답 생성 중\.\.\.";/, "classic 진행 문구 유지");
  assert.match(chat, /\{\(showToolCards \|\| activeFilter\) && isO2 && \(/);
  assert.match(chat, /<div className="tool-cards-bar" role="toolbar" aria-label="도구 호출 카드">/);
  assert.match(chat, /\{\(showToolCards \|\| activeFilter\) && !isO2 && \(/);
  assert.match(chat, /tool 카드의 🟢🟡🟠🔴 배지 또는 category 라벨을 클릭하면 필터 토글/, "classic 도구 막대 유지");
});

test("DEV 픽스처 ?content=rich|empty — 배포 빌드에선 꺼짐, 코드·도구(완료/실패/실행 중)·오류 카드·작성 중 예시", async () => {
  const fx = await import("../src/dev/mockupFixture");
  for (const env of [{ DEV: false }, undefined]) {
    assert.equal(fx.devContentOverride(env, "?fixture=mockup&content=rich"), null);
    assert.equal(fx.readMockupFixture(env, "?fixture=mockup&content=rich"), null);
  }
  assert.equal(fx.devContentOverride({ DEV: true }, "?content=rich"), null, "?fixture=mockup 없이는 꺼짐");
  const rich = fx.readMockupFixture({ DEV: true }, "?fixture=mockup&content=rich")!;
  const tools = rich.messages.filter((m) => m.role === "tool") as Array<{ status: string }>;
  assert.deepEqual([...new Set(tools.map((t) => t.status))].sort(), ["error", "pending", "success"]);
  const text = rich.messages.map((m) => m.content).join("\n");
  assert.match(text, /```powershell/);
  assert.match(text, /\| --- \| --- \| ---: \|/);
  assert.ok(rich.messages.some((m) => m.role === "system" && (m as { level?: string }).level === "error"));
  assert.ok(rich.messages.some((m) => m.role === "assistant" && (m as { streaming?: boolean }).streaming));
  const empty = fx.readMockupFixture({ DEV: true }, "?fixture=mockup&content=empty")!;
  assert.equal(empty.messages.length, 0);
  // 기본 픽스처는 그대로 (dzA·fid 캡처와 같은 예시)
  assert.equal(fx.readMockupFixture({ DEV: true }, "?fixture=mockup")!.messages.length, 4);
  assert.doesNotMatch(fixtureSrc, /localStorage\.setItem|sessionStorage|invoke\(|indexedDB/);
  assert.match(chat, /if \(devContentOverride\(\) === "rich"\) return true;/, "도구 카드 표시는 DEV 픽스처에서만 저장 없이 켬");
});
