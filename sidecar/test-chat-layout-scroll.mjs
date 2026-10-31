// v0.7.49 — 채팅창 레이아웃/스크롤 회귀 테스트 (정적, 빌드 불필요).
//
// 1) .app 은 3열 CSS grid(sidebar | main | side-panel) 다. grid-area 도 position:fixed 도 없는
//    직계 자식이 생기면 암묵 행이 만들어져 왼쪽 아래(사이드바 열)에 끼고 채팅창 높이를 줄인다.
//    (실사고: '작업 결과 확인 대기' / '응답 90초 정체' 배너.) → 모든 직계 자식을 분류해 검사.
// 2) 채팅 목록 성능: 목록은 memo 컴포넌트로 분리, Virtuoso components 는 모듈 상수,
//    '맨 아래로'/자동 따라가기는 smooth 금지 (스트리밍 중 바닥 미도달 실측).
// 실행: node test-chat-layout-scroll.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf-8").replace(/\r\n/g, "\n");
const app = read("src/App.tsx");
const chat = read("src/components/MainChat.tsx");
const css = read("src/App.css") + "\n" + read("src/index.css");

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

function cssRule(cls) {
  const m = new RegExp(`(?:^|\\n)\\.${cls.replace(/-/g, "\\-")}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? m[1] : null;
}
const cssIsFixed = (cls) => /position:\s*fixed/.test(cssRule(cls) ?? "");
const cssHasArea = (cls) => /grid-area:\s*[\w-]+/.test(cssRule(cls) ?? "");

// ── 1. .app 직계 자식 분류 ───────────────────────────────────────────────
console.log("\n[1] .app grid 직계 자식 — grid-area 또는 position:fixed 필수");
const start = app.indexOf('\n    <div className="app">\n');
const end = app.indexOf("\n    </div>\n", start);
check(".app 루트 블록 탐지", start > 0 && end > start);
const body = app.slice(start, end).split("\n").slice(2);
// 6칸 들여쓰기에서 시작하는 직계 자식 블록으로 자른다 (주석 제외).
const chunks = [];
for (const line of body) {
  if (/^      [<{]/.test(line) && !/^      \{\/\*/.test(line)) chunks.push([line]);
  else if (chunks.length) chunks[chunks.length - 1].push(line);
}
// 컴포넌트 → 근거(루트가 grid-area 또는 fixed 인 것을 확인한 클래스).
const COMPONENT_ROOT = {
  UpdateChecker: { cls: "update-banner", kind: "fixed" },
  SidebarResizer: { cls: "sidebar-resizer", kind: "fixed" },
  Sidebar: { cls: "sidebar", kind: "area" },
  MainChat: { cls: "main-chat", kind: "area" },
  MetricsPanel: { cls: "metrics", kind: "area" },
  SidePanel: { cls: "side-panel", kind: "area" },
  Settings: { cls: "settings-overlay", kind: "fixed" },
  ElicitationDialog: { cls: "elicitation-overlay", kind: "fixed" },
  CodexElicitationDialog: { cls: "elicitation-overlay", kind: "fixed" },
  ApprovalRequests: { cls: "elicitation-overlay", kind: "fixed" },
  CommandPalette: { cls: "command-palette-overlay", kind: "fixed" },
  LibraryPanel: { inlineFixedIn: "src/components/LibraryPanel.tsx" },
  FolderInstructionsDialog: { inlineFixedIn: "src/components/FolderInstructionsDialog.tsx" },
};
const bad = [];
for (const lines of chunks) {
  const text = lines.join("\n");
  const head = lines[0].trim();
  // 첫 JSX 엘리먼트 (조건부 블록이면 그 안의 첫 태그)
  const tag = /<([A-Za-z][\w.]*)/.exec(text)?.[1] ?? "";
  if (/^[A-Z]/.test(tag)) {
    const rule = COMPONENT_ROOT[tag];
    if (!rule) { bad.push(`${tag}: 미분류 컴포넌트 (루트 위치 확인 후 COMPONENT_ROOT 에 등록)`); continue; }
    if (rule.inlineFixedIn) {
      if (!/position:\s*"fixed"/.test(read(rule.inlineFixedIn))) bad.push(`${tag}: 루트 inline position:fixed 없음`);
      continue;
    }
    const ok = rule.kind === "fixed" ? cssIsFixed(rule.cls) : cssHasArea(rule.cls);
    if (!ok) bad.push(`${tag}: .${rule.cls} 에 ${rule.kind === "fixed" ? "position: fixed" : "grid-area"} 없음`);
    continue;
  }
  // 일반 div: inline position fixed 또는 fixed 클래스
  const firstDiv = /<div[\s\S]*?>/.exec(text)?.[0] ?? "";
  const inlineFixed = /position:\s*"fixed"/.test(firstDiv);
  const cls = /className="([\w-]+)/.exec(firstDiv)?.[1];
  if (!inlineFixed && !(cls && (cssIsFixed(cls) || cssHasArea(cls)))) {
    bad.push(`${head.slice(0, 60)} → <div className="${cls ?? ""}"> 가 grid 흐름에 들어감`);
  }
}
check(`직계 자식 ${chunks.length}개 모두 grid-area/fixed`, bad.length === 0, bad.join(" | "));
check("직계 자식 탐지 수가 현실적 (>= 15)", chunks.length >= 15, `got ${chunks.length}`);

// ── 2. 배너는 MainChat notices 로 ────────────────────────────────────────
console.log("\n[2] 작업 대기/정체 배너는 채팅창 안 (notices)");
const mainChatOpen = app.indexOf("      <MainChat\n");
const noticesStart = app.indexOf("notices={<>", mainChatOpen);
const noticesEnd = app.indexOf("</>}", noticesStart);
const noticesBlock = app.slice(noticesStart, noticesEnd);
check("MainChat 에 notices prop", mainChatOpen > 0 && noticesStart > mainChatOpen && noticesEnd > noticesStart);
check("task-watch-waiting 배너가 notices 안", /task-watch-waiting/.test(noticesBlock) && /watchBlockLabel\(w\.reason\)/.test(noticesBlock));
check("응답 정체 배너가 notices 안", /isStreaming && streamStalled/.test(noticesBlock));
check("notices 바깥(.app 직계)에 두 배너 없음",
  app.split("task-watch-waiting").length === 2 && app.split("isStreaming && streamStalled").length === 2);
check("MainChat 이 notices 를 chat-notices 로 렌더", /notices \? <div className="chat-notices">\{notices\}<\/div> : null/.test(chat));
check(".chat-notices 높이 상한 + 내부 스크롤", /max-height:\s*30vh/.test(cssRule("chat-notices") ?? "") && /overflow-y:\s*auto/.test(cssRule("chat-notices") ?? ""));

// ── 3. 목록 성능 구조 ─────────────────────────────────────────────────────
console.log("\n[3] 채팅 목록 재렌더/스크롤 구조");
check("MessageList memo 분리", /const MessageList = memo\(function MessageList/.test(chat));
check("MainChat 본문에 Virtuoso 직접 렌더 없음 (MessageList 경유)",
  (chat.match(/<Virtuoso\b/g) ?? []).length === 1 && /<MessageList\b/.test(chat));
check("visibleMessages useMemo", /useMemo\(\s*\(\) => filterMessagesForBody\(messages, showToolCards\),\s*\[messages, showToolCards\]/.test(chat));
check("Virtuoso components 모듈 상수 (인라인 금지)", /components=\{VIRTUOSO_COMPONENTS\}/.test(chat) && !/components=\{\{/.test(chat));
check("itemContent / followOutput / atBottomStateChange 안정 참조",
  /itemContent=\{itemContent\}/.test(chat) && /followOutput=\{followOutput\}/.test(chat) && /atBottomStateChange=\{atBottomStateChange\}/.test(chat));
check("smooth 스크롤 미사용 (맨 아래로 / 자동 따라가기)", !/behavior:\s*"smooth"/.test(chat) && !/\?\s*"smooth"/.test(chat));
check("맨 아래로: 즉시 이동 + rAF 보정", /scrollToIndex\(\{ index: "LAST", behavior: "auto", align: "end" \}\);\n\s*requestAnimationFrame/.test(chat));

console.log(`\n결과: ${pass}/${pass + fail} 통과`);
process.exit(fail === 0 ? 0 : 1);
