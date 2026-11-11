// v0.7.86 UI 개편 6단계 — 사이드바 단순화 회귀 테스트 (evidence/ui-redesign-20261111/design-spec.md 3.1, 4.1, 8장 6단계, 10장).
// o2: 브랜드 · [＋ 새 대화] · 내비 3줄(검색/라이브러리/작업) · '대화' 섹션(📁+ ☑ ⋯백업) · 행 hover ⋯ · 하단 고정 행 · 레일(Ctrl+B, 1100px 미만 자동).
// classic: 예전 구조(📁+/📚 버튼 줄 · 검색창 · '탐색기' · 백업 details · 환경설정 · K-PERSONAL footer) 그대로.
// renderExplorer 와 DnD 로직은 손대지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const sidebar = read("../src/components/Sidebar.tsx");
const app = read("../src/App.tsx");
const css = read("../src/App.css");
const chat = read("../src/components/MainChat.tsx");
const resizer = read("../src/components/SidebarResizer.tsx");
const backup = read("../src/utils/conversationBackup.ts");

const fnBody = (src: string, name: string) => {
  const start = src.indexOf(`const ${name} = `);
  assert.ok(start > 0, `${name} 없음`);
  const next = src.indexOf("\n  const ", start + 10);
  return src.slice(start, next > 0 ? next : undefined);
};

