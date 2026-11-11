// v0.7.86 UI 개편 8단계 — 설정 재구성 회귀 테스트 (evidence/ui-redesign-20261111/design-spec.md 3.7, 5장, 8장 8단계).
// 두 배치 공통: 9개 그룹 · 섹션은 data-tab 값과 order 만 변경 · 설정 검색 · ③ 적용 순서 · ⑦ 대화 표시 · ⑧ 대화 백업 · 옛 탭 값 이전.
// o2: 본문 영역 전체 페이지(← / Esc), 사이드바 레일, 사이드바 백업 메뉴 제거.
// classic: 예전 모달 오버레이(× 닫기 · L자 모서리 · 바깥 클릭 닫기), 사이드바 백업 details 유지.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const settings = read("../src/components/Settings.tsx");
const app = read("../src/App.tsx");
const css = read("../src/App.css");
const sidebar = read("../src/components/Sidebar.tsx");

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

const GROUPS = ["general", "ai", "safety", "agent", "tools", "connect", "display", "data", "advanced"];

test("9개 그룹 — 순서·id ('tools'·'ai' 유지)", async () => {
  const m = await import("../src/utils/settingsTabs");
  assert.deepEqual(m.SETTINGS_TABS.map((t) => t.id), GROUPS);
  assert.deepEqual(m.SETTINGS_TABS.map((t) => t.label),
    ["일반", "AI 엔진", "권한과 안전", "에이전트 동작", "도구 (MCP)", "연결", "화면·비서", "데이터·백업", "고급·문제 해결"]);
  assert.match(settings, /if \(!open \|\| activeTab !== "tools"\) return;/);
});

test("옛 탭 값 이전: v2 플래그 없을 때만 옛 표, 모르는 값은 ai", async () => {
  const { resolveSettingsTab, readSettingsTab } = await import("../src/utils/settingsTabs");
  const legacy: Record<string, string> = { ai: "ai", agent: "safety", appearance: "display", system: "general", tools: "tools", safety: "safety" };
  for (const [from, to] of Object.entries(legacy)) assert.equal(resolveSettingsTab(from, false), to, from);
  assert.equal(resolveSettingsTab("agent", true), "agent"); // 이전 뒤에는 새 의미
  assert.equal(resolveSettingsTab("advanced", true), "advanced");
  assert.equal(resolveSettingsTab("garbage", false), "ai");
  assert.equal(resolveSettingsTab("system", true), "ai");
  assert.equal(resolveSettingsTab("toString", false), "ai");
  assert.equal(resolveSettingsTab(null, false), "ai");
  store.clear();
  store.set("kda_active_settings_tab", "agent");
  assert.equal(readSettingsTab(), "safety");
  assert.equal(store.get("kda_settings_tab_v2"), "1");
  assert.equal(store.get("kda_active_settings_tab"), "safety");
  assert.equal(readSettingsTab(), "safety"); // StrictMode 두 번째 호출도 같은 값
  store.delete("kda_settings_tab_v2");
  store.set("kda_active_settings_tab", "system");
  assert.equal(readSettingsTab(), "general");
  assert.equal(readSettingsTab(), "general");
  store.set("kda_active_settings_tab", "agent");
  assert.equal(readSettingsTab(), "agent");
});

test("설정 검색: 제목 텍스트 부분 일치 (대소문자·공백 무시)", async () => {
  const { settingsSectionMatches } = await import("../src/utils/settingsTabs");
  assert.equal(settingsSectionMatches(["🔄 Memory Sync (Git)", "개인 + 팀 메모리"], "memory  sync"), true);
  assert.equal(settingsSectionMatches(["텔레그램 연동"], "텔레"), true);
  assert.equal(settingsSectionMatches(["업데이트"], "단축키"), false);
  assert.equal(settingsSectionMatches(["업데이트"], "   "), false);
});

