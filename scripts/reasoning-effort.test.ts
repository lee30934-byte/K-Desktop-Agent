// 2026-11-19 — 모델별 추론 강도 보정 (Codex CLI 0.170 카탈로그 + 실제 호출 근거, src/reasoningEffort.ts 참고).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { clampEffortForModel, levelsForModel, normalizeStoredEffort } from "../src/reasoningEffort";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("현행 모델은 xhigh·max·ultra 까지 선택 가능, Luna 는 ultra 없음", () => {
  assert.deepEqual([...levelsForModel("gpt-6.2-sol")], ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual([...levelsForModel("gpt-6.2-astra")], ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.ok(!levelsForModel("gpt-6-luna").includes("ultra"));
  assert.deepEqual([...levelsForModel("o3")], ["low", "medium", "high"], "카탈로그 밖 옛 모델은 세 단계");
});

test("고른 단계를 실제 모델에 맞게 보정", () => {
  assert.equal(clampEffortForModel("ultra", "gpt-6.2-sol"), "ultra");
  assert.equal(clampEffortForModel("ultra", "gpt-6-luna"), "max");
  assert.equal(clampEffortForModel("xhigh", "gpt-5.5"), "high");
  assert.equal(clampEffortForModel("minimal", "gpt-6.2-sol"), "low", "minimal 은 현행 모델이 400 으로 거부");
  assert.equal(clampEffortForModel("default", "gpt-6.2-sol"), undefined);
  assert.equal(clampEffortForModel(undefined, "gpt-6.2-sol"), undefined);
  assert.equal(normalizeStoredEffort("MAX"), "max");
  assert.equal(normalizeStoredEffort("bogus"), undefined);
});

test("앱·Rust·사이드카가 같은 단계를 통과시키고, App 은 실제 모델로 보정", () => {
  const app = read("../src/App.tsx");
  assert.match(app, /reasoningEffort: clampEffortForModel\(autoChoice\?\.reasoningEffort \?\? \(isTelegramConv \? "low" : loadReasoningEffort\(\)\), model\)/);
  const rs = read("../src-tauri/src/lib.rs");
  assert.match(rs, /matches!\(r, "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra"\)/);
  const sc = read("../sidecar/src/index.ts");
  assert.match(sc, /new Set\(\["low", "medium", "high", "xhigh", "max", "ultra"\]\)/);
  assert.match(sc, /reasoningRaw === "minimal" \? "low" : reasoningRaw/);
  const st = read("../src/components/Settings.tsx");
  assert.doesNotMatch(st, /\{ id: "minimal"/, "드롭다운에 minimal 없음");
  assert.match(st, /reasoningEffortOptions\(reasoningModel\)/);
});
