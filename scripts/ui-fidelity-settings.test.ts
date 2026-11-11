// v0.7.86 UI 목업 충실도 fidC — 설정 전체 페이지 (왼쪽 열 · 그룹 머리 · 권한과 안전 요약/번호 섹션 · 공통 행 언어).
// 기준: evidence/ui-redesign-20261111/mockup.html (.snav · .gitem · .spage · .summary · .ssec · .rows · .srow · .seg · .switch).
// o2 만 바뀌고 classic 모달은 그대로인지, 개발용 ?settings= 이 배포 빌드에서 꺼져 있는지 확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const settings = read("../src/components/Settings.tsx");
const o2 = read("../src/components/SettingsO2.tsx");
const css = read("../src/styles/o2-settings.css");
const appCss = read("../src/App.css");
const app = read("../src/App.tsx");
const tabs = read("../src/utils/settingsTabs.ts");
const fixtureSrc = read("../src/dev/mockupFixture.ts");

test("개발용 ?settings=<그룹>&q= — 배포 빌드(DEV=false)에서는 꺼짐, 저장도 안 함", async () => {
  const fx = await import("../src/dev/mockupFixture");
  assert.equal(fx.devSettingsOverride({ DEV: false }, "?settings=safety"), null);
  assert.equal(fx.devSettingsOverride(undefined, "?settings=safety"), null);
  assert.equal(fx.devSettingsOverride({ DEV: true }, "?settings=nope"), null);
  assert.deepEqual(fx.devSettingsOverride({ DEV: true }, "?settings=general&q=백업"), { group: "general", query: "백업" });
  assert.match(settings, /if \(devSettingsOverride\(\)\) return; \/\/ fidC — DEV 캡처용 그룹은 저장하지 않는다/);
  assert.match(app, /if \(!dbReady \|\| !devSettingsOverride\(\)\) return;/);
  assert.doesNotMatch(fixtureSrc, /localStorage\.setItem|invoke\(/);
});

test("셸 — o2 왼쪽 열: [← 대화로 돌아가기 Esc] · 검색 · 9그룹(라인 아이콘 + 섹션 수) · 버전/단축키 안내, 위쪽 머리줄 없음", () => {
  assert.match(settings, /<span className="settings-back-label">대화로 돌아가기<\/span>\n\s+<span className="settings-back-kbd">Esc<\/span>/);
  assert.match(settings, /\{isO2 \? <Icon name=\{SETTINGS_GROUP_ICONS\[tab\.id\]\} size=\{16\} \/> : tab\.icon\}/);
  assert.match(settings, /\{isO2 && groupCounts\[tab\.id\] != null && <span className="settings-tab-count">\{groupCounts\[tab\.id\]\}<\/span>\}/);
  assert.match(settings, /K Desktop Agent\{appVersion && appVersion !== "unknown" \? ` v\$\{appVersion\}` : ""\}<br \/>\n\s+Ctrl\+K로 설정 섹션 바로 이동/);
  assert.doesNotMatch(settings, /v0\.42\.0/);
  // 9그룹 모두 라인 아이콘
  for (const id of ["general", "ai", "safety", "agent", "tools", "connect", "display", "data", "advanced"]) assert.match(o2, new RegExp(`\\b${id}: "[a-zA-Z]+",`));
  // 목업 값: nav 232, 내용 패딩 22/32/60, 레일 톱니 켜짐
  assert.match(css, /grid-template-columns: var\(--settings-nav-w, 232px\) minmax\(0, 1fr\);/);
  assert.match(css, /padding: 22px 32px 60px;/);
  assert.match(css, /body:has\(\.settings-overlay--page\) \.sb-rail-btn\[aria-label="설정"\] \{ background: var\(--surface-active\); color: var\(--accent\); \}/);
});

test("그룹 머리 — 경로 '설정 / 그룹' · H1 · 한 줄 설명 (마침표 문장)", () => {
  assert.match(settings, /<div className="settings-group-crumb">설정 \/ \{activeGroup\.label\}<\/div>\n\s+<h1 className="settings-group-intro-title">\{activeGroup\.label\}<\/h1>/);
  for (const m of tabs.matchAll(/desc: "([^"]+)"/g)) assert.match(m[1], /다\.$/, m[1]);
});

test("권한과 안전 — 요약 카드(실제 상태에서 셈) + 번호 섹션 4개, 기존 핸들러 그대로", () => {
  assert.match(settings, /auto: permissions\.filter\(\(p\) => p\.level === "auto"\)\.length,/);
  assert.match(settings, /locked=\{lockedTools\.size\}/);
  assert.match(o2, /\{ n: 1, title: "기능별 허용 범위"[\s\S]*\{ n: 2, title: "실행 확인"[\s\S]*\{ n: 3, title: "개별 도구 잠금"[\s\S]*\{ n: 4, title: "SafeMode"/);
  assert.match(settings, /<O2SecHead title="1\. 기능별 허용 범위" badge="묻기는 Claude 엔진만"/);
  assert.match(settings, /<O2SecHead title="2\. 실행 확인" badge="Codex·MCP 경로"/);
  assert.match(settings, /<O2SecHead title="3\. 개별 도구 잠금"/);
  assert.match(settings, /<O2SecHead title="4\. SafeMode" badge="위험도 기반 안전 모드"/);
  // 허용/묻기/차단 세그먼트는 updatePermission, 스위치는 useApprovalMode, SafeMode 는 classic 과 같은 applySafeModeChoice
  assert.match(settings, /onChange=\{\(v\) => updatePermission\(perm\.id, v\)\}/);
  assert.match(settings, /<O2Switch checked=\{autoApprovalOn\} onChange=\{toggleAutoApproval\}/);
  assert.match(settings, /<O2Seg label="SafeMode 안전 단계" value=\{safeMode\} onChange=\{applySafeModeChoice\}/);
  assert.match(settings, /onClick=\{\(\) => applySafeModeChoice\(mode\)\}/);
  // 세그먼트 색: 허용 초록 · 묻기 파랑 · 차단 빨강
  assert.match(css, /\.o2s-seg__opt--a\.is-on \{ background: rgba\(74, 222, 128, \.12\); color: var\(--ok\);/);
  assert.match(css, /\.o2s-seg__opt--q\.is-on \{ background: rgba\(106, 161, 255, \.14\);/);
  assert.match(css, /\.o2s-seg__opt--x\.is-on \{ background: var\(--danger-soft\);/);
});

test("공통 언어 — 이모지는 o2 에서만 숨김, 모든 o2 규칙은 data-layout=\"o2\" 범위", () => {
  assert.match(css, /:root\[data-layout="o2"\] \.settings-overlay--page \.eyebrow-emoji \{ display: none; \}/);
  assert.ok((settings.match(/className="eyebrow-emoji"/g) ?? []).length >= 18);
  // 경계: 규칙 시작 선택자마다 o2 범위 (주석·@ 규칙 제외)
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((b) => b.split("{")[0].trim()).filter(Boolean);
  // 쉼표는 괄호·대괄호·따옴표 밖에 있을 때만 선택자 구분 (예: [style*="rgba(79, 232, 225"])
  const splitTop = (sel: string) => {
    const out: string[] = []; let depth = 0, quote = "", cur = "";
    for (const ch of sel) {
      if (quote) { if (ch === quote) quote = ""; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    return [...out, cur];
  };
  for (const sel of selectors) for (const part of splitTop(sel)) assert.match(part.trim(), /^:root\[data-layout="o2"\]/, part);
  assert.match(app, /import "\.\/styles\/o2-settings\.css";/);
});

test("classic 은 그대로 — 모달 머리줄(환경설정 ×) · L자 장식 · 가로 이모지 탭 · 예전 SafeMode 3버튼", () => {
  assert.match(settings, /\{!isO2 && <CornerBrackets corners=\{\["tl", "tr", "bl", "br"\]\} size=\{12\} \/>\}/);
  assert.match(settings, /<h2 className="display settings-title">환경설정<\/h2>/);
  assert.match(settings, /className="safemode-picker"/);
  // classic 경로의 예전 ApprovalToggle 행 유지
  assert.match(settings, /\) : \(<>\n\s+<div className="settings-row">\n\s+<div className="settings-row-info">\n\s+<div className="settings-row-title">확인 없이 실행<\/div>/);
  assert.match(settings, /<ApprovalToggle \/>/);
  // classic 기본 스타일은 App.css 에 그대로
  assert.match(appCss, /\.settings-panel \{\n  position: relative;\n  background: var\(--bg-2\);/);
});