test("섹션: 모두 9개 그룹 중 하나 + style order, 그룹마다 1개 이상, 블록 위치는 그대로", () => {
  const sections = [...settings.matchAll(/<section className="settings-section" data-tab="([a-z]+)" style=\{\{ order: (\d+) \}\}/g)];
  const all = settings.match(/className="settings-section"/g) ?? [];
  assert.equal(sections.length, all.length, "data-tab + order 없는 섹션이 있음");
  assert.equal(all.length, 40); // 기존 37 + 적용 순서 · 대화 표시 · 대화 백업
  for (const [, tab] of sections) assert.ok(GROUPS.includes(tab), tab);
  for (const g of GROUPS) assert.ok(sections.some(([, t]) => t === g), `${g} 그룹에 섹션 없음`);
  // 매핑 표본 (5장)
  const tabOf = (eyebrow: string) => {
    const at = settings.indexOf(`<div className="eyebrow">${eyebrow}</div>`);
    assert.ok(at > 0, eyebrow);
    const sec = settings.lastIndexOf("<section", at);
    return settings.slice(sec, at).match(/data-tab="([a-z]+)" style=\{\{ order: (\d+) \}\}/)!.slice(1).join(":");
  };
  assert.equal(tabOf("시작"), "general:10");
  assert.equal(tabOf("정보"), "general:50");
  assert.equal(tabOf("활성 모델"), "ai:0");
  assert.equal(tabOf("📊 안전 상태 요약"), "safety:0");
  assert.equal(tabOf("적용 순서"), "safety:5");
  assert.equal(tabOf("기능별 허용 범위"), "safety:10");
  assert.equal(tabOf("실행 확인"), "safety:20");
  assert.equal(tabOf("🧪 실험 기능 (에이전트)"), "agent:10");
  assert.equal(tabOf("🔧 활성 MCP 도구"), "tools:10");
  assert.equal(tabOf("텔레그램 연동 (폰에서 원격 조작)"), "connect:10");
  assert.equal(tabOf("대화 표시"), "display:30");
  assert.equal(tabOf("대화 백업"), "data:30");
  assert.equal(tabOf("🔄 Memory Sync (Git)"), "data:40");
  assert.equal(tabOf("🧟 좀비 codex 프로세스"), "advanced:30");
  assert.match(settings, /data-tab="advanced" style=\{\{ order: 10 \}\} data-firstrun=/);
  assert.match(settings, /data-tab="display" style=\{\{ order: 5 \}\} data-testid="ui-layout-section"/);
});

