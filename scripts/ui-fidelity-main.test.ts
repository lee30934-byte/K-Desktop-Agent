// v0.7.86 UI 목업 충실도 fidA — 메인 화면(셸 · 사이드바 · 헤더 · 알림 띠 · 메시지 · 입력창 · 빈 화면 · 아바타 기본 위치).
// 기준: evidence/ui-redesign-20261111/mockup.html. o2 만 바뀌고 classic 은 그대로인지, 개발용 픽스처가 배포 빌드에서 꺼져 있는지 확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = read("../src/App.tsx");
const sidebar = read("../src/components/Sidebar.tsx");
const chat = read("../src/components/MainChat.tsx");
const composer = read("../src/components/Composer.tsx");
const message = read("../src/components/Message.tsx");
const tasks = read("../src/components/TaskActivityPanel.tsx");
const notice = read("../src/components/TaskWatchNotice.tsx");
const ring = read("../src/components/ContextRing.tsx");
const fixtureSrc = read("../src/dev/mockupFixture.ts");
const fid = read("../src/styles/o2-fidelity.css");

const fnBody = (src: string, name: string) => {
  const start = src.indexOf(`const ${name} = `);
  assert.ok(start > 0, `${name} 없음`);
  const next = src.indexOf("\n  const ", start + 10);
  return src.slice(start, next > 0 ? next : undefined);
};

test("개발용 목업 픽스처 — 배포 빌드(DEV=false)에서는 주소에 ?fixture=mockup 이 있어도 꺼짐", async () => {
  const fx = await import("../src/dev/mockupFixture");
  assert.equal(fx.readMockupFixture({ DEV: false }, "?fixture=mockup"), null);
  assert.equal(fx.readMockupFixture(undefined, "?fixture=mockup"), null, "env 없음(=vite 밖)도 꺼짐");
  assert.equal(fx.mockupFixtureEnabled({ DEV: true }, ""), false);
  assert.equal(fx.mockupFixtureEnabled({ DEV: true }, "?fixture=other"), false);
  assert.equal(fx.mockupFixtureEnabled({ DEV: true }, "?layout=o2&fixture=mockup"), true);
  assert.equal(fx.devLayoutOverride({ DEV: false }, "?layout=classic"), null, "배포 빌드는 ?layout 무시");
  assert.equal(fx.devLayoutOverride({ DEV: true }, "?layout=classic"), "classic");
  assert.equal(fx.devLayoutOverride({ DEV: true }, "?layout=weird"), null);
  // 조건은 import.meta.env.DEV (vite 가 배포 빌드에서 false 로 바꿈)
  assert.match(fixtureSrc, /\(import\.meta as unknown as \{ env\?: ViteEnv \}\)\.env/);
  assert.match(fixtureSrc, /if \(!env\?\.DEV\) return false;/);
});

test("픽스처 데이터 — 목업과 같은 예시 (고정 대화 · 폴더 · 표 · 파일 칩 · 알림 · 컨텍스트 72% · 실행 2개)", async () => {
  const fx = (await import("../src/dev/mockupFixture")).readMockupFixture({ DEV: true }, "?fixture=mockup")!;
  assert.ok(fx);
  assert.equal(fx.conversations.filter((c) => c.isFavorite).length, 2);
  assert.deepEqual(fx.folders.filter((f) => f.parentId === fx.currentFolderId).map((f) => f.name), ["디자인", "클라이언트 A · 계약", "세무·영수증"]);
  const text = fx.messages.map((m) => m.content).join("\n");
  assert.match(text, /\| 대상 \| 현재 \| 새 이름 \|/);
  assert.match(text, /\[design-spec\.md\]\(evidence\/ui-redesign-20261111\/design-spec\.md\)/);
  assert.equal(fx.streamingIds.length, 2);
  assert.equal(fx.contextRatio, 0.72);
  assert.ok(fx.waiting.every((w) => w.conversationId === fx.activeConversationId));
});

