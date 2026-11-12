// v0.7.86 UI 목업 충실도 fidB — 우측 슬라이드오버와 탭 (미리보기 · 작업 · 세션·사용량 · 비서).
// 기준: evidence/ui-redesign-20261111/mockup.html (.so-tabs · .sect · .box · .sbtn · .stats · .lim · .task · .so-foot).
// o2 만 바뀌고 classic(예전 SidePanel · 작업 팝오버 · MetricsPanel)은 그대로인지, 개발용 ?panel= 이 배포 빌드에서 꺼져 있는지 확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = read("../src/App.tsx");
const panel = read("../src/components/SessionUsagePanel.tsx");
const tasks = read("../src/components/TaskActivityPanel.tsx");
const side = read("../src/components/SidePanel.tsx");
const prim = read("../src/ui/primitives.tsx");
const shared = read("../src/components/metricsShared.tsx");
const css = read("../src/styles/o2-slideover.css");
const fixtureSrc = read("../src/dev/mockupFixture.ts");

test("개발용 ?panel= · 픽스처 패널 데이터 — 배포 빌드(DEV=false)에서는 꺼짐", async () => {
  const fx = await import("../src/dev/mockupFixture");
  assert.equal(fx.devPanelOverride({ DEV: false }, "?panel=session"), null);
  assert.equal(fx.devPanelOverride(undefined, "?panel=tasks"), null);
  assert.equal(fx.devPanelOverride({ DEV: true }, "?panel=weird"), null);
  for (const p of ["preview", "tasks", "session", "assistant"] as const) assert.equal(fx.devPanelOverride({ DEV: true }, `?panel=${p}`), p);
  assert.equal(fx.readMockupFixture({ DEV: false }, "?fixture=mockup&panel=session"), null);
  const on = fx.readMockupFixture({ DEV: true }, "?fixture=mockup")!;
  // 목업 값: gpt-5 · 200K, 144,210 토큰(72%), 턴 18 · 도구 42, 5시간 84% · 주간 37%, 실행 2 · 예약 1
  assert.equal(on.panel.maxContextTokens, 200_000);
  assert.equal(on.panel.metrics.maxTurnContextTokens, 144_210);
  assert.equal(on.panel.metrics.turnCount, 18);
  assert.equal(on.panel.rateLimit.primary?.used_pct, 84);
  assert.equal(on.panel.rateLimit.secondary?.used_pct, 37);
  assert.equal(on.panel.runs.length, 2);
  assert.equal(on.panel.queue.length, 1);
  // App 은 배포 빌드에서 null 인 값으로만 덮는다 (DB·localStorage 쓰기 없음)
  assert.match(app, /const dev = devPanelOverride\(\); \/\/ fidB/);
  assert.match(app, /const ctxMax = mockupFixture\?\.panel\.maxContextTokens \?\? currentModelMaxTokens;/);
  assert.match(app, /const activeRateLimit = mockupFixture \? mockupFixture\.panel\.rateLimit :/);
  assert.match(app, /devPanelOverride\(\) === "preview" \? readMockupFixture\(\)\?\.panel\.preview : undefined/);
  assert.doesNotMatch(fixtureSrc, /localStorage\.setItem|invoke\(/);
});

test("탭 줄 — 글자 탭 + 강조색 밑줄, 오른쪽 핀·닫기 14px, 아래 줄 'Esc로 닫기 · 폭 420~640 조절'", () => {
  assert.match(css, /\.right-slideover \.ui-tab \{\n  height: 34px; padding: 0 10px; margin-bottom: -1px; border: 0; border-bottom: 2px solid transparent; border-radius: 0;/);
  assert.match(css, /\.ui-tab\[aria-selected="true"\] \{\n  background: transparent; color: var\(--fg\); border-bottom-color: var\(--accent\); font-weight: 500;/);
  assert.match(css, /\.ui-slideover__head \{\n  height: auto; align-items: flex-end; gap: 2px; padding: 8px 8px 0 10px;/);
  // dzA — 개발자 문구 없이 [Esc] 닫기 · 가장자리를 끌어 폭 조절
  assert.match(app, /<span className="so-foot-hint"><kbd className="o2-kbd">Esc<\/kbd>닫기<\/span>/);
  assert.match(app, /\{rightPanel !== "tasks" && <span className="so-foot-hint">가장자리를 끌어 폭 조절<\/span>\}/);
  assert.doesNotMatch(app, /폭 420~640 조절/);
  assert.match(prim, /\{footer && <footer className="ui-slideover__foot">\{footer\}<\/footer>\}/);
  // 목업 .slide: 헤더 아래에서 시작 + 본문 덮개(누르면 닫힘). 고정 📌 이면 덮개 없음
  assert.match(css, /:root\[data-layout="o2"\] \.right-slideover \{\n  top: var\(--header-h, 48px\);/);
  assert.match(app, /\{isO2 && rightPanel !== null && !\(slideOverPinned && wideWindow\) && \(\n\s+<div className="right-slideover-scrim" aria-hidden="true" onClick=\{closeRightPanel\} \/>/);
});

test("세션·사용량 — 큰 % 카드(70 주황 · 85 빨강), 토큰 n / 분모, 3칸, 분모 출처·모델 매칭", () => {
  // dzA (D) — 80% 미만 무채색 · 80~89 주황 · 90+ 빨강, '여유 적음' 배지는 80% 부터
  assert.match(panel, /const pctTone = u\.contextOverflowed \|\| u\.contextUsage >= 90 \? "danger" : u\.contextUsage >= 80 \? "warn" : "neutral";/);
  assert.match(panel, /\{known && pctTone !== "neutral" && <span className=\{`so-tag so-tag--\$\{pctTone\} so-big__lvl`\}>여유 적음<\/span>\}/);
  assert.match(panel, /<span className="so-sect__c mono">\{currentModel \|\| "—"\} · \{windowLabel\(maxContextTokens\)\}<\/span>/);
  assert.match(panel, /`\$\{num\(u\.displayContext\)\} \/ \$\{num\(maxContextTokens\)\} 토큰`/);
  for (const s of ["남은 양", "최근 턴", "측정 방식", "분모 출처", "모델 매칭", "추정 (참고)", "최근 턴 raw"]) assert.ok(panel.includes(s), s);
  // 모르면 '—'
  assert.match(panel, /turnDelta == null \? "—"/);
  // 계산은 여전히 공용 computeContextUsage 하나
  assert.match(panel, /computeContextUsage\(\{ metrics, maxContextTokens, estimatedContextTokens \}\)/);
});

test("세션 이어가기 — 무채색 카드 2개(아이콘 칸), 권장일 때만 강조 테두리, 같은 핸들러", () => {
  assert.match(panel, /className=\{`so-sbtn context-refresh-btn\$\{recommendRefresh \? " is-primary" : ""\}`\}\n\s+onClick=\{\(\) => onManualRefresh\(\)\}/);
  assert.match(panel, /className="so-sbtn context-compress-btn"\n\s+onClick=\{\(\) => onCompressContext\(\)\}/);
  assert.match(panel, /<Icon name="rotate" \/>/);
  assert.match(panel, /\{recommendRefresh && <span className="so-rec">추천<\/span>\}/);
  assert.match(panel, /<Icon name="split" \/>/);
  assert.match(panel, /같은 대화에서 계속 → <b>새 세션으로 이어가기<\/b><br \/>새 대화로 분리 → <b>요약해서 새 대화로 이어가기<\/b>/);
  // 주황 카드 없음
  assert.doesNotMatch(css, /\.so-sbtn[^{]*\{[^}]*warn/);
});

test("이번 세션 — 테두리 한 줄 5칸(턴/도구/입력/출력/경과 H:MM:SS), 컴퓨터 도구 줄은 작게", () => {
  assert.match(css, /\.so-stats \{\n  display: grid; grid-template-columns: repeat\(5, 1fr\); gap: 1px;/);
  for (const s of ["<span>턴</span>", "<span>도구</span>", "<span>입력</span>", "<span>출력</span>", "<span>경과</span>"]) assert.ok(panel.includes(s), s);
  assert.match(panel, /<SessionElapsed startedAt=\{metrics\.startedAt\} active=\{active\} clock \/>/);
  assert.match(shared, /export function formatClock\(ms: number\): string/);
  assert.match(panel, /컴퓨터 도구 \{mcpConnected \? "연결됨" : "끊김"\}/);
  assert.doesNotMatch(panel, /setInterval/);
});

test("사용 한도 — 카드 안 줄(라벨 · % · 막대 · 초기화 시각), 없으면 빈 안내, Codex 오류 재시도·Raw", async () => {
  assert.match(panel, /\{rateLimit\?\.primary && <LimitRow label="5시간" window=\{rateLimit\.primary\} \/>\}/);
  assert.match(panel, /\{rateLimit\?\.secondary && <LimitRow label="주간" window=\{rateLimit\.secondary\} \/>\}/);
  assert.match(panel, /아직 받은 한도 정보가 없어요\./);
  assert.match(panel, /onClick=\{\(\) => onRetryCodexUsage\(\)\}/);
  assert.match(panel, /showCodexRawPayload\(codexUsageRawPayload\)/);
  assert.match(panel, /return `오늘 \$\{hm\}에 초기화`;/);
});

test("작업 탭 — 실행 중 · 예약 · 결과 확인 대기 · 복구 가능한 작업 카드, 전체 작업 정지는 아래 줄", () => {
  assert.match(tasks, /if \(mode === "inline"\) return <section className="task-activity task-activity--inline" aria-label="대화별 작업 현황">\{inlineBody\(\)\}<\/section>;/);
  for (const s of ["실행 중", "예약", "이 작업 정지", "정지 재요청", "예약 이어서 실행", "목록에서 닫기", "새 대화 추가", "기존 대화 추가", "정지 불응 시 실행 엔진 복구", "자동 실행 허용"]) {
    assert.ok(tasks.includes(s), s);
  }
  assert.match(app, /<section className="so-sect" aria-label="결과 확인 대기">/);
  assert.match(app, /onClick=\{\(\) => \{ void resolveTaskWatchWaiting\(w\); \}\}/);
  assert.match(app, /<section className="so-sect recovery-panel" aria-label="복구 가능한 작업">/);
  assert.match(app, /\{rightPanel === "tasks" && \(\n\s+<button type="button" className="so-sm so-sm--dan" onClick=\{handleHardStop\}/);
  // 도구·안내는 맨 아래 (CSS order)
  assert.match(css, /\.right-pane--tasks \.so-tools \{ order: 10; \}/);
});

test("미리보기 · 비서 탭 — 같은 카드 언어 (파일 줄 + 기본 앱에서 열기, 비서 분할 버튼)", () => {
  assert.match(side, /\{embedded && <h5 className="so-sect__h">미리보기<\/h5>\}/);
  assert.match(side, /\{embedded \? "기본 앱에서 열기" : "🔗 외부 열기"\}/, "classic 은 예전 '🔗 외부 열기'");
  assert.match(side, /if \(fixturePreview\) \{/);
  assert.match(css, /\.is-hosted \.companion-tabs button\[aria-pressed="true"\] \{\n  background: rgba\(106, 161, 255, 0\.14\); color: #9cc0ff; font-weight: 500;/);
  assert.match(css, /\.is-hosted \.companion-home:not\(\[hidden\]\) \{ display: flex;/, "hidden 탭이 보이지 않게 :not([hidden])");
});

test("classic 은 그대로 — 슬라이드오버·덮개 없음, 예전 SidePanel · 작업 팝오버 · MetricsPanel", () => {
  // o2-slideover.css 의 모든 규칙은 o2 배치 아래
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((r) => r.trim()).filter((r) => r.includes("{"));
  for (const r of rules) {
    const sel = r.slice(0, r.indexOf("{"));
    // 괄호 밖 쉼표로만 나눈다 (:is(dt, dd) 같은 안쪽 쉼표는 같은 선택자)
    const parts: string[] = [];
    let depth = 0, cur = "";
    for (const ch of sel) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
    }
    parts.push(cur);
    for (const part of parts) assert.match(part.trim(), /^:root\[data-layout="o2"\]/, `o2 범위 밖 규칙: ${part.trim()}`);
  }
  assert.match(app, /\{!isO2 && <TaskActivityPanel \{\.\.\.taskPanelProps\} mode="popover" \/>\}/);
  assert.match(app, /\{!isO2 && <MetricsPanel \{\.\.\.usageProps\} \/>\}/);
  assert.match(app, /      \) : \(\n        <SidePanel\n          open=\{sidePanelOpen\}\n          onOpenChange=\{setSidePanelOpen\}\n          item=\{sidePanelItem\}\n          onClose=\{handleSidePanelClose\}\n        \/>/);
  // 작업 팝오버 본문(예전 문구·버튼)은 그대로
  assert.match(tasks, /<div className="task-activity-heading"><strong>대화별 작업<\/strong>\n\s+<button type="button" onClick=\{props\.onStopAll\} disabled=\{!active\.length && !queueCount\}>전체 작업 정지<\/button>/);
  assert.match(tasks, /\{busy && <button onClick=\{\(\) => props\.onStop\(id\)\}>\{run\?\.state === "stopping" \? "정지 재요청" : "이 대화 정지"\}<\/button>\}/);
  // SessionElapsed 기본 표기(classic footer · 링 팝오버)는 그대로
  assert.match(shared, /return <>\{clock \? formatClock\(ms\) : formatDuration\(ms\)\}<\/>;/);
});
