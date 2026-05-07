// 명령행 길이 회귀 테스트 — Windows cmd.exe 8191자 한계 보호.
//
// 배경:
//   sidecar/src/index.ts 의 handleViaClaudeCLI 가 spawn 직전에 인자 합산 길이를 점검한다.
//   "명령줄이 너무 깁니다" 사고 (memory 가 6KB+ 누적 → --system-prompt 인자에 박혀 한계 초과)
//   가 다시 일어나지 않도록, 자동 외화 + 임계치 차단 정책을 회귀 테스트로 박는다.
//
// 검증 대상 정책 (sidecar/src/index.ts 와 동기화 필요):
//   LARGE_ARG_THRESHOLD = 1500   — 이 이상의 인자 값은 임시 파일로 외화 (--xxx-file 또는 path)
//   ARGS_WARN_THRESHOLD = 6500   — 합산 길이 도달 시 warn 로그
//   ARGS_FAIL_THRESHOLD = 7800   — spawn 차단, error 이벤트 발행
//
// 미러 함수: buildArgsForCli — sidecar 의 인자 빌드 + 외화 로직을 외부에서 시뮬레이션.

import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── 정책 상수 (sidecar/src/index.ts 와 동기화) ─────────────
const LARGE_ARG_THRESHOLD = 1500;
const ARGS_WARN_THRESHOLD = 6500;
const ARGS_FAIL_THRESHOLD = 7800;
const CLAUDE_CLI = "C:\\Users\\user\\AppData\\Roaming\\npm\\claude.cmd"; // 대표적 경로 (길이 60+)

// ─── 미러: 외화 + 인자 합산 길이 계산 ─────────────────────
function buildArgsForCli({
  systemPrompt,
  settings,
  mcpConfig,
  disallowedTools,
  resumeId,
}) {
  const tmpFiles = [];
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"];

  if (Array.isArray(disallowedTools) && disallowedTools.length > 0) {
    args.push("--disallowed-tools", disallowedTools.join(","));
  }

  function pushOrMaterialize(inlineFlag, fileFlag, value, suffix) {
    if (value.length < LARGE_ARG_THRESHOLD || !fileFlag) {
      args.push(inlineFlag, value);
      return;
    }
    const tmpPath = path.join(os.tmpdir(), `kda-test-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(tmpPath, value, "utf-8");
    tmpFiles.push(tmpPath);
    args.push(fileFlag, tmpPath);
  }

  if (systemPrompt) {
    pushOrMaterialize("--system-prompt", "--system-prompt-file", systemPrompt, "system-prompt");
  }

  if (mcpConfig) {
    const mcpJson = JSON.stringify(mcpConfig);
    if (mcpJson.length >= LARGE_ARG_THRESHOLD) {
      const tmpPath = path.join(os.tmpdir(), `kda-test-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(tmpPath, mcpJson, "utf-8");
      tmpFiles.push(tmpPath);
      args.push("--mcp-config", tmpPath);
    } else {
      args.push("--mcp-config", mcpJson);
    }
  }

  if (resumeId) {
    args.push("--resume", resumeId);
  }

  if (settings) {
    pushOrMaterialize("--settings", "--settings", JSON.stringify(settings), "settings");
  }

  const argsTotalLen =
    CLAUDE_CLI.length + args.reduce((acc, a) => acc + a.length + 3, 0);

  return { args, argsTotalLen, tmpFiles };
}

function cleanup(tmpFiles) {
  for (const f of tmpFiles) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
  }
}

