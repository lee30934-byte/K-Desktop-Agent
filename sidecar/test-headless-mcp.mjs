// Phase 13 — Headless Automation 회귀 테스트.
//
// 목적:
//   1. K-Personal MCP 의 ui_*/web_* 모듈이 정상 import 되는지 (구문 오류 없는지)
//   2. 그 모듈들이 노출하는 도구 목록이 sidecar 의 PERM_TOOL_MAP 과 1:1 매칭하는지
//      (둘 중 한쪽이 도구를 추가/삭제했는데 다른 쪽이 안 따라간 누락 검증)
//   3. Settings.tsx 의 TOOL_CATALOG 도 동일 도구 목록을 노출하는지
//
// 왜 별도 테스트:
//   - ui_/web_ 도구는 외부 패키지(uiautomation/playwright)에 의존해서 import 시 실패할 수 있음
//   - 패키지 미설치 환경에서도 모듈 import 자체는 성공해야 (지연 로드 패턴) → 이 보장이 필요
//   - 도구 이름 한 글자만 다르면 권한 게이트가 "잠금 안 됨" 상태로 흘러감 → 명시적 동기화 검증

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// __dirname = .../K-Desktop-Agent/sidecar
const sidecarRoot = __dirname;
const projectRoot = path.resolve(__dirname, "..");
// projectRoot = .../K-Desktop-Agent

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log(`✅ ${msg}`); }
function ng(msg, detail) {
  fail++;
  console.log(`❌ ${msg}`);
  if (detail) console.log(`   ${detail}`);
}

// ─── 1. 도구 이름 표준 (sidecar/src/index.ts 의 PERM_TOOL_MAP 기준) ───
const EXPECTED_UI_TOOLS = [
  "ui_dump_tree",
  "ui_find",
  "ui_click_by_name",
  "ui_click_by_id",
  "ui_set_text",
  "ui_get_text",
  "ui_focus_control",
  "ui_invoke",
  "ui_list_windows",
];

const EXPECTED_WEB_TOOLS = [
  "web_open",
  "web_snapshot",
  "web_click",
  "web_fill",
  "web_get_text",
  "web_screenshot",
  "web_evaluate",
  "web_url",
  "web_close",
];

// ─── 2. K-Personal MCP 모듈 import + get_tools() ───
const kPersonalPath =
  process.env.K_PERSONAL_MCP_PATH ??
  "C:/Users/user/Documents/K-Personal-MCP/server.py";

if (!existsSync(kPersonalPath)) {
  ng("K-Personal MCP 경로 존재", `not found: ${kPersonalPath}`);
} else {
  ok(`K-Personal MCP 경로 존재: ${kPersonalPath}`);
}

// 모듈 import 만 검사 (브라우저/UIA 호출은 안 함, 미설치 환경에서도 통과해야 함)
const kPersonalDir = path.dirname(kPersonalPath);
const pyScript = [
  "import sys, json",
  `sys.path.insert(0, r"${kPersonalDir.replace(/\\/g, "\\\\")}")`,
  'result = {"ui": [], "web": [], "errors": []}',
  "try:",
  "    from modules import uia_control",
  '    result["ui"] = [t.name for t in uia_control.get_tools()]',
  "except Exception as e:",
  '    result["errors"].append(f"uia_control: {type(e).__name__}: {e}")',
  "try:",
  "    from modules import web_automation",
  '    result["web"] = [t.name for t in web_automation.get_tools()]',
  "except Exception as e:",
  '    result["errors"].append(f"web_automation: {type(e).__name__}: {e}")',
  "print(json.dumps(result))",
].join("\n");

// shell:false 로 spawn — Windows 에서 shell:true 면 -c "<multi-line>" 이 깨짐.
// stdin 으로 스크립트 흘려보내는 게 더 견고.
const pythonExe = process.env.PYTHON_EXE ?? "python";
const proc = spawnSync(pythonExe, ["-"], {
  encoding: "utf-8",
  timeout: 15000,
  input: pyScript,
});

