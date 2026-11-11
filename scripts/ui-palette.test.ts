// v0.7.86 UI 개편 9단계 — 명령 팔레트 회귀 테스트 (evidence/ui-redesign-20261111/design-spec.md 4.4 P5, 8장 9단계, R14).
// 두 배치 공통: Ctrl+K 별칭(Ctrl+P 유지), 그룹 동작 / 빠른 요청 / 대화 이동 / 설정, 옛 이름 키워드, 설정 섹션 앵커 스크롤.
// 패널 열기: o2 는 슬라이드오버 4탭, classic 은 예전 가장자리 미리보기 패널만.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const palette = read("../src/components/CommandPalette.tsx");
const settings = read("../src/components/Settings.tsx");
const app = read("../src/App.tsx");
const chat = read("../src/components/MainChat.tsx");

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

const item = (id: string, label: string, group: "action" | "quick" | "conversation" | "settings", keywords?: string[]) =>
  ({ id, label, group, keywords, run: () => {} });

test("검색 — 옛 이름 키워드와 띄어쓰기 무시, 그룹 순서 유지", async () => {
  const m = await import("../src/utils/commandPalette");
  const items = [
    item("set", "실행 확인", "settings", ["자동 승인"]),
    item("conv", "보고서 정리", "conversation"),
    item("refresh", "새 세션으로 이어가기", "action", ["세션 초기화", "초기화"]),
    item("approval", "확인 없이 실행 켜기", "action", ["자동 승인"]),
  ];
  assert.deepEqual(m.filterPaletteItems(items, "초기화").map((i) => i.id), ["refresh"]);
  assert.deepEqual(m.filterPaletteItems(items, "자동승인").map((i) => i.id), ["approval", "set"], "동작이 설정보다 먼저");
  assert.deepEqual(m.filterPaletteItems(items, "대화 이동").map((i) => i.id), ["conv"], "그룹 이름으로도 찾음");
  const many = Array.from({ length: 10 }, (_, i) => item(`c${i}`, `대화 ${i}`, "conversation"));
  assert.equal(m.filterPaletteItems(many, "").length, 6, "검색어 없으면 최근 대화 6개");
  assert.equal(m.filterPaletteItems(many, "대화").length, 10);
});

