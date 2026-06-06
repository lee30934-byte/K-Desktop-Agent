#!/usr/bin/env node
/**
 * preToolUse-pitfallGuard.mjs 회귀 테스트.
 *
 * 케이스 — 가드 동작의 결정적 증거:
 *   ① fallback: powershell-secret-bom 패턴      → exit 2 (차단)
 *   ② fallback: tauri signer generate 패턴      → exit 2 (차단)
 *   ③ benign 명령                                → exit 0 (통과)
 *   ④ KDA_PITFALL_GUARD=0 + 위험 명령           → exit 0 (가드 비활성)
 *   ⑤ 다른 도구 (Read)                           → exit 0 (가드 무관)
 *   ⑥ 동적 로드: 임시 memory dir 의 pitfall_*.md guard_pattern → exit 2 + 커스텀 사유
 *   ⑦ 동적 로드: guard_remedy 의 \n 이 실제 개행으로 렌더 → stderr 다중 라인
 *   ⑧ 동적 로드: 잘못된 정규식은 건너뛰고 가드 전체는 계속 (benign 통과)
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(__dirname, "hooks", "preToolUse-pitfallGuard.mjs");

if (!existsSync(HOOK)) {
  console.error(`hook not found: ${HOOK}`);
  process.exit(1);
}

// 동적 로드 테스트용 임시 memory dir (실제 ~/.kda/memory 를 건드리지 않음)
const memDir = mkdtempSync(path.join(os.tmpdir(), "kda-pitfall-mem-"));
writeFileSync(
  path.join(memDir, "pitfall_custom_demo.md"),
  [
    "---",
    "name: demo custom guard",
    "description: 데모용 커스텀 함정 패턴",
    "guard_id: custom-demo",
    "guard_pattern: 'rm\\s+-rf\\s+/'",
    "guard_tool: Bash",
    "guard_field: command",
    "guard_flags: i",
    "guard_remedy: '첫째 줄\\n둘째 줄'",
    "---",
    "본문.",
    "",
  ].join("\n"),
  "utf-8",
);
// 잘못된 정규식 — 로드 시 건너뛰어야 함 (가드 전체는 계속)
writeFileSync(
  path.join(memDir, "pitfall_bad_regex.md"),
  ["---", "guard_pattern: '([unclosed'", "---", "x", ""].join("\n"),
  "utf-8",
);

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
    name: "① fallback powershell-secret-bom → 차단",
    payload: { tool_name: "Bash", tool_input: { command: "Get-Content -Raw k | gh secret set FOO" } },
    expectCode: 2,
    expectStderrContains: "powershell-secret-bom",
  },
  {
    name: "② fallback tauri signer generate → 차단",
    payload: { tool_name: "Bash", tool_input: { command: "npx tauri signer generate -w k" } },
    expectCode: 2,
    expectStderrContains: "tauri-key-rotation",
  },
  {
    name: "③ benign 명령 → 통과",
    payload: { tool_name: "Bash", tool_input: { command: "git status" } },
    expectCode: 0,
  },
  {
    name: "④ GUARD=0 + 위험 명령 → 통과 (비활성)",
    payload: { tool_name: "Bash", tool_input: { command: "npx tauri signer generate" } },
    env: { KDA_PITFALL_GUARD: "0" },
    expectCode: 0,
  },
  {
    name: "⑤ Read 도구 (가드 대상 외) → 통과",
    payload: { tool_name: "Read", tool_input: { file_path: "x" } },
    expectCode: 0,
  },
  {
    name: "⑥ 동적 로드 커스텀 guard_pattern → 차단 + 커스텀 사유",
    payload: { tool_name: "Bash", tool_input: { command: "rm -rf / tmp" } },
    env: { KDA_MEMORY_DIR: memDir },
    expectCode: 2,
    expectStderrContains: "데모용 커스텀 함정 패턴",
  },
  {
    name: "⑦ 동적 guard_remedy \\n → 실제 개행 렌더",
    payload: { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
    env: { KDA_MEMORY_DIR: memDir },
    expectCode: 2,
    expectStderrContains: "첫째 줄\n둘째 줄",
  },
  {
    name: "⑧ 잘못된 정규식 항목 무시 + 가드 계속 (benign 통과)",
    payload: { tool_name: "Bash", tool_input: { command: "echo hi" } },
    env: { KDA_MEMORY_DIR: memDir },
    expectCode: 0,
  },
];

let passed = 0;
let failed = 0;
for (const c of cases) {
  const { code, stderr } = runHook(c.payload, c.env ?? {});
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
try { rmSync(memDir, { recursive: true, force: true }); } catch {}

console.log(`\n결과: ${passed} passed, ${failed} failed (총 ${cases.length})`);
process.exit(failed === 0 ? 0 : 1);