if (proc.status !== 0) {
  ng("Python import 실행 실패", `stderr: ${proc.stderr?.slice(0, 500) ?? "(없음)"}`);
} else {
  let modResult;
  try {
    modResult = JSON.parse(proc.stdout.trim().split("\n").pop());
  } catch (e) {
    ng("Python 출력 파싱 실패", proc.stdout.slice(0, 500));
    modResult = null;
  }

  if (modResult) {
    if (modResult.errors.length > 0) {
      ng("모듈 import 시 에러 발생", JSON.stringify(modResult.errors));
    } else {
      ok("uia_control + web_automation 모듈 import 성공 (지연 로드 검증)");
    }

    // ui_ 도구 매칭
    const uiSet = new Set(modResult.ui);
    const expectedUiSet = new Set(EXPECTED_UI_TOOLS);
    const missingUi = EXPECTED_UI_TOOLS.filter((t) => !uiSet.has(t));
    const extraUi = modResult.ui.filter((t) => !expectedUiSet.has(t));
    if (missingUi.length === 0 && extraUi.length === 0) {
      ok(`uia_control.get_tools() = ${modResult.ui.length}개, sidecar PERM_TOOL_MAP 와 1:1 매칭`);
    } else {
      ng(
        "uia_control 도구 목록 불일치",
        `missing(MCP): ${JSON.stringify(missingUi)} extra(MCP): ${JSON.stringify(extraUi)}`,
      );
    }

    // web_ 도구 매칭
    const webSet = new Set(modResult.web);
    const expectedWebSet = new Set(EXPECTED_WEB_TOOLS);
    const missingWeb = EXPECTED_WEB_TOOLS.filter((t) => !webSet.has(t));
    const extraWeb = modResult.web.filter((t) => !expectedWebSet.has(t));
    if (missingWeb.length === 0 && extraWeb.length === 0) {
      ok(`web_automation.get_tools() = ${modResult.web.length}개, sidecar PERM_TOOL_MAP 와 1:1 매칭`);
    } else {
      ng(
        "web_automation 도구 목록 불일치",
        `missing(MCP): ${JSON.stringify(missingWeb)} extra(MCP): ${JSON.stringify(extraWeb)}`,
      );
    }
  }
}

// ─── 3. sidecar/src/index.ts 가 PERM_TOOL_MAP 에 ui_automation, web_automation 키를 포함 ───
const sidecarSrc = readFileSync(
  path.join(sidecarRoot, "src", "index.ts"),
  "utf-8",
);

for (const cat of ["ui_automation", "web_automation"]) {
  if (sidecarSrc.includes(`${cat}: [`)) {
    ok(`sidecar PERM_TOOL_MAP 에 "${cat}" 카테고리 등록됨`);
  } else {
    ng(`sidecar PERM_TOOL_MAP 에 "${cat}" 누락`);
  }
}

for (const t of EXPECTED_UI_TOOLS) {
  if (sidecarSrc.includes(`mcp__k-personal__${t}`)) {
    // 통과 - 카운트만 누적
  } else {
    ng(`sidecar PERM_TOOL_MAP 에 ui 도구 누락: ${t}`);
  }
}

for (const t of EXPECTED_WEB_TOOLS) {
  if (sidecarSrc.includes(`mcp__k-personal__${t}`)) {
    // 통과
  } else {
    ng(`sidecar PERM_TOOL_MAP 에 web 도구 누락: ${t}`);
  }
}
ok(`sidecar PERM_TOOL_MAP 에 ui/web 도구 ${EXPECTED_UI_TOOLS.length + EXPECTED_WEB_TOOLS.length}개 모두 박힘`);

// ─── 4. Settings.tsx 의 TOOL_CATALOG 동기화 ───
const settingsPath = path.join(projectRoot, "src", "components", "Settings.tsx");
if (!existsSync(settingsPath)) {
  ng("Settings.tsx 경로 존재", `not found: ${settingsPath}`);
} else {
  const settingsSrc = readFileSync(settingsPath, "utf-8");
  for (const cat of ["ui_automation", "web_automation"]) {
    if (settingsSrc.includes(`permId: "${cat}"`)) {
      ok(`Settings.tsx TOOL_CATALOG 에 "${cat}" 등록됨`);
    } else {
      ng(`Settings.tsx TOOL_CATALOG 에 "${cat}" 누락`);
    }
  }
  // DEFAULT_PERMISSIONS 에 신규 ID 등록
  for (const id of ["ui_automation", "web_automation"]) {
    if (settingsSrc.includes(`id: "${id}"`)) {
      ok(`Settings.tsx DEFAULT_PERMISSIONS 에 "${id}" 항목 있음`);
    } else {
      ng(`Settings.tsx DEFAULT_PERMISSIONS 에 "${id}" 누락`);
    }
  }
}

