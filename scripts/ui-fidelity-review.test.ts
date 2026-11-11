// v0.7.86 UI 목업 충실도 fidR — 최종 점검.
// ① 우측 슬라이드오버가 열리면 o2 기본 위치 비서 아바타가 본문 열·입력창을 가리지 않게 숨기고, 닫히면 되살린다.
// ② classic 은 data-slideover 를 쓰지 않고 예전 규칙 그대로. ③ 개발용 픽스처·쿼리 훅은 배포 빌드(DEV=false)에서 모두 꺼짐.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = read("../src/App.tsx");
const o2css = read("../src/styles/o2-fidelity.css");
const companionCss = read("../src/components/CompanionWidget.css");
const widget = read("../src/components/AssistantWidget.tsx");
const fixtureSrc = read("../src/dev/mockupFixture.ts");

test("o2: 슬라이드오버가 열리면 data-slideover 를 켜고, 닫히거나 classic 이면 지운다", () => {
  assert.match(app, /if \(!isO2\) \{ root\.style\.setProperty\("--slideover-offset", "0px"\); root\.removeAttribute\("data-slideover"\); return; \}/);
  assert.match(app, /if \(open\) root\.setAttribute\("data-slideover", pinned \? "pinned" : "overlay"\);\n\s*else root\.removeAttribute\("data-slideover"\);/);
});

test("o2: 패널이 열려 있는 동안 기본 위치 아바타는 숨김 (끌어 옮긴 위치는 그대로, 언마운트 아님)", () => {
  assert.match(o2css, /:root\[data-layout="o2"\]\[data-slideover\] \.companion-widget:not\(\[style\*="left"\]\) \{ display: none; \}/);
  // 끌어 옮긴 위치는 인라인 left 로 표시된다 — :not([style*="left"]) 가 이 값을 기준으로 한다
  assert.match(widget, /const positionStyle = layout\.position \? \{ left: layout\.position\.x, top: layout\.position\.y, right: "auto" \} : undefined;/);
  // 기본 위치는 헤더·알림 띠 아래 (o2 크롬 아래)
  assert.match(o2css, /top: calc\(var\(--o2-chrome-bottom, 100px\) \+ 12px\);/);
});

test("classic: 아바타 규칙에 data-slideover 가 섞이지 않음 (예전 동작 유지)", () => {
  assert.doesNotMatch(companionCss, /data-slideover/);
  assert.match(companionCss, /\.companion-widget:not\(\[style\*="left"\]\) \{ right:calc\(26px \+ var\(--slideover-offset, 0px\)\); transition:right \.2s ease; \}/);
  for (const line of o2css.split("\n").filter(l => l.includes("data-slideover"))) assert.match(line, /^:root\[data-layout="o2"\]/);
});

test("개발용 픽스처·쿼리 훅 — 배포 빌드(DEV=false)에서는 전부 꺼지고 저장소 쓰기 없음", async () => {
  const fx = await import("../src/dev/mockupFixture");
  const q = "?fixture=mockup&layout=o2&panel=session&settings=safety&q=a";
  for (const env of [{ DEV: false }, undefined]) {
    assert.equal(fx.mockupFixtureEnabled(env, q), false);
    assert.equal(fx.readMockupFixture(env, q), null);
    assert.equal(fx.devLayoutOverride(env, q), null);
    assert.equal(fx.devPanelOverride(env, q), null);
    assert.equal(fx.devSettingsOverride(env, q), null);
  }
  assert.ok(fx.readMockupFixture({ DEV: true }, "?fixture=mockup"));
  assert.doesNotMatch(fixtureSrc, /localStorage\.setItem|sessionStorage|invoke\(|indexedDB|\bdb\.\w+\(/);
});
