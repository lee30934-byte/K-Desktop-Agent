// 권한 게이트 회귀 테스트 — buildToolFlags 정책을 외부에서 직접 검증.
// sidecar/src/index.ts 의 PERM_TOOL_MAP / ALWAYS_BLOCKED_BYPASS / HIGH_RISK_BUILTINS / buildToolFlags
// 를 그대로 미러링 (수정 시 sidecar 와 동기화 필요).

const PERM_TOOL_MAP = {
  file_read: [
    "Read", "Glob", "Grep",
    "mcp__k-personal__fm_list_directory",
    "mcp__k-personal__fm_search_files",
    "mcp__k-personal__fm_recent_files",
    "mcp__k-personal__fm_file_info",
    "mcp__k-personal__fm_disk_usage",
    "mcp__k-personal__fm_list_backups",
    "mcp__k-personal__fm_operation_log",
  ],
  file_write: [
    "Write", "Edit", "MultiEdit",
    "mcp__k-personal__fm_copy_file",
  ],
  file_delete: [
    "mcp__k-personal__fm_move_file",
    "mcp__k-personal__fm_organize_folder",
    "mcp__k-personal__fm_restore_file",
  ],
  app_launch: [
    "mcp__k-personal__app_launch",
    "mcp__k-personal__app_kill",
    "mcp__k-personal__app_list_running",
    "mcp__k-personal__app_open_url",
    "mcp__k-personal__app_register",
    "mcp__k-personal__app_list_registered",
    "mcp__k-personal__app_launch_preset",
  ],
  system_control: [
    "mcp__k-personal__cc_mouse_move",
    "mcp__k-personal__cc_mouse_click",
    "mcp__k-personal__cc_mouse_position",
    "mcp__k-personal__cc_keyboard_type",
    "mcp__k-personal__cc_keyboard_hotkey",
    "mcp__k-personal__cc_focus_window",
    "mcp__k-personal__clip_get",
    "mcp__k-personal__clip_set",
    "mcp__k-personal__clip_paste_at",
    "mcp__k-personal__clip_snippet_add",
    "mcp__k-personal__clip_snippet_get",
    "mcp__k-personal__clip_snippet_list",
  ],
  screenshot: [
    "mcp__k-personal__cc_screenshot",
    "mcp__k-personal__cc_screenshot_region",
    "mcp__k-personal__cc_screen_size",
    "mcp__k-personal__cc_list_windows",
  ],
  web_fetch: ["WebFetch", "WebSearch"],
  db_access: [
    "mcp__k-personal__db_todo_add", "mcp__k-personal__db_todo_list",
    "mcp__k-personal__db_todo_done", "mcp__k-personal__db_todo_delete",
    "mcp__k-personal__db_note_add", "mcp__k-personal__db_note_list",
    "mcp__k-personal__db_note_search", "mcp__k-personal__db_note_delete",
    "mcp__k-personal__db_habit_add", "mcp__k-personal__db_habit_check",
    "mcp__k-personal__db_habit_list",
  ],
};

const DEFAULT_PERMISSIONS = {
  file_read: "auto", file_write: "ask", file_delete: "ask",
  app_launch: "ask", system_control: "ask", screenshot: "auto",
  web_fetch: "auto", db_access: "auto",
};

const HIGH_RISK_BUILTINS = ["Bash", "BashOutput", "KillShell"];
const ALWAYS_BLOCKED_BYPASS = ["Task", "Monitor", "Skill", "NotebookEdit"];

function buildToolFlags(perms, lockedTools) {
  const effective = { ...DEFAULT_PERMISSIONS, ...(perms ?? {}) };
  const disallowed = [...ALWAYS_BLOCKED_BYPASS];

  for (const [permId, level] of Object.entries(effective)) {
    if (level !== "manual") continue;
    disallowed.push(...(PERM_TOOL_MAP[permId] ?? []));
  }

  let lockedCount = 0;
  if (Array.isArray(lockedTools)) {
    for (const t of lockedTools) {
      if (typeof t === "string" && t.trim()) {
        disallowed.push(t.trim());
        lockedCount++;
      }
    }
  }

  const bashTrustworthy =
    effective.file_write === "auto" &&
    effective.file_delete === "auto" &&
    effective.app_launch === "auto";
  if (!bashTrustworthy) {
    disallowed.push(...HIGH_RISK_BUILTINS);
  }

  return {
    disallowed: [...new Set(disallowed)],
    effective,
    lockedCount,
  };
}

// ─── 회귀 테스트 케이스 ──────────────────────────────────
const allAuto = {
  file_read: "auto", file_write: "auto", file_delete: "auto",
  app_launch: "auto", system_control: "auto", screenshot: "auto",
  web_fetch: "auto", db_access: "auto",
};

