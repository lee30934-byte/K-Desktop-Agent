// v0.7.86 UI 개편 최종 점검 — 스펙 4장(메인 화면 컨트롤 배치표) 도달성 회귀 테스트.
// o2: 헤더 ⋯ 메뉴에 확인 없이 실행(첫 줄) / 이 대화의 엔진 / 폴더 지침 편집 (H8), 엔진 칩은 대화 고정 엔진 반영 (M1),
//     폴더 이름 📎 → 폴더 지침 (S11). 두 배치 공통: '📜 폴더 지침…' 이름 (S11), Ctrl+, 설정 열기 + 단축키 목록 (P9/P9a).
// classic: 헤더는 예전 구조(ApprovalToggle 버튼, ⋯ 에 새 항목 없음), 작업 팝오버 토글의 accent 배경은 o2 에만.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = read("../src/App.tsx");
const sidebar = read("../src/components/Sidebar.tsx");
const dialog = read("../src/components/FolderInstructionsDialog.tsx");
const settings = read("../src/components/Settings.tsx");
const appCss = read("../src/App.css");

const chat = read("../src/components/MainChat.tsx");
// MainChat 은 CSS 를 import 해서 node 에서 SSR 로 못 띄운다 → 헤더 JSX 소스로 확인.
const header = chat.slice(chat.indexOf('<div className="main-header">'), chat.indexOf("Phase 90 — tool_use 카드"));
const menu = header.slice(header.indexOf('<div className="chat-options-body">'));

test("o2 ⋯ 메뉴 — 첫 줄 '확인 없이 실행' 스위치, '이 대화의 엔진' 선택, '폴더 지침 편집' (H8)", () => {
  assert.match(menu, /^<div className="chat-options-body">\s*\{isO2 && \(\s*<button type="button" className="chat-options-approval" role="switch" aria-checked=\{approval\.enabled\}/,
    "확인 없이 실행이 ⋯ 첫 줄 (o2 만)");
  assert.match(menu, /확인 없이 실행 · \{approval\.enabled \? "켜짐" : "꺼짐"\}/);
  assert.match(chat, /const approval = useApprovalMode\(\);/, "헤더 안전 칩·팔레트·Ctrl+Alt+A 와 같은 훅");
  assert.match(menu, /\{isO2 && onSetConversationProvider && conversationProvider !== undefined && \([\s\S]*?aria-label="이 대화의 엔진"[\s\S]*?PINNABLE_PROVIDERS\.map/,
    "활성 대화가 있을 때만 엔진 선택 (전역 따름 포함)");
  assert.match(menu, /\{isO2 && onEditFolderInstructions && \([\s\S]*?폴더 지침 편집/, "폴더 안 대화일 때만");
  assert.match(header, /onEditFolderInstructions\s*\? <button type="button" className="main-folder" onClick=\{onEditFolderInstructions\} title="폴더 지침 편집">/,
    "헤더 폴더 이름 📎 → 폴더 지침");
});

test("PINNABLE_PROVIDERS — 엔진 선택지에 전역 따름 포함", async () => {
  const { PINNABLE_PROVIDERS, providerLabel } = await import("../src/providerResolve");
  assert.equal(PINNABLE_PROVIDERS[0], null);
  assert.equal(providerLabel(null), "전역 따름");
});

test("classic — 예전 헤더 그대로: ApprovalToggle 버튼, 새 ⋯ 항목·엔진 칩·폴더는 o2 분기 안에만", () => {
  assert.match(header, /\{!isO2 && <ApprovalToggle \/>\}/);
  assert.match(header, /<div className="main-title-classic">\s*<div className="eyebrow">K DESKTOP AGENT<\/div>/);
  // 엔진 칩·폴더는 isO2 ? (...) : (classic) 의 o2 쪽에만
  const o2Title = header.slice(header.indexOf("{isO2 ? ("), header.indexOf('<div className="main-title-classic">'));
  assert.ok(o2Title.includes('className="engine-chip"') && o2Title.includes('className="main-folder"'));
  // 새 ⋯ 항목 3개는 모두 isO2 가드
  for (const marker of ['className="chat-options-approval"', 'aria-label="이 대화의 엔진"', "폴더 지침 편집"]) {
    const at = menu.indexOf(marker);
    assert.ok(at > 0, marker);
    const guard = menu.lastIndexOf("{isO2 &&", at);
    assert.ok(guard >= 0 && at - guard < 400, `${marker} 는 isO2 가드 안`);
  }
});

test("App — 엔진 칩은 대화 고정 엔진을 반영, 새 핸들러는 o2 에서만 넘긴다 (M1, H8)", () => {
  assert.match(app, /engineLabel=\{\(\(\) => \{[\s\S]*?\.provider;[\s\S]*?이 대화 고정/);
  assert.match(app, /onSetConversationProvider=\{isO2 && activeConversationId \? \(p\) => \{ void handleSetConversationProvider\(activeConversationId, p\); \}/);
  assert.match(app, /return isO2 && fid \? \(\) => \{ void handleEditFolderInstructions\(fid\); \}/);
});

test("두 배치 공통 — '📜 폴더 지침…' 이름 통일 (S11)", () => {
  assert.ok(sidebar.includes('label: "📜 폴더 지침…"'));
  assert.ok(!sidebar.includes('label: "📜 프로젝트 지침…"'));
  assert.ok(dialog.includes("📜 폴더 지침 — {folder.name}"));
});

test("두 배치 공통 — Ctrl+, 설정 열기, 설정 단축키 섹션에 앱 안 단축키 목록 (P9, P9a)", () => {
  assert.match(app, /e\.key === ","\) \{\s*e\.preventDefault\(\);\s*setSettingsOpen\(true\);/);
  const sec = settings.slice(settings.indexOf('id="settings-sec-shortcuts"'), settings.indexOf('id="settings-sec-path-map"'));
  for (const k of ["Ctrl+Shift+Space", "Ctrl+Shift+S", "Ctrl+Shift+P", "Ctrl+K / Ctrl+P", "Ctrl+Alt+A", "Ctrl+L", "Ctrl+B", "Ctrl+,"]) {
    assert.ok(sec.includes(k), k);
  }
});

test("classic 작업 팝오버 토글은 accent 배경을 받지 않는다 (o2 범위 한정)", () => {
  assert.ok(appCss.includes(':root[data-layout="o2"] .main-header-right .task-activity-toggle[aria-expanded="true"]'));
  assert.ok(!/(^|[\s,}])\.main-header-right \.task-activity-toggle\[aria-expanded="true"\]/m.test(appCss.replace(/:root\[data-layout="o2"\] \.main-header-right/g, "")));
});