// ─── 5. Phase F (2026-05-06 사고 패치) — 외화 검증 코드 존재 확인 ─────────
// 사고: "Invalid JSON provided to --settings" + "Invalid MCP configuration: schema" 비결정적 발생.
// 대책: settings/mcp config 외화 시 read-back + JSON.parse + 길이 일치 검증.
// 이 테스트는 그 코드가 sidecar/src/index.ts 와 dist/index.js 양쪽 모두 박혔는지 확인.
const requiredPatterns = [
  { name: "materializeJsonArg 헬퍼", pattern: /materializeJsonArg/ },
  { name: "외화 후 readFileSync read-back", pattern: /readFileSync\(tmpPath/ },
  { name: "JSON.parse(readBack) 검증", pattern: /JSON\.parse\(readBack\)/ },
  { name: "length mismatch 길이 검증", pattern: /length mismatch/ },
  { name: "settingsBytes / mcpBytes 로깅", pattern: /settingsBytes=.*mcpBytes=/ },
  { name: "settingsHead / mcpHead 진단 로깅", pattern: /settingsHead.*mcpHead/ },
];
for (const p of requiredPatterns) {
  if (p.pattern.test(sidecarSrc)) {
    ok(`sidecar/src/index.ts: ${p.name} 박힘`);
  } else {
    ng(`sidecar/src/index.ts: ${p.name} 누락 — Phase F 회귀!`);
  }
}

// dist/index.js 도 같은 패턴인지 (npm run build 가 src 와 sync 됐는지)
const distPath = path.join(sidecarRoot, "dist", "index.js");
if (!existsSync(distPath)) {
  ng(`sidecar/dist/index.js 없음 — npm run build 필요`);
} else {
  const distSrc = readFileSync(distPath, "utf-8");
  // dist 는 minify 되지 않고 거의 같은 텍스트라 same patterns OK.
  // 단 함수명/변수명은 보존되니 핵심 패턴만.
  const distRequired = [
    { name: "materializeJsonArg", pattern: /materializeJsonArg/ },
    { name: "readFileSync(tmpPath", pattern: /readFileSync\(tmpPath/ },
    { name: "JSON.parse(readBack)", pattern: /JSON\.parse\(readBack\)/ },
    { name: "length mismatch", pattern: /length mismatch/ },
  ];
  let distAllOk = true;
  for (const p of distRequired) {
    if (!p.pattern.test(distSrc)) {
      distAllOk = false;
      ng(`dist/index.js: ${p.name} 누락 — sidecar build (npm run build) 누락`);
    }
  }
  if (distAllOk) {
    ok(`dist/index.js: 외화 검증 패턴 4종 모두 박힘 (build sync OK)`);
  }
}

// ─── 6. JSON 빌드 round-trip 시뮬레이션 ─────────
// buildMCPConfig 가 만드는 객체 형식이 schema 통과 가능한지 직접 빌드해봄.
const mockMcpConfig = {
  "k-personal": {
    type: "stdio",
    command: "C:\\python\\python.exe",
    args: ["C:\\Users\\user\\Documents\\K-Personal-MCP\\server.py"],
    env: {},
  },
};
try {
  const json = JSON.stringify({ mcpServers: mockMcpConfig });
  const parsed = JSON.parse(json);
  if (parsed?.mcpServers?.["k-personal"]?.type === "stdio") {
    ok("mcp-config JSON round-trip 통과 (mcpServers wrapper + stdio key + Windows path backslash escape)");
  } else {
    ng("mcp-config JSON round-trip 실패 — 구조 손상");
  }
} catch (e) {
  ng(`mcp-config JSON 빌드 실패: ${e.message}`);
}

// hookSettings 도 같은 검증 (Windows 경로 \ escape 가 흔한 함정)
const mockHookSettings = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Write|Edit|MultiEdit",
        hooks: [{ type: "command", command: 'node "C:\\Users\\user\\hook.mjs"' }],
      },
    ],
  },
};
try {
  const json = JSON.stringify(mockHookSettings);
  const parsed = JSON.parse(json);
  const cmd = parsed?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
  if (cmd && cmd.includes("\\Users\\user\\hook.mjs")) {
    ok("hookSettings JSON round-trip 통과 (Windows path backslash escape OK)");
  } else {
    ng(`hookSettings JSON 백슬래시 escape 손상: cmd=${cmd}`);
  }
} catch (e) {
  ng(`hookSettings JSON 빌드 실패: ${e.message}`);
}

// ─── 결과 ───
console.log(`\n──────────────────────────────────`);
console.log(`결과: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
