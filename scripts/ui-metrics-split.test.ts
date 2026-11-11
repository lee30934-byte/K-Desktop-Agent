// v0.7.86 UI 개편 5단계 — MetricsPanel 해체 회귀 테스트 (evidence/ui-redesign-20261111/design-spec.md 4.5, 8장 5단계).
// o2: 컨텍스트는 입력창 링(+팝오버, 70% 넛지), 나머지는 슬라이드오버 '세션·사용량' 탭. 하단 metrics 행 없음.
// classic: 예전 MetricsPanel footer 와 metrics 그리드 행 그대로. 세션 버튼 2개는 어느 쪽이든 같은 핸들러.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = read("../src/App.tsx");
const css = read("../src/App.css");
const ring = read("../src/components/ContextRing.tsx");
const panel = read("../src/components/SessionUsagePanel.tsx");
const shared = read("../src/components/metricsShared.tsx");
const metrics = read("../src/components/MetricsPanel.tsx");
const composer = read("../src/components/Composer.tsx");
const chat = read("../src/components/MainChat.tsx");

test("classic: MetricsPanel footer 는 classic 에서만, 같은 props 로", () => {
  assert.match(app, /\{!isO2 && <MetricsPanel \{\.\.\.usageProps\} \/>\}/);
  assert.equal((app.match(/<MetricsPanel\b/g) ?? []).length, 1);
  // classic 그리드(metrics 행)는 기본 .app 규칙에 그대로
  assert.match(css, /\.app \{[^}]*grid-template-areas:\s*"sidebar main\s+side-panel"\s*"sidebar metrics side-panel";/);
  assert.match(css, /\.metrics \{\n  grid-area: metrics;/);
  for (const k of ["onManualRefresh: triggerSessionRefresh", "onCompressContext: handleCompressContext", "onRetryCodexUsage: pollCodexUsage",
    "rateLimit: activeRateLimit", "codexUsageError: activeCodexUsageError"]) {
    assert.ok(app.includes(k), k);
  }
});

test("o2: .app 그리드에서 metrics 행 제거", () => {
  assert.match(css, /:root\[data-layout="o2"\] \.app \{\n  grid-template-rows: 1fr;\n  grid-template-areas: "sidebar main side-panel";\n\}/);
  assert.match(css, /:root\[data-layout="o2"\] \.app \{ grid-template-areas: "main"; \}/);
});

test("o2: 입력창 컨텍스트 링 + 70% 넛지 (classic 은 슬롯 없음)", () => {
  assert.match(app, /const composerContext = useMemo\(\(\) => !isO2 \? undefined : \(\n    <ContextRing/);
  assert.match(app, /const composerNudge = useMemo\(\(\) => !isO2 \? undefined : \(\n    <ContextNudge/);
  assert.match(app, /onOpenSessionPanel=\{\(\) => setRightPanel\("session"\)\}/);
  assert.match(chat, /contextSlot=\{composerContext\}\n\s+contextNudge=\{composerNudge\}/);
  assert.match(composer, /\{contextNudge\}\n\s+\{isStreaming && <div className="composer-steering-bar">/);
  // 7단계: 링 바로 뒤가 o2 버튼 묶음(composer-actions)
  assert.match(composer, /\{contextSlot\}\n\n\s+\{isO2 \? \(\n\s+<div className="composer-actions">/);
  // 링: 60/80% 색 경계, 팝오버 요약 + 세션 버튼 2개(같은 핸들러) + 자세히
  assert.match(ring, /if \(overflowed \|\| pct >= 80\) return "danger";\n  if \(pct >= 60\) return "warn";/);
  assert.match(ring, /<Popover open=\{open\}/);
  assert.match(ring, /onClick=\{\(\) => \{ onManualRefresh\(\); close\(\); \}\}/);
  assert.match(ring, /onClick=\{\(\) => \{ onCompressContext\(\); close\(\); \}\}/);
  assert.match(ring, /세션·사용량 자세히/);
  // 넛지: 70% 이상, fidA 목업 문구 '컨텍스트 n% 사용 중 · 응답이 느려질 수 있어요  [↻ 새 세션으로 이어가기]'
  assert.match(ring, /const high = u\.contextUsage >= 70;/);
  assert.match(ring, /컨텍스트 <span className="context-nudge__pct mono">\{Math\.round\(u\.contextUsage\)\}%<\/span> 사용 중 · 응답이 느려질 수 있어요/);
  assert.match(ring, /<Icon name="rotate" size=\{14\} \/>새 세션으로 이어가기\n/);
  // 매초 tick 은 SessionElapsed 만 (팝오버가 열렸을 때만)
  assert.match(ring, /<SessionElapsed startedAt=\{metrics\.startedAt\} active=\{open\} \/>/);
  assert.doesNotMatch(ring, /setInterval/);
});

test("o2: 슬라이드오버 '세션·사용량' 탭에 SessionUsagePanel", () => {
  assert.match(app, /\["session", "세션·사용량"\]/);
  assert.match(app, /<div id="right-pane-session" role="tabpanel" className="right-pane right-pane--session" hidden=\{rightPanel !== "session"\}>\n\s+<SessionUsagePanel \{\.\.\.usageProps\} active=\{rightPanel === "session"\} \/>/);
  for (const s of ["↻ 새 세션으로 이어가기", "📦 요약해서 새 대화로 이어가기", "이번 세션", "사용 한도", "재시도", "Raw 보기", "분모 출처", "최근 턴 raw", "매칭"]) {
    assert.ok(panel.includes(s), s);
  }
  assert.match(panel, /onClick=\{\(\) => onManualRefresh\(\)\}/);
  assert.match(panel, /onClick=\{\(\) => onCompressContext\(\)\}/);
  assert.match(panel, /onClick=\{\(\) => onRetryCodexUsage\(\)\}/);
  assert.doesNotMatch(panel, /setInterval/);
  assert.doesNotMatch(panel + ring, /세션 초기화|대화 초기화|대화 압축 &/);
});

test("o2: ⋯ 메뉴 '세션·사용량 보기' + 한도 80% 주의 칩", () => {
  assert.match(app, /onOpenSession=\{isO2 \? \(\) => setRightPanel\("session"\) : undefined\}/);
  assert.match(chat, /onOpenSession && \["세션·사용량 보기", onOpenSession\]/);
  assert.match(app, /w\.used_pct >= 80\)/);
  assert.match(app, /\.\.\.rateLimitWarnings,/);
});

test("계산 공유: MetricsPanel·링·세션 탭이 같은 computeContextUsage", () => {
  assert.match(shared, /export function computeContextUsage/);
  for (const src of [metrics, ring, panel]) assert.match(src, /computeContextUsage\(\{ metrics, maxContextTokens, estimatedContextTokens \}\)/);
  assert.match(metrics, /import \{ RateLimitCard, computeContextUsage/);
});
