#!/usr/bin/env node
/**
 * Phase 143 (v0.7.16) — 스트림 끊김/401 자동 회복 회귀 테스트.
 *
 * 2026-07-10 K 실사고: "Reconnecting... 5/5 (stream disconnected before completion:
 * websocket closed by server before response.completed)" 로 turn 유실 + 직후 401 연쇄.
 *
 * 검증 — src/index.ts 에서 **실제 소스의 정규식을 추출**해 (사본 아님):
 *   ① 실사고 스트림 끊김 문자열 매칭
 *   ② 구버전 websocket close 문자열 매칭
 *   ③ 실사고 401 문자열 매칭 (Codex + Claude 양식)
 *   ④ 오탐 금지: 부분 재접속(2/5), 정상 토큰 로그, "5/5 complete" 진행 로그
 *   ⑤ 구조 불변식: Claude/Codex 양 경로 모두 _streamRetried/_authRetried 가드 분기 존재
 *   ⑥ 구조 불변식: 스트림 끊김 감지부에서 blockSession 호출 안 함 (구 Phase 61 회귀 방지)
 *   ⑦ 구조 불변식: long_task_started 가 재시도 턴에서 중복 등록 안 됨
 */

import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "src", "index.ts");

if (!existsSync(SRC)) {
  console.error(`source not found: ${SRC}`);
  process.exit(1);
}
const src = readFileSync(SRC, "utf-8");

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}`);
  }
}

// ── 소스에서 정규식 리터럴 추출 (사본 검증이 아니라 실제 배포 코드 검증) ──
function extractRegex(constName) {
  const m = src.match(new RegExp(`const ${constName} =\\s*\\n?\\s*(/(?:[^/\\\\\\n]|\\\\.)+/[a-z]*)`));
  if (!m) return null;
  const lit = m[1];
  const lastSlash = lit.lastIndexOf("/");
  return new RegExp(lit.slice(1, lastSlash), lit.slice(lastSlash + 1));
}

const STREAM_RE = extractRegex("STREAM_DISCONNECT_RE");
const AUTH_RE = extractRegex("AUTH_FAILURE_RE");
check("소스에서 STREAM_DISCONNECT_RE 추출", STREAM_RE instanceof RegExp);
check("소스에서 AUTH_FAILURE_RE 추출", AUTH_RE instanceof RegExp);

if (STREAM_RE && AUTH_RE) {
  // ① ② 스트림 끊김 매칭
  check(
    "① K 실사고 스트림 문자열 매칭",
    STREAM_RE.test(
      "Error: Reconnecting... 5/5 (stream disconnected before completion: websocket closed by server before response.completed)",
    ),
  );
  check("② 구버전 websocket close 매칭", STREAM_RE.test("websocket closed before response.completed"));

  // ③ 401 매칭
  check(
    "③-a K 실사고 401 매칭",
    AUTH_RE.test("Failed to authenticate. API Error: 401 Invalid authentication credentials"),
  );
  check(
    "③-b Claude authentication_error 매칭",
    AUTH_RE.test('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'),
  );

  // ④ 오탐 금지
  check("④-a 부분 재접속(2/5)은 스트림 매칭 안 됨", !STREAM_RE.test("Reconnecting... 2/5 timeout waiting"));
  check("④-b 정상 토큰 로그 오탐 없음", !STREAM_RE.test("tokens used: 40100 of 258400") && !AUTH_RE.test("tokens used: 40100 of 258400"));
  check("④-c 진행 로그(5/5 complete) 오탐 없음", !STREAM_RE.test("downloading update 5/5 complete"));
}

// ⑤ 양 경로 재시도 가드 분기
const claudeSection = src.slice(src.indexOf("async function handleViaClaudeCLI"), src.indexOf("async function handleViaCodexCLI"));
const codexSection = src.slice(src.indexOf("async function handleViaCodexCLI"), src.indexOf("async function handleViaGeminiCLI"));
check("⑤-a Claude 경로 _streamRetried 가드", /streamDisconnected && !msg\._streamRetried/.test(claudeSection));
check("⑤-b Claude 경로 _authRetried 가드", /authFailed && !msg\._authRetried/.test(claudeSection));
check("⑤-c Codex 경로 _streamRetried 가드", /streamDisconnected && !msg\._streamRetried/.test(codexSection));
check("⑤-d Codex 경로 _authRetried 가드", /authFailed && !msg\._authRetried/.test(codexSection));

// ⑥ 스트림 끊김 감지에서 blockSession 호출 안 함 (구 Phase 61 blocklist 회귀 방지)
const streamDetectIdx = codexSection.indexOf("STREAM_DISCONNECT_RE.test(stderrTail)");
const detectWindow = streamDetectIdx >= 0 ? codexSection.slice(streamDetectIdx, streamDetectIdx + 600) : "";
check("⑥ 스트림 끊김 감지부에 blockSession 없음", streamDetectIdx >= 0 && !detectWindow.includes("blockSession"));

// ⑦ long_task_started 중복 등록 방지
check(
  "⑦ 재시도 턴 long_task 중복 방지",
  /!msg\._codexResumeRetried && !msg\._streamRetried && !msg\._authRetried/.test(codexSection),
);

console.log(`\n${pass}/${pass + fail} 통과`);
process.exit(fail > 0 ? 1 : 0);