test("배치 분기: o2 만 새 구조, 레일은 o2 에서만", () => {
  assert.match(sidebar, /const \{ isO2 \} = useUiLayout\(\);\n\s+const railMode = isO2 && rail;/);
  assert.match(sidebar, /\{railMode \? renderRail\(\) : \(<>/);
  assert.match(sidebar, /\{isO2 \? renderO2Top\(\) : \(<>/);
  assert.match(sidebar, /\{isO2 \? renderSectionHead\(\) : \(/);
  assert.match(sidebar, /\{isO2 \? renderO2Foot\(\) : \(<>/);
  assert.match(app, /const sidebarRail = isO2 && \(narrowWindow \? !narrowSidebarOpen : sidebarRailPref\);/);
  assert.match(app, /const sidebarOverlay = isO2 && narrowWindow && narrowSidebarOpen;/);
});

test("classic: 예전 사이드바 구조가 classic 분기 안에 그대로", () => {
  const top = sidebar.slice(sidebar.indexOf("{isO2 ? renderO2Top() : (<>"), sidebar.indexOf("{/* Phase 36 (v0.5.24)"));
  assert.match(top, /className="new-folder-btn"/);
  assert.match(top, /onClick=\{onOpenLibrary\}/);
  assert.match(top, /placeholder="🔍 제목 \/ 메시지 검색…"/);
  assert.match(top, /새 대화\{viewMode === "explorer" && currentFolderId \? " \(📁\)" : ""\}/);
  const head = sidebar.slice(sidebar.indexOf("{isO2 ? renderSectionHead() : ("), sidebar.indexOf("{viewMode === \"explorer\" ? (\n          renderExplorer()"));
  assert.match(head, /"탐색기" : "대화 목록"/);
  const foot = sidebar.slice(sidebar.indexOf("{isO2 ? renderO2Foot() : (<>"), sidebar.indexOf("<CornerBrackets corners="));
  assert.match(foot, /<details className="sidebar-section sidebar-backup">/);
  for (const s of ["대화 내보내기", "전체 백업", "가져오기", "환경설정", "K-PERSONAL · {mcpConnected ? \"connected\" : \"offline\"}", 'className="sidebar-footer"']) {
    assert.ok(foot.includes(s), s);
  }
  // classic 은 레일·Ctrl+B·[다시 연결]·작업 내비 없음
  assert.match(app, /onOpenTasks=\{isO2 \? \(\) => toggleRightPanel\("tasks"\) : undefined\}/);
  assert.match(app, /onReconnectTools=\{isO2 \? handleReconnectTools : undefined\}/);
  assert.match(app, /useEffect\(\(\) => \{\n    if \(!isO2\) return;\n    const onKey = \(e: KeyboardEvent\) => \{\n      if \(\(e\.ctrlKey \|\| e\.metaKey\) && !e\.shiftKey && !e\.altKey && e\.key\.toLowerCase\(\) === "b"\)/);
  // classic 리사이저 더블클릭은 예전처럼 기본 폭
  assert.match(app, /onCollapse=\{isO2 \? toggleSidebarRail : undefined\}/);
  assert.match(resizer, /if \(onCollapse\) \{ onCollapse\(\); return; \}\n\s+\/\/ 더블클릭 시 기본 폭 \(260\) 으로 복원\n\s+onChange\(260\);/);
});

test("o2: 새 대화 · 내비 3줄 (검색은 같은 자리에서 입력창으로)", () => {
  const top = fnBody(sidebar, "renderO2Top");
  assert.match(top, /onClick=\{handleNewConversationHere\}/);
  assert.match(fnBody(sidebar, "handleNewConversationHere"), /onNewConversation\(viewMode === "explorer" \? currentFolderId : null\)/);
  assert.match(top, /새 대화\{currentFolderName \? ` \(📁 \$\{currentFolderName\}\)` : ""\}/);
  assert.match(top, /searchOpen \|\| searchQuery \?/);
  assert.match(top, /onClick=\{\(\) => setSearchOpen\(true\)\}/);
  assert.match(top, /<span>검색<\/span>/);
  assert.match(top, /<span>라이브러리<\/span><span className="sb-kbd">Ctrl\+L<\/span>/);
  assert.match(top, /<span>작업<\/span>\n\s+\{taskCount > 0 && <span className="sb-badge"/);
  assert.match(app, /taskCount=\{\[\.\.\.conversationTurnGateRef\.current\.runs\.values\(\)\]\.filter\(\(r\) => r\.state === "running" \|\| r\.state === "stopping"\)\.length\}/);
});

test("o2: '대화' 섹션 제목 도구 — 새 폴더 · 여러 대화 선택 · 백업·가져오기(같은 핸들러)", () => {
  const head = fnBody(sidebar, "renderSectionHead");
  assert.match(head, /<span className="eyebrow section-label">대화<\/span>/);
  assert.match(head, /onClick=\{\(\) => handleNewSubfolder\(null\)\} aria-label="새 폴더"/);
  assert.match(head, /onClick=\{toggleBulkMode\} aria-pressed=\{bulkSelectMode\} aria-label="여러 대화 선택"/);
  assert.match(head, /\["📤", "대화 내보내기", handleExportCurrent\],\n\s+\["💾", "전체 백업", handleExportAll\],\n\s+\["📥", "가져오기", handleImport\],/);
  assert.match(fnBody(sidebar, "toggleBulkMode"), /setBulkSelectMode\(nextMode\);\n\s+if \(!nextMode\) setSelectedConvIds\(new Set<string>\(\)\);/);
  // 대량 정리 바는 ☑ 켰을 때만 (renderExplorer 는 그대로, CSS 로만)
  assert.match(css, /\.sidebar--o2:not\(\.sidebar--bulk\) \.bulk-organize-bar \{ display: none !important; \}/);
  assert.match(sidebar, /\$\{bulkSelectMode \? " sidebar--bulk" : ""\}/);
});

test("o2: 행 hover ⋯ 는 우클릭과 같은 메뉴, 드래그로 새지 않음", () => {
  const more = fnBody(sidebar, "renderRowMore");
  assert.match(more, /onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}/);
  assert.match(more, /setContextMenu\(\{ type, id, x: r\.left, y: r\.bottom \+ 2 \}\)/);
  assert.match(sidebar, /\{isO2 && !isEditing && renderRowMore\("folder", f\.id\)\}/);
  assert.match(sidebar, /\{isO2 && !isEditing && !bulkSelectMode && renderRowMore\("conversation", c\.id\)\}/);
  assert.match(css, /\.explorer-item:hover \.explorer-row-more, \.explorer-row-more:focus-visible \{ display: grid; \}/);
});

test("renderExplorer · DnD 로직은 배치와 무관 (무수정)", () => {
  for (const name of ["renderExplorer", "handleDndEnd", "handleDndStart"]) {
    assert.doesNotMatch(fnBody(sidebar, name), /isO2|railMode/, name);
  }
  assert.match(fnBody(sidebar, "renderExplorer"), /className="bulk-organize-bar"/);
});

test("o2: 하단 고정 행 — 연결 상태 · [다시 연결] · ⚙ 설정", () => {
  const foot = fnBody(sidebar, "renderO2Foot");
  assert.match(sidebar, /const connLabel = mcpConnected \? "컴퓨터 도구 연결됨" : "도구 연결 끊김";/);
  assert.match(foot, /\{!mcpConnected && onReconnectTools && \(\n\s+<button type="button" className="sb-reconnect" onClick=\{onReconnectTools\}>다시 연결<\/button>/);
  assert.match(foot, /onClick=\{onOpenSettings\} title="설정"/);
  const reconnect = fnBody(app, "handleReconnectTools");
  assert.match(reconnect, /await invoke\("reload_sidecar"\);/);
  assert.match(reconnect, /streamingConvIds\.size > 0 && !window\.confirm\(/);
});

test("o2: 레일 — 심볼 · ＋ · 🔍 · 📚 · ⚡ · ● · ⚙, Ctrl+B, 1100px 미만 자동·오버레이", () => {
  const rail = fnBody(sidebar, "renderRail");
  const order = ['aria-label="사이드바 펼치기"', 'aria-label="새 대화"', 'aria-label="검색"', 'aria-label="라이브러리"', 'aria-label="작업"', "sb-rail-grow", "aria-label={connLabel}", 'aria-label="설정"'];
  let at = -1;
  for (const s of order) { const i = rail.indexOf(s); assert.ok(i > at, `레일 순서: ${s}`); at = i; }
  assert.match(rail, /onClick=\{\(\) => \{ setSearchOpen\(true\); onToggleRail\?\.\(\); \}\}/);
  assert.match(app, /const \[narrowWindow, setNarrowWindow\] = useState\(\(\) => window\.innerWidth < 1100\);/);
  assert.match(app, /localStorage\.getItem\("kda_sidebar_rail"\) === "1"/);
  assert.match(app, /setProperty\("--sidebar-width", `\$\{sidebarRail \|\| sidebarOverlay \? 56 : sidebarWidth\}px`\)/);
  assert.match(app, /<div className=\{`app\$\{sidebarRail \? " app--sidebar-rail" : ""\}\$\{sidebarOverlay \? " app--sidebar-overlay" : ""\}`\}>/);
  assert.match(app, /\{!sidebarRail && !sidebarOverlay && \(\n\s+<SidebarResizer/);
  assert.match(css, /:root\[data-layout="o2"\] \.app\.app--sidebar-overlay \.sidebar \{\n  position: fixed;/);
  assert.match(css, /@media \(max-width: 1100px\) \{\n  :root\[data-layout="o2"\] \.app \{ grid-template-columns: var\(--sidebar-width, 56px\) 1fr var\(--side-panel-width, 0px\); \}/);
  assert.match(sidebar, /\{isO2 \? \(\n\s+\/\/ v0\.7\.86 UI 6단계 — o2 는 심볼을 누르면 레일로 접힘 \(Ctrl\+B\)\n\s+<button type="button" className="brand-logo brand-logo-btn" onClick=\{onToggleRail\}/);
});

test("내보내기/백업/가져오기는 공용 유틸, 헤더 ⋯ '이 대화 내보내기'(o2)", () => {
  for (const fn of ["exportConversationToFile", "exportAllConversationsToFile", "importConversationsFromFile"]) {
    assert.match(backup, new RegExp(`export async function ${fn}\\(`));
  }
  assert.doesNotMatch(sidebar, /@tauri-apps\/plugin-dialog/);
  assert.match(sidebar, /const handleExportCurrent = \(\) => exportConversationToFile\(activeConversationId\);/);
  assert.match(sidebar, /const handleImport = \(\) => importConversationsFromFile\(onRefreshConversations\);/);
  assert.match(chat, /onExportConversation && \["📤 이 대화 내보내기", onExportConversation\],/);
  assert.match(app, /onExportConversation=\{isO2 && activeConversationId \? handleExportActiveConversation : undefined\}/);
});