const cases = [
  {
    name: "[1] sidecar.log 라인 #1 매칭: file_delete=manual, locked 0",
    perms: { ...allAuto, file_delete: "manual" },
    locked: [],
    expectDisallowed: 10,
    expectLocked: 0,
    expectIncludes: [
      "Task", "Monitor", "Skill", "NotebookEdit",
      "Bash", "BashOutput", "KillShell",
      "mcp__k-personal__fm_move_file",
      "mcp__k-personal__fm_organize_folder",
      "mcp__k-personal__fm_restore_file",
    ],
    expectExcludes: [
      "mcp__k-personal__fm_list_directory", // file_read=auto 이므로 차단 안 됨
      "mcp__k-personal__cc_screenshot",      // screenshot=auto
    ],
  },
  {
    name: "[2] sidecar.log 라인 #2 매칭: file_delete=manual, locked 7",
    perms: { ...allAuto, file_delete: "manual" },
    locked: [
      "mcp__k-personal__cc_keyboard_type",
      "mcp__k-personal__cc_mouse_click",
      "mcp__k-personal__app_launch",
      "mcp__k-personal__app_kill",
      "mcp__k-personal__clip_paste_at",
      "WebFetch",
      "Edit",
    ],
    expectDisallowed: 17,
    expectLocked: 7,
    expectIncludes: ["mcp__k-personal__cc_keyboard_type", "Edit", "Bash"],
  },
  {
    name: "[3] sidecar.log 라인 #3 매칭: 전부 auto, locked 0",
    perms: allAuto,
    locked: [],
    expectDisallowed: 4,
    expectLocked: 0,
    expectIncludes: ["Task", "Monitor", "Skill", "NotebookEdit"],
    expectExcludes: ["Bash", "BashOutput", "KillShell"], // 셋 다 auto → Bash 허용
  },
  {
    name: "[4] 정밀 잠금 단독: file_delete=auto + fm_organize_folder 만 잠금",
    perms: allAuto,
    locked: ["mcp__k-personal__fm_organize_folder"],
    expectDisallowed: 5,
    expectLocked: 1,
    expectIncludes: ["mcp__k-personal__fm_organize_folder"],
    expectExcludes: [
      "mcp__k-personal__fm_move_file",       // 잠그지 않음 → 통과
      "mcp__k-personal__fm_restore_file",    // 잠그지 않음 → 통과
      "Bash",                                 // 모두 auto → 허용
    ],
  },
  {
    name: "[5] 카테고리 + 정밀 잠금 중복: file_delete=manual + fm_organize_folder 정밀 잠금",
    perms: { ...allAuto, file_delete: "manual" },
    locked: ["mcp__k-personal__fm_organize_folder"],
    expectDisallowed: 10, // dedupe → 카테고리에 이미 있음
    expectLocked: 1,
    expectIncludes: ["mcp__k-personal__fm_organize_folder"],
  },
  {
    name: "[6] 우회통로 항상 차단 (모든 권한 auto 라도)",
    perms: allAuto,
    locked: [],
    expectIncludes: ["Task", "Monitor", "Skill", "NotebookEdit"],
  },
  {
    name: "[7] file_write=ask 면 Bash 차단 (Bash 정책 검증)",
    perms: { ...allAuto, file_write: "ask" },
    locked: [],
    expectIncludes: ["Bash", "BashOutput", "KillShell"],
  },
];

// ─── 실행 ──────────────────────────────────────────────
let pass = 0, fail = 0;
for (const c of cases) {
  const out = buildToolFlags(c.perms, c.locked);
  const errors = [];

  if (c.expectDisallowed != null && out.disallowed.length !== c.expectDisallowed) {
    errors.push(`disallowed 개수: expected=${c.expectDisallowed} got=${out.disallowed.length}`);
  }
  if (c.expectLocked != null && out.lockedCount !== c.expectLocked) {
    errors.push(`locked 개수: expected=${c.expectLocked} got=${out.lockedCount}`);
  }
  for (const t of c.expectIncludes ?? []) {
    if (!out.disallowed.includes(t)) errors.push(`MISSING in disallowed: ${t}`);
  }
  for (const t of c.expectExcludes ?? []) {
    if (out.disallowed.includes(t)) errors.push(`UNEXPECTED in disallowed: ${t}`);
  }

  if (errors.length === 0) {
    pass++;
    console.log(`✅ ${c.name}`);
    console.log(`   disallowed=${out.disallowed.length} locked=${out.lockedCount}`);
  } else {
    fail++;
    console.log(`❌ ${c.name}`);
    console.log(`   disallowed=${out.disallowed.length} locked=${out.lockedCount}`);
    for (const e of errors) console.log(`     - ${e}`);
    console.log(`   actual disallowed: ${JSON.stringify(out.disallowed)}`);
  }
  console.log();
}

console.log(`──────────────────────────────────`);
console.log(`결과: ${pass} 통과 / ${fail} 실패 (총 ${cases.length})`);
process.exit(fail === 0 ? 0 : 1);