// ─── 시나리오 ─────────────────────────────────────────────
// SYSTEM_PROMPT 평소 길이 ~ 1500자 (한국어 + 안내문 누적). manual 도구 안내가 길어지면 +1500 가능.
const NORMAL_SYSTEM_PROMPT = "당신은 K님의 개인 Windows 컴퓨터를 자동화하는 조수입니다.\n".repeat(20); // ~1000자
const HUGE_SYSTEM_PROMPT = "큰 시스템 프롬프트 라인. ".repeat(800); // ~16KB — 자동 외화돼야 안전선 유지
const NORMAL_HOOK_SETTINGS = {
  hooks: {
    PreToolUse: [
      { matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command: "node \"C:\\Users\\user\\Documents\\K-Desktop-Agent\\sidecar\\hooks\\preToolUse-overwriteGuard.mjs\"" }] },
      { matcher: "Bash",                  hooks: [{ type: "command", command: "node \"C:\\Users\\user\\Documents\\K-Desktop-Agent\\sidecar\\hooks\\preToolUse-pitfallGuard.mjs\"" }] },
    ],
  },
};
const HUGE_HOOK_SETTINGS = {
  hooks: {
    PreToolUse: Array.from({ length: 50 }).map((_, i) => ({
      matcher: `Tool${i}`,
      hooks: [{ type: "command", command: "node \"C:\\Users\\user\\Documents\\K-Desktop-Agent\\sidecar\\hooks\\hook-".concat("x".repeat(40)).concat(`-${i}.mjs\"`) }],
    })),
  },
};
const NORMAL_MCP = {
  "k-personal": { type: "stdio", command: "python", args: ["C:/Users/user/Documents/K-Personal-MCP/server.py"], env: {} },
};
const TYPICAL_DISALLOWED = ["Task", "Monitor", "Skill", "NotebookEdit", "Bash", "BashOutput", "KillShell"];
const HEAVY_DISALLOWED = [
  ...TYPICAL_DISALLOWED,
  ...Array.from({ length: 30 }).map((_, i) => `mcp__k-personal__some_long_tool_name_${i}`),
];

// ─── 케이스 ──────────────────────────────────────────────
const cases = [
  {
    name: "[1] 일상 시나리오: 평범한 SYSTEM_PROMPT + 평범한 settings + MCP",
    input: {
      systemPrompt: NORMAL_SYSTEM_PROMPT,
      settings: NORMAL_HOOK_SETTINGS,
      mcpConfig: NORMAL_MCP,
      disallowedTools: TYPICAL_DISALLOWED,
    },
    expect: { underWarn: true, underFail: true, tmpFilesAtLeast: 0, tmpFilesAtMost: 1 },
  },
  {
    name: "[2] 거대 SYSTEM_PROMPT (16KB) — 자동 외화로 안전선 유지",
    input: {
      systemPrompt: HUGE_SYSTEM_PROMPT,
      settings: NORMAL_HOOK_SETTINGS,
      mcpConfig: NORMAL_MCP,
      disallowedTools: TYPICAL_DISALLOWED,
    },
    expect: { underWarn: true, underFail: true, tmpFilesAtLeast: 1 },
  },
  {
    name: "[3] 거대 settings (200+ hook) + 거대 SYSTEM_PROMPT — 둘 다 외화",
    input: {
      systemPrompt: HUGE_SYSTEM_PROMPT,
      settings: HUGE_HOOK_SETTINGS,
      mcpConfig: NORMAL_MCP,
      disallowedTools: TYPICAL_DISALLOWED,
    },
    expect: { underWarn: true, underFail: true, tmpFilesAtLeast: 2 },
  },
  {
    name: "[4] disallowed-tools 비대 (30+ 잠금) — disallowed 는 외화 미지원이라 인자 누적",
    input: {
      systemPrompt: NORMAL_SYSTEM_PROMPT,
      settings: NORMAL_HOOK_SETTINGS,
      mcpConfig: NORMAL_MCP,
      disallowedTools: HEAVY_DISALLOWED,
    },
    expect: { underWarn: true, underFail: true },
  },
  {
    name: "[5] resume id 가 있어도 안전선 유지",
    input: {
      systemPrompt: NORMAL_SYSTEM_PROMPT,
      settings: NORMAL_HOOK_SETTINGS,
      mcpConfig: NORMAL_MCP,
      disallowedTools: TYPICAL_DISALLOWED,
      resumeId: "12345678-1234-1234-1234-123456789abc",
    },
    expect: { underWarn: true, underFail: true },
  },
  {
    name: "[6] 정책 sanity: 임계치 < cmd.exe 한계 (8191) 인지",
    input: null,  // sanity check 만
    expect: { sanity: true },
  },
  {
    name: "[7] LARGE_ARG_THRESHOLD 가 ARGS_WARN_THRESHOLD 보다 충분히 작은지 (외화로 마진 확보)",
    input: null,
    expect: { sanityMargin: true },
  },
];