test("App — 픽스처는 메모리 상태만 채운다 (DB·invoke·localStorage 쓰기 없음), 픽스처 중엔 활성 대화 저장도 건너뜀", () => {
  const start = app.indexOf("const mockupFixture = useMemo(() => readMockupFixture(), []);");
  assert.ok(start > 0);
  const block = app.slice(start, app.indexOf("}, [mockupFixture, dbReady]);", start));
  assert.doesNotMatch(block, /localStorage|invoke\(|createConversation|saveMessage|updateConversation/);
  assert.match(app, /if \(dbReady && activeConversationId && !mockupFixture\) \{\n\s+try \{ localStorage\.setItem\(ACTIVE_CONVERSATION_KEY/);
  assert.match(app, /engineLabel=\{\(\(\) => \{\n\s+if \(mockupFixture\) return mockupFixture\.engineLabel;/);
  assert.match(app, /import "\.\/App\.css";\n[^\n]*\nimport "\.\/styles\/o2-fidelity\.css";/, "o2-fidelity.css 는 App.css 다음");
});

test("o2-fidelity.css — 모든 규칙이 :root[data-layout=\"o2\"] 로 한정 (classic 은 영향 없음)", () => {
  const noComments = fid.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...noComments.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1].trim()).filter(Boolean);
  assert.ok(selectors.length > 60, `규칙 수 ${selectors.length}`);
  for (const sel of selectors) {
    for (const part of sel.split(/,(?![^(]*\))/)) {
      assert.match(part.trim(), /^:root\[data-layout="o2"\]/, `o2 한정 아님: ${part.trim()}`);
    }
  }
});

test("셸·헤더·입력창 치수 — 목업 값 (맞붙은 면, 헤더 48px, 열 760, 카드 반경 16, 전송 32px)", () => {
  assert.match(fid, /:root\[data-layout="o2"\] \.app \{ gap: 0; padding: 0;/);
  assert.match(fid, /:root\[data-layout="o2"\] \.sidebar \{\n\s+border: 0; border-right: 1px solid var\(--line\); border-radius: 0;/);
  assert.match(fid, /:root\[data-layout="o2"\] \.main-chat \{ border: 0; border-radius: 0;/);
  assert.match(fid, /height: var\(--header-h\);[^}]*padding: 0 12px 0 20px; border-bottom: 1px solid var\(--line\);/);
  assert.match(fid, /--o2-bubble-user: #1b212c;/);
  assert.match(fid, /\.chat-col > \.msg-user \{[^}]*max-width: 78%;[^}]*border-radius: var\(--radius-bubble\);/);
  assert.match(fid, /\.composer-actions \.composer-btn-send--icon \{ width: 32px; height: 32px; border-radius: 10px; \}/);
  assert.match(fid, /\.chat-notices--top \{[^}]*margin: 10px 20px 0;/);
});

test("사이드바 o2 — 경로 글자(루트 › 업무) · ★ 고정 · 폴더/대화 묶음 · 작은 빈 안내 · Ctrl+N (classic 탐색기는 그대로)", () => {
  const ex = fnBody(sidebar, "renderO2Explorer");
  assert.match(ex, /className="sb-crumb explorer-breadcrumb"/);
  assert.match(ex, /<BreadcrumbDropButton plain dropId="__root__"/, "루트에 끌어다 놓기 유지");
  assert.match(ex, /<Icon name="chevronRight" size=\{14\} \/>/);
  assert.match(ex, /const pinned = conversations\.filter\(\(c\) => c\.isFavorite && hit\(c\)\);/);
  // dzA (E) — 묶음: 고정됨 → 폴더(renderSectionHead 머리 · 하위 폴더면 경로 줄) → 최근
  assert.match(ex, /\{pinned\.length > 0 && <div className="sb-grp-label">고정됨<\/div>\}/);
  assert.match(ex, /\{renderSectionHead\(\)\}\n\s+\{currentFolderId !== null && \(\n\s+<nav className="sb-crumb explorer-breadcrumb"/);
  assert.match(ex, /\{rest\.length > 0 && <div className="sb-grp-label">최근<\/div>\}/);
  assert.match(ex, /className="sb-empty"/);
  assert.doesNotMatch(ex, /📁\+|상단의/u, "o2 는 상자형 [📁+] 안내 없음");
  assert.match(ex, /className="bulk-organize-bar sb-bulk"/, "여러 대화 선택 바 유지");
  assert.match(sidebar, /\{isO2 && viewMode === "explorer" \? renderO2Explorer\(\) : viewMode === "explorer" \? \(\n\s+renderExplorer\(\)/);
  // classic 탐색기는 무수정 (상자형 안내 · ↑ 버튼 그대로)
  const classic = fnBody(sidebar, "renderExplorer");
  assert.doesNotMatch(classic, /isO2/);
  assert.match(classic, /상단의 \[📁\+\] 또는 \[\+ 새 대화\] 로 시작하세요/);
  assert.match(classic, /title="위로 가기 \(Backspace\)"/);
  // Ctrl+N 은 o2 에서만
  assert.match(sidebar, /useEffect\(\(\) => \{\n\s+if \(!isO2\) return;\n\s+const onKey = \(e: KeyboardEvent\) => \{\n\s+if \(\(e\.ctrlKey \|\| e\.metaKey\) && !e\.shiftKey && !e\.altKey && e\.key\.toLowerCase\(\) === "n"\)/);
  // 행 인라인 스타일은 classic 에만
  assert.match(sidebar, /className="explorer-item explorer-folder"\n\s+style=\{isO2 \? undefined : \{/);
  assert.match(sidebar, /style=\{isO2 \? undefined : \{\n\s+display: "flex",\n\s+alignItems: "center",\n\s+gap: 10,\n\s+padding: "8px 10px",\n\s+borderRadius: 6,\n\s+cursor: "pointer",\n\s+userSelect: "none",\n\s+background: active \|\| selected/);
});

test("헤더 o2 — 제목 한 줄 + 엔진 칩(모델 흐리게) + 폴더 경로 · 구분선 · 작업 칩 '⚡ n 실행 · n 예약'", () => {
  assert.match(chat, /<EngineChipLabel label=\{engineLabel\} \/>\n\s+<Icon name="chevronDown" size=\{14\} \/>/);
  assert.match(chat, /function EngineChipLabel\(\{ label \}: \{ label: string \}\) \{\n\s+const at = label\.indexOf\(" · "\);/);
  assert.match(chat, /\{isO2 && <span className="main-header-sep" aria-hidden="true" \/>\}/);
  assert.match(app, /return names\.length \? names\.join\(" \/ "\) : undefined;/, "폴더 경로 '업무 / 디자인'");
  assert.match(tasks, /if \(mode === "chip"\) return <aside className="task-activity" aria-label="대화별 작업 현황">\n\s+<button className="task-activity-toggle task-activity-toggle--chip"/);
  assert.match(tasks, /<strong className="n">\{active\.length\}<\/strong> 실행/);
  // popover(classic)·inline 은 예전 문구 그대로
  assert.match(tasks, /작업 현황 <strong>\{active\.length\} 실행<\/strong>/);
});

test("알림 띠 o2 — 헤더 아래 한 줄(확인 완료 · 외 N건 ⌄), classic 은 예전 위치·모양", () => {
  assert.match(chat, /\{isO2 && notices \? <div className="chat-notices chat-notices--top" ref=\{noticesRef\}>\{notices\}<\/div> : null\}/);
  assert.match(chat, /\{!isO2 && notices \? <div className="chat-notices">\{notices\}<\/div> : null\}/);
  assert.match(app, /\{isO2 && visibleTaskWatchWaiting\.length > 0 && \(\n\s+<TaskWatchNotice /);
  assert.match(app, /\{!isO2 && visibleTaskWatchWaiting\.length > 0 && \(\n\s+<Notice tone="warn" role="status" className="task-watch-waiting"/);
  assert.match(notice, /className="task-watch-waiting task-watch-waiting--o2"/);
  assert.match(notice, /onClose=\{onDismiss\} closeLabel="이 알림 숨김 · 작업 감시는 계속됨"/, "숨김 기능 유지");
  assert.match(notice, /외 \{rest\.length\}건<Icon name="chevronDown" size=\{14\} \/>/);
  assert.match(notice, /className="task-watch-resolve" onClick=\{\(\) => onResolve\(first\)\}/);
});

test("메시지 o2 — 파일 링크는 파일 칩, 답변 아래 복사, 기본 문서형 (classic 은 렌더 그대로)", () => {
  assert.match(message, /if \(isO2 && href && !isUrl\(href\) && mediaKind !== "video" && mediaKind !== "audio"/);
  assert.match(message, /<span className="md-file-chip__hint">· 클릭하면 미리보기<\/span>/);
  assert.match(message, /\{isO2 && isAssistant && !isStreaming && \(\n\s+<div className="msg-actbar"/);
  assert.match(fid, /\.chat-col \.markdown-content th \{ padding: 6px 10px; font-weight: 500; color: var\(--fg-subtle\);/);
});

test("입력창 o2 — 넛지 문구 · 카드 위 순서 · 낮은 기본 높이 (classic 은 100px)", () => {
  assert.match(ring, /사용 중 · 응답이 느려질 수 있어요/);
  assert.match(composer, /return isO2 \? 60 : 100;/);
  assert.match(fid, /\.composer-wrapper > \.context-nudge \{ order: 0; \}/);
  assert.match(fid, /\.composer-wrapper > \.composer \{ order: 4; \}/);
});

test("비서 아바타 o2 — 기본 위치는 헤더·알림 띠 아래(--o2-chrome-bottom), 끌어 옮긴 위치는 그대로", () => {
  assert.match(chat, /root\.style\.setProperty\("--o2-chrome-bottom", `\$\{Math\.round\(bottom\)\}px`\);/);
  assert.match(fid, /:root\[data-layout="o2"\] \.companion-widget:not\(\[style\*="left"\]\) \{\n\s+top: calc\(var\(--o2-chrome-bottom, 100px\) \+ 12px\);/);
  // 메시지 열·입력창은 아바타 예약 폭을 그대로 비켜 간다
  assert.match(fid, /:root\[data-layout="o2"\]\[data-companion-reserve\] \.main-chat \.messages \{ padding: 0 var\(--companion-reserve, 0px\) 0 0; \}/);
  assert.match(fid, /var\(--o2-composer-reserve\)/);
});