test("CSS: 9개 그룹 필터 + 검색 + 요약 카드는 o2 페이지에서만", () => {
  assert.match(css, /\.settings-body\[data-active-tab\] section\[data-tab\] \{\n  display: none;\n\}/);
  for (const g of GROUPS) assert.ok(css.includes(`.settings-body[data-active-tab="${g}"] section[data-tab="${g}"]`), g);
  assert.doesNotMatch(css, /data-active-tab="(appearance|system)"/);
  assert.match(css, /\.settings-body\[data-searching\] section\[data-tab\] \{ display: none; \}/);
  assert.match(css, /\.settings-body\[data-searching\] section\[data-tab\]\[data-search-hit\] \{ display: flex; \}/);
  assert.match(css, /\.settings-group-intro \{ display: none; \}/);
  assert.match(css, /\.settings-overlay--page \.settings-group-intro \{/);
  assert.match(css, /grid-template-columns: 232px minmax\(0, 1fr\);/);
  assert.match(css, /\.settings-overlay--page \.settings-body > \* \{ width: 100%; max-width: 760px;/);
  assert.match(css, /\.settings-overlay\.settings-overlay--page \{\n  inset: 0 0 0 var\(--sidebar-width, 56px\);/);
});

test("Settings: 검색창 · 그룹 nav · 검색 결과 표시", () => {
  assert.match(settings, /placeholder="설정 검색"\n\s+aria-label="설정 검색"/);
  assert.match(settings, /data-searching=\{searching \? "true" : undefined\}/);
  assert.match(settings, /sec\.setAttribute\("data-search-hit", "true"\)/);
  assert.match(settings, /onClick=\{\(\) => \{ setSettingsQuery\(""\); setActiveTab\(tab\.id\); \}\}/);
  assert.match(settings, /검색 결과 \$\{searchHits\}개/);
});

test("o2 는 전체 페이지(← / Esc), classic 은 예전 모달(× · L자 모서리 · 바깥 클릭)", () => {
  assert.match(settings, /const isO2 = uiLayout === "o2";/);
  assert.match(settings, /<div className=\{`settings-overlay\$\{isO2 \? " settings-overlay--page" : ""\}`\} onClick=\{isO2 \? undefined : onClose\}>/);
  assert.match(settings, /\{!isO2 && <CornerBrackets corners=\{\["tl", "tr", "bl", "br"\]\} size=\{12\} \/>\}/);
  assert.match(settings, /\{!isO2 && \(\n\s+<button className="settings-close" onClick=\{onClose\} aria-label="닫기">/);
  assert.match(settings, /\{isO2 && \(\n\s+<button type="button" className="settings-back" onClick=\{onClose\} aria-label="대화로 돌아가기"/);
  assert.match(settings, /\{isO2 \? "설정" : "환경설정"\}/);
  assert.match(settings, /if \(!open \|\| !isO2\) return;\n\s+const onKey = \(e: KeyboardEvent\) => \{\n\s+if \(e\.key !== "Escape"/);
});

test("App: 설정 페이지면 레일, 첫 실행은 advanced, 안전 칩은 safety, 대화 백업 연결", () => {
  assert.match(app, /const settingsPage = isO2 && settingsOpen;/);
  assert.match(app, /const sidebarRail = isO2 && \(settingsPage \|\| /);
  assert.match(app, /localStorage\.setItem\("kda_active_settings_tab", "advanced"\);/);
  assert.doesNotMatch(app, /"kda_active_settings_tab", "(system|agent)"/);
  assert.match(app, /localStorage\.setItem\("kda_active_settings_tab", "safety"\);/);
  assert.match(app, /onConversationsImported=\{refreshConversations\}/);
  assert.match(app, /if \(isO2\) setSettingsOpen\(false\);/);
});

test("⑧ 대화 백업은 사이드바와 같은 유틸, o2 사이드바에서는 빠지고 classic 은 유지", () => {
  assert.match(settings, /exportConversationToFile\(activeConversationId\)/);
  assert.match(settings, /exportAllConversationsToFile\(\)/);
  assert.match(settings, /importConversationsFromFile\(onConversationsImported\)/);
  const head = sidebar.slice(sidebar.indexOf("const renderSectionHead = "), sidebar.indexOf("const renderO2Foot = "));
  assert.doesNotMatch(head, /백업|handleExport|handleImport/);
  const classicFoot = sidebar.slice(sidebar.indexOf("{isO2 ? renderO2Foot() : (<>"), sidebar.indexOf("<CornerBrackets corners="));
  assert.match(classicFoot, /<details className="sidebar-section sidebar-backup">/);
  for (const s of ["onClick={handleExportCurrent}", "onClick={handleExportAll}", "onClick={handleImport}"]) assert.ok(classicFoot.includes(s), s);
});

test("③ 적용 순서 다이어그램 · ⑦ 대화 표시 토글", () => {
  const order = settings.slice(settings.indexOf('data-testid="safety-order-section"'), settings.indexOf('data-testid="chat-display-section"'));
  const steps = ["기능별 허용 범위", "실행 확인", "개별 도구 잠금", "SafeMode", "결과물 검수"];
  let at = -1;
  for (const s of steps) { const i = order.indexOf(`["${s}"`); assert.ok(i > at, s); at = i; }
  assert.match(settings, /setChatDisplay\(CHAT_WIDTH_KEY, v\)/);
  assert.match(settings, /setChatDisplay\(ASSISTANT_STYLE_KEY, v\)/);
  assert.match(settings, /window\.dispatchEvent\(new Event\(CHAT_DISPLAY_EVENT\)\)/);
});