// ─── 실행 ────────────────────────────────────────────────
let pass = 0, fail = 0;

for (const c of cases) {
  const errors = [];

  if (c.expect.sanity) {
    if (ARGS_FAIL_THRESHOLD >= 8191) errors.push(`ARGS_FAIL_THRESHOLD ${ARGS_FAIL_THRESHOLD} >= cmd.exe 한계 8191`);
    if (ARGS_WARN_THRESHOLD >= ARGS_FAIL_THRESHOLD) errors.push(`WARN(${ARGS_WARN_THRESHOLD}) >= FAIL(${ARGS_FAIL_THRESHOLD})`);
  } else if (c.expect.sanityMargin) {
    // 큰 인자 1개가 외화 안 되면 한계까지 LARGE_ARG_THRESHOLD * N 으로 빠르게 도달.
    // 외화 임계치가 WARN 절반 이하여야 큰 인자 4-5개 들어와도 마진 있음.
    if (LARGE_ARG_THRESHOLD * 4 >= ARGS_WARN_THRESHOLD) {
      errors.push(`LARGE_ARG_THRESHOLD*4 (${LARGE_ARG_THRESHOLD * 4}) >= WARN (${ARGS_WARN_THRESHOLD}) — 외화 마진 부족`);
    }
  } else {
    let result;
    try {
      result = buildArgsForCli(c.input);
      const { argsTotalLen, tmpFiles } = result;

      if (c.expect.underFail && argsTotalLen >= ARGS_FAIL_THRESHOLD) {
        errors.push(`argsTotalLen ${argsTotalLen} >= FAIL ${ARGS_FAIL_THRESHOLD}`);
      }
      if (c.expect.underWarn && argsTotalLen >= ARGS_WARN_THRESHOLD) {
        errors.push(`argsTotalLen ${argsTotalLen} >= WARN ${ARGS_WARN_THRESHOLD} (외화 후에도 인자가 비대 — 정책 재검토 필요)`);
      }
      if (typeof c.expect.tmpFilesAtLeast === "number" && tmpFiles.length < c.expect.tmpFilesAtLeast) {
        errors.push(`tmpFiles ${tmpFiles.length} < expected ${c.expect.tmpFilesAtLeast} (외화가 안 일어남)`);
      }
      if (typeof c.expect.tmpFilesAtMost === "number" && tmpFiles.length > c.expect.tmpFilesAtMost) {
        errors.push(`tmpFiles ${tmpFiles.length} > expected ${c.expect.tmpFilesAtMost} (불필요한 외화)`);
      }
    } finally {
      if (result) cleanup(result.tmpFiles);
    }
  }

  if (errors.length === 0) {
    pass++;
    console.log(`✅ ${c.name}`);
  } else {
    fail++;
    console.log(`❌ ${c.name}`);
    for (const e of errors) console.log(`     - ${e}`);
  }
}

console.log(`──────────────────────────────────`);
console.log(`결과: ${pass} 통과 / ${fail} 실패 (총 ${cases.length})`);
console.log(`정책: LARGE_ARG=${LARGE_ARG_THRESHOLD} WARN=${ARGS_WARN_THRESHOLD} FAIL=${ARGS_FAIL_THRESHOLD} (cmd.exe 한계 8191)`);
process.exit(fail === 0 ? 0 : 1);
