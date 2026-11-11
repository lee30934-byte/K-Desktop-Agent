// v0.7.86 UI 개편 0단계 — 명칭 정리 회귀 테스트 (evidence/ui-redesign-20261111/design-spec.md 6장).
// 2026-11-11 K: "세션 초기화(대화 초기화)는 이름만 바꾸고 기능 그대로", 자동 승인 두 가지 혼동 해소.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test("전역 스위치는 '확인 없이 실행' (자동 승인 문구 없음)", () => {
  const t = read("../src/components/ApprovalToggle.tsx");
  assert.match(t, /aria-label="확인 없이 실행"/);
  assert.match(t, /확인 없이 실행 \{enabled \? 'ON' : 'OFF'\}/);
  assert.doesNotMatch(t, /자동 승인/);
});

test("기능별 허용 범위 라벨: 허용 / 실행 전 묻기 / 차단", () => {
  const s = read("../src/components/Settings.tsx");
  assert.match(s, /case "auto": return "허용";/);
  assert.match(s, /case "ask": return "실행 전 묻기";/);
  assert.match(s, /case "manual": return "차단";/);
  for (const old of ["확인창 없이 자동 승인", "기능별 실행 권한", "Claude CLI 경로 전용", "Claude Max 모드 한정"]) {
    assert.ok(!s.includes(old), old);
  }
  assert.match(s, /모든 엔진\(Claude·Codex·Gemini·REST\)/);
});

test("세션 버튼: 이름만 바꾸고 같은 핸들러 유지", () => {
  const m = read("../src/components/MetricsPanel.tsx");
  assert.match(m, /↻ 새 세션으로 이어가기/);
  assert.match(m, /📦 요약해서 새 대화로 이어가기/);
  const ui = m.split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n"); // 주석 제외, 화면 문구만
  assert.doesNotMatch(ui, /세션 초기화|대화 초기화|대화 압축 &/);
  assert.match(m, /onManualRefresh\(\);/);
  assert.match(m, /onCompressContext\(\);/);
  const app = read("../src/App.tsx");
  assert.match(app, /새 세션으로 이어감 \(컨텍스트/);
  assert.doesNotMatch(app, /세션 갱신됨|세션이 자동 갱신되었습니다/);
});
