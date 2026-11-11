// v0.7.86 UI 3b단계 — 화면 스타일 전환(O2 / 클래식) 회귀 테스트.
// 2026-11-11 K: "옛 배치도 계속 쓸 수 있게" — 새 구조는 o2 에서만, classic 은 이전 헤더 그대로.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

// 브라우저 API 최소 스텁 (localStorage · window 이벤트 · documentElement.dataset)
const store = new Map<string, string>();
const target = new EventTarget();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as any).window = target;
(globalThis as any).document = { documentElement: { dataset: {} as Record<string, string> } };

test("readUiLayout: 기본값 o2, 'classic' 만 클래식, 이상한 값은 o2", async () => {
  const m = await import("../src/utils/useUiLayout");
  assert.equal(m.UI_LAYOUT_KEY, "kda_ui_layout");
  assert.equal(m.DEFAULT_UI_LAYOUT, "o2");
  store.clear();
  assert.equal(m.readUiLayout(), "o2");
  store.set("kda_ui_layout", "classic");
  assert.equal(m.readUiLayout(), "classic");
  store.set("kda_ui_layout", "weird");
  assert.equal(m.readUiLayout(), "o2");
});

test("applyUiLayout 이 document.documentElement.dataset.layout 을 맞춘다", async () => {
  const m = await import("../src/utils/useUiLayout");
  store.set("kda_ui_layout", "classic");
  m.applyUiLayout();
  assert.equal((globalThis as any).document.documentElement.dataset.layout, "classic");
  m.applyUiLayout("o2");
  assert.equal((globalThis as any).document.documentElement.dataset.layout, "o2");
});

test("useUiLayout: window 이벤트·storage 로 동기화, 저장 키 사용", () => {
  const h = read("../src/utils/useUiLayout.ts");
  assert.match(h, /addEventListener\(UI_LAYOUT_EVENT, sync\)/);
  assert.match(h, /addEventListener\('storage', sync\)/);
  assert.match(h, /localStorage\.setItem\(UI_LAYOUT_KEY, next\)/);
  assert.match(h, /dispatchEvent\(new Event\(UI_LAYOUT_EVENT\)\)/);
  assert.match(read("../src/main.tsx"), /applyUiLayout\(\);/);
});

test("설정 외관 탭에 '화면 스타일' (O2 / 클래식)", () => {
  const s = read("../src/components/Settings.tsx");
  assert.match(s, /data-tab="appearance" data-testid="ui-layout-section"/);
  assert.match(s, /\{ value: "o2", label: "O2" \}/);
  assert.match(s, /\{ value: "classic", label: "클래식" \}/);
  assert.match(s, /onChange=\{setUiLayout\}/);
});

test("헤더: o2 는 새 헤더, classic 은 이전 헤더(제목 블록 + 확인 없이 실행 버튼 + LIVE 배지)", () => {
  const m = read("../src/components/MainChat.tsx");
  assert.match(m, /const \{ isO2 \} = useUiLayout\(\);/);
  // o2: 새 제목·엔진 칩·주의 칩·안전 칩·점 배지
  assert.match(m, /isO2 \? \(\s*<div className="main-title-block">/);
  assert.match(m, /\{isO2 && \(warnings \?\? \[\]\)\.map/);
  assert.match(m, /\{isO2 && <SafetyChip onOpenSettings=\{onOpenSafetySettings\} \/>\}/);
  // classic: 이전 구조 그대로
  assert.match(m, /<div className="eyebrow">K DESKTOP AGENT<\/div>\s*<div className="main-title display">대화<\/div>/);
  assert.match(m, /\{!isO2 && <ApprovalToggle \/>\}/);
  assert.match(m, /import ApprovalToggle from "\.\/ApprovalToggle";/);
  assert.match(m, /isO2 \? <StatusBadge status=\{status\} \/> : <ClassicStatusBadge status=\{status\} \/>/);
  assert.match(m, /connected: "LIVE",/);
  // 작업 패널·대화 옵션은 양쪽 공통
  const right = m.slice(m.indexOf('<div className="main-header-right">'), m.indexOf("</details>"));
  assert.match(right, /\n\s*\{activityPanel\}/);
  assert.match(right, /aria-label="대화 옵션"/);
});

test("헤더 CSS 덮어쓰기는 :root[data-layout=\"o2\"] 로 한정", () => {
  const css = read("../src/App.css");
  assert.match(css, /:root\[data-layout="o2"\] \.main-header \.main-title \{ font: 600/);
  assert.match(css, /:root\[data-layout="o2"\] \.main-header \.status-badge \{/);
  assert.doesNotMatch(css, /^\.main-header \.status-badge \{ gap: 6px;/m);
});