test("옛 이름 키워드가 새 항목에 붙어 있다 (R14)", () => {
  const kw = (id: string) => {
    const at = palette.indexOf(`id: "${id}"`);
    assert.ok(at > 0, id);
    return palette.slice(at, palette.indexOf("run:", at));
  };
  assert.match(kw("session-refresh"), /새 세션으로 이어가기[\s\S]*"세션 초기화"[\s\S]*"갱신"[\s\S]*"리셋"[\s\S]*"컨텍스트 비우기"/);
  assert.match(kw("compress-context"), /요약해서 새 대화로 이어가기[\s\S]*"대화 압축"/);
  assert.match(kw("toggle-approval"), /확인 없이 실행[\s\S]*Ctrl\+Alt\+A[\s\S]*"자동 승인"/);
  assert.match(kw("toggle-layout"), /화면 스타일[\s\S]*"레이아웃"[\s\S]*"클래식"/);
  assert.match(palette, /\.\.\.QUICK_PROMPTS\.map\(\(p\): Command => \(\{[\s\S]*?group: "quick"/);
  assert.match(palette, /onSearchConversations\(q\)/, "대화 이동은 메시지 내용 검색도 쓴다");
});

test("설정 섹션 앵커 — 모든 섹션에 id, 팔레트 목록과 data-tab 일치", async () => {
  const { SETTINGS_SECTION_ANCHORS } = await import("../src/utils/commandPalette");
  const { SETTINGS_TABS } = await import("../src/utils/settingsTabs");
  const sections = [...settings.matchAll(/<section ([^>]*?)className="settings-section" data-tab="(\w+)"/g)];
  assert.ok(sections.length >= 40);
  const idToTab = new Map<string, string>();
  for (const s of sections) {
    const id = /id="(settings-sec-[\w-]+)"/.exec(s[1])?.[1];
    assert.ok(id, `section(${s[2]}) 에 id 없음`);
    assert.ok(!idToTab.has(id!), `id 중복 ${id}`);
    idToTab.set(id!, s[2]);
  }
  assert.equal(SETTINGS_SECTION_ANCHORS.length, idToTab.size, "모든 섹션이 팔레트에 있다");
  for (const a of SETTINGS_SECTION_ANCHORS) {
    assert.equal(idToTab.get(a.id), a.tab, a.id);
    assert.ok(SETTINGS_TABS.some((t) => t.id === a.tab));
  }
  // 열릴 때 탭을 다시 읽는 effect 뒤에서 앵커 그룹을 연다 (순서가 바뀌면 덮어써짐)
  const reread = settings.indexOf("setActiveTab(readSettingsTab());");
  const focus = settings.indexOf("SETTINGS_SECTION_ANCHORS.find((a) => a.id === focusSection.id)");
  assert.ok(reread > 0 && focus > reread);
  assert.match(settings, /document\.getElementById\(anchor\.id\)[\s\S]*?scrollIntoView/);
  assert.match(app, /focusSection=\{settingsFocus\}/);
});

test("App — Ctrl+K 별칭, 두 배치 모두 팔레트 마운트, 배치별 패널", () => {
  assert.match(app, /\(k === "k" \|\| k === "p"\)/);
  assert.match(app, /register\("Ctrl\+Shift\+P"/, "전역 단축키 유지");
  const mount = app.slice(app.lastIndexOf("\n", app.indexOf("<CommandPalette")), app.indexOf("/>", app.indexOf("<CommandPalette")));
  assert.doesNotMatch(app.slice(app.indexOf("<CommandPalette") - 40, app.indexOf("<CommandPalette")), /isO2 &&/, "classic 에서도 마운트");
  assert.match(mount, /panels=\{isO2 \? PALETTE_PANELS_O2 : PALETTE_PANELS_CLASSIC\}/);
  assert.match(app, /PALETTE_PANELS_O2[^=]*= \["preview", "tasks", "session", "assistant"\]/);
  assert.match(app, /PALETTE_PANELS_CLASSIC[^=]*= \["preview"\]/);
  assert.match(mount, /onSessionRefresh=/);
  assert.match(mount, /onCompressContext=/);
  assert.match(mount, /onOpenSettingsSection=\{openSettingsSection\}/);
  assert.match(chat, /addEventListener\("kda-show-tool-cards-changed", sync\)/);
});

const render = (props: Record<string, unknown>) => import("../src/components/CommandPalette").then(({ default: P }) =>
  renderToStaticMarkup(createElement(P, {
    open: true, onClose() {}, onSendMessage() {}, onOpenSettings() {}, onNewChat() {},
    onSessionRefresh() {}, onCompressContext() {}, onOpenSettingsSection() {}, onSelectConversation() {},
    conversations: [{ id: "a", title: "보고서 정리", lastActive: 1, messageCount: 2 }],
    ...props,
  } as any)));

test("렌더 — o2: 그룹 4개와 슬라이드오버 패널, classic: 미리보기 패널만", async () => {
  store.set("kda_ui_layout", "o2");
  const o2 = await render({ panels: ["preview", "tasks", "session", "assistant"] });
  for (const g of ["동작", "빠른 요청", "대화 이동", "설정"]) assert.ok(o2.includes(`>${g}</div>`), g);
  for (const t of ["새 대화", "확인 없이 실행 켜기", "새 세션으로 이어가기", "요약해서 새 대화로 이어가기", "작업 패널 열기", "세션·사용량 보기", "비서 패널 열기", "화면 스타일: 클래식으로 바꾸기", "보고서 정리", "실행 확인"])
    assert.ok(o2.includes(t), t);
  assert.match(o2, /role="dialog" aria-modal="true" aria-label="명령 팔레트"/);

  store.set("kda_ui_layout", "classic");
  store.set("kda_auto_approval", "1");
  const classic = await render({ panels: ["preview"] });
  assert.ok(classic.includes("미리보기 패널 열기"));
  assert.ok(!classic.includes("작업 패널 열기") && !classic.includes("비서 패널 열기"));
  assert.ok(classic.includes("화면 스타일: O2로 바꾸기"));
  assert.ok(classic.includes("command-palette-overlay"), "예전 className 유지");
});
