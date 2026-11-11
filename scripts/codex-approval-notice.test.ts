// v0.7.86 — Codex 승인 요청 종료 알림: 정상 처리는 채팅에 띄우지 않고, 실패만 표시.
// 2026-11-11 K: 자동 승인 ON 인데 "승인 응답을 전달했습니다 [accept_forwarded]" 가 요청마다 쌓여 불편.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../sidecar/src/index.ts", import.meta.url), "utf8");

function quietSet(): string[] {
  const m = src.match(/const QUIET_ELICITATION_REASONS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, "QUIET_ELICITATION_REASONS 정의");
  return [...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

test("정상 처리 사유(승인·거절·취소 전달, 턴 종료)는 채팅에 표시하지 않는다", () => {
  const q = quietSet();
  for (const r of ["accept_forwarded", "decline_forwarded", "cancel_forwarded", "turn_finished"]) assert.ok(q.includes(r), r);
});

test("실패·만료·불일치 사유는 계속 표시한다", () => {
  const q = quietSet();
  for (const r of ["timeout", "invalid_content", "server_closed", "pending_limit", "request_thread_mismatch", "unsupported_schema", "invalid_request"]) {
    assert.ok(!q.includes(r), r);
  }
});

test("provider_notice 발행은 QUIET 집합을 거르고, 로그 기록은 필터 전에 남긴다", () => {
  const i = src.indexOf('case "elicitation.diagnostic"');
  const block = src.slice(i, src.indexOf("break;", i));
  const logAt = block.indexOf("logToFile(");
  const emitAt = block.indexOf('type: "provider_notice"');
  assert.ok(logAt > 0 && emitAt > logAt);
  assert.match(block, /!QUIET_ELICITATION_REASONS\.has\(reason\)/);
});
