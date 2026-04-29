#!/usr/bin/env node
/**
 * preToolUse-overwriteGuard.mjs 회귀 테스트.
 *
 * 4 케이스 — 가드 동작의 결정적 증거:
 *   ① manual + 기존 파일       → exit 2 (차단)
 *   ② manual + 신규 파일       → exit 0 (통과)
 *   ③ auto   + 기존 파일       → exit 0 (통과)
 *   ④ ask    + 기존 파일       → exit 0 (통과 — soft enforcement 는 system prompt 가 담당)
 *   ⑤ KDA_OVERWRITE_GUARD=0 + manual + 기존 → exit 0 (가드 비활성화)
 *   ⑥ 다른 도구 (Read)          → exit 0 (가드 무관)
 */

import { spawnSync, execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(__dirname, "hooks", "preToolUse-overwriteGuard.mjs");

if (!existsSync(HOOK)) {
  console.error(`hook not found: ${HOOK}`);
  process.exit(1);
}

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "kda-hook-test-"));
const existingFile = path.join(tmpDir, "existing.txt");
const newFile = path.join(tmpDir, "new.txt");
writeFileSync(existingFile, "기존 내용\n", "utf-8");

function runHook(payload, env = {}) {
  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, stderr: result.stderr ?? "" };
}

const cases = [
  {
    name: "① manual + 기존 파일 (Write) → 차단",
    payload: { tool_name: "Write", tool_input: { file_path: existingFile, content: "x" } },
    env: { KDA_FILE_DELETE_LEVEL: "manual" },
    expectCode: 2,
    expectStderrContains: "manual",
  },
  {
    name: "② manual + 신규 파일 (Write) → 통과",
    payload: { tool_name: "Write", tool_input: { file_path: newFile, content: "x" } },
    env: { KDA_FILE_DELETE_LEVEL: "manual" },
    expectCode: 0,
  },
  {
    name: "③ auto + 기존 파일 (Edit) → 통과",
    payload: { tool_name: "Edit", tool_input: { file_path: existingFile, old_string: "a", new_string: "b" } },
    env: { KDA_FILE_DELETE_LEVEL: "auto" },
    expectCode: 0,
  },
  {
    name: "④ ask + 기존 파일 (MultiEdit) → 통과 (soft 만)",
    payload: { tool_name: "MultiEdit", tool_input: { file_path: existingFile, edits: [] } },
    env: { KDA_FILE_DELETE_LEVEL: "ask" },
    expectCode: 0,
  },
  {
    name: "⑤ GUARD=0 + manual + 기존 (디버그 비활성) → 통과",
    payload: { tool_name: "Write", tool_input: { file_path: existingFile, content: "x" } },
    env: { KDA_FILE_DELETE_LEVEL: "manual", KDA_OVERWRITE_GUARD: "0" },
    expectCode: 0,
  },
  {
    name: "⑥ Read 도구 (가드 대상 외) → 통과",
    payload: { tool_name: "Read", tool_input: { file_path: existingFile } },
    env: { KDA_FILE_DELETE_LEVEL: "manual" },
    expectCode: 0,
  },
];

let passed = 0;
let failed = 0;
for (const c of cases) {
  const { code, stderr } = runHook(c.payload, c.env);
  let ok = code === c.expectCode;
  if (ok && c.expectStderrContains) {
    ok = stderr.includes(c.expectStderrContains);
  }
  if (ok) {
    console.log(`✓ ${c.name}  (exit=${code})`);
    passed++;
  } else {
    console.log(`✗ ${c.name}`);
    console.log(`  expected exit=${c.expectCode}${c.expectStderrContains ? ` stderr~"${c.expectStderrContains}"` : ""}`);
    console.log(`  actual   exit=${code} stderr=${JSON.stringify(stderr.slice(0, 200))}`);
    failed++;
  }
}

// cleanup
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log(`\n결과: ${passed} passed, ${failed} failed (총 ${cases.length})`);
process.exit(failed === 0 ? 0 : 1);
