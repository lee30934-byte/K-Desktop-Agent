// v0.7.86 UI 개편 4단계 — 우측 슬라이드오버 구조 회귀 테스트 (evidence/ui-redesign-20261111/design-spec.md 3.6, 8장 4단계).
// 미리보기(SidePanel) · 작업(TaskActivityPanel) · 비서(AssistantWidget 패널)를 한 슬라이드오버의 탭으로 모으되,
// 기능·props 는 그대로, 통화 중 패널은 닫아도 unmount 하지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = read("../src/App.tsx");

test("App: rightPanel 상태 4종 + SidePanel 열림과 동기화", () => {
  assert.match(app, /type RightPanel = "preview" \| "tasks" \| "session" \| "assistant" \| null;/);
  assert.match(app, /const sidePanelOpen = rightPanel === "preview";/);
  assert.match(app, /localStorage\.getItem\("kda_side_panel_open"\) === "1" \? "preview" : null/);
});

test("App: 슬라이드오버 한 개 안에 미리보기·작업·비서 탭 (항상 마운트)", () => {
  const start = app.indexOf("        <SlideOver\n");
  const end = app.indexOf("        </SlideOver>", start);
  assert.ok(start > 0 && end > start, "SlideOver 블록");
  const block = app.slice(start, end);
  assert.match(block, /\n          keepMounted\n/);
  assert.match(block, /open=\{rightPanel !== null\}/);
  assert.match(block, /role="tablist"/);
  assert.match(block, /<SidePanel\s+embedded\s+open=\{sidePanelOpen\}/);
  assert.match(block, /<TaskActivityPanel \{\.\.\.taskPanelProps\} mode="inline" \/>/);
  assert.match(block, /className="right-pane right-pane--assistant companion-host" hidden=\{rightPanel !== "assistant"\}\s+ref=\{setAssistantPanelHost\}/);
  // o2 슬라이드오버 안 1개 + classic 예전 SidePanel 1개
  assert.equal((app.match(/<SidePanel\s/g) ?? []).length, 2);
});

test("App: o2 헤더 작업 칩·비서 아이콘·복구 배너 [상세] 가 해당 탭을 연다", () => {
  assert.match(app, /\? <TaskActivityPanel \{\.\.\.taskPanelProps\} mode="chip" panelOpen=\{rightPanel === "tasks"\} onOpenPanel=\{\(\) => toggleRightPanel\("tasks"\)\} \/>/);
  assert.match(app, /onOpenAssistant=\{isO2 \? \(\) => toggleRightPanel\("assistant"\) : undefined\}/);
  assert.match(app, /onOpenPreview=\{isO2 \? \(\) => setSidePanelOpen\(true\) : undefined\}/);
  assert.match(app, /className="recovery-detail" onClick=\{\(\) => \{ if \(isO2\) setRightPanel\("tasks"\); else showRecoverableTasksAlert\(\); \}\}>상세</);
  assert.match(app, /\.\.\.\(isO2 \? \{ panelHost: assistantPanelHost, panelOpen: rightPanel === "assistant",/);
});

test("App: classic 배치는 예전 구조 그대로 (SidePanel 직접·작업 팝오버·비서 팝오버·복구 alert)", () => {
  assert.match(app, /import \{ useUiLayout \} from "\.\/utils\/useUiLayout";/);
  assert.match(app, /const \{ isO2 \} = useUiLayout\(\);/);
  // 슬라이드오버는 o2 에서만. classic 은 embedded 아닌 SidePanel(가장자리 ⟨, --side-panel-width 자체 관리)
  assert.match(app, /\{isO2 \? \(\n[\s\S]*?<SlideOver\n[\s\S]*?<\/SlideOver>\n      \) : \(\n        <SidePanel\n          open=\{sidePanelOpen\}/);
  assert.match(app, /: <TaskActivityPanel \{\.\.\.taskPanelProps\} mode="popover" \/>/);
  assert.match(app, /if \(!isO2\) \{ root\.style\.setProperty\("--slideover-offset", "0px"\); return; \}/);
  assert.match(app, /alert\(`복구 가능한 작업 목록/);
  assert.match(app, /previewReady=\{isO2 && /);
});

test("AssistantWidget: 아바타 포털 유지 + 패널은 host 로 포털, hidden 으로만 숨김", () => {
  const w = read("../src/components/AssistantWidget.tsx");
  assert.match(w, /createPortal\(<aside ref=\{panel\} aria-label="O2 비서"/);
  assert.match(w, /document\.body\)\}\{hosted \? createPortal\(popover, props\.panelHost!\) : null\}/);
  assert.match(w, /const popover = <div className=\{`companion-popover\$\{hosted \? ' is-hosted' : ''\}`\} hidden=\{!open\}>/);
  // 비서 메뉴·통화 조작 열기는 같은 open 경로(슬라이드오버 비서 탭)를 쓴다
  assert.match(w, /aria-label="비서 메뉴" aria-expanded=\{open\} onClick=\{\(\) => setOpen\(p => !p\)\}/);
  assert.match(w, /if \(controlled\) props\.onPanelOpenChange\?\.\(value\); else setLocalOpen\(value\);/);
});

test("TaskActivityPanel: popover(기본) / chip / inline 모드, 같은 본문", () => {
  const t = read("../src/components/TaskActivityPanel.tsx");
  assert.match(t, /mode\?: "popover" \| "chip" \| "inline";/);
  assert.match(t, /if \(mode === "chip"\) return <aside className="task-activity"/);
  assert.match(t, /if \(mode === "inline"\) return <section className="task-activity task-activity--inline"/);
  assert.match(t, /className="task-activity-toggle"/); // verify-conversation-control-ui.py 셀렉터 유지
});

test("SlideOver 프리미티브: keepMounted · 폭 조절 · 다른 모달의 Esc 는 무시", () => {
  const p = read("../src/ui/primitives.tsx");
  assert.match(p, /\{open \|\| keepMounted \? children : null\}/);
  assert.match(p, /onResize\(Math\.max\(minWidth, Math\.min\(maxWidth, window\.innerWidth - e\.clientX\)\)\)/);
  assert.match(p, /minWidth = 360, maxWidth = 640, defaultWidth = 380/);
  assert.match(p, /t\.closest\?\.\('\[role="dialog"\], \.settings-overlay/);
});
