// v0.7.48 — REA(Reverse Engineer Anything) MCP 선택적 연동 회귀 테스트.
//
// 핵심 불변식:
//   1. 평소 대화(프로필에 rea 없음)는 REA 가 절대 주입되지 않는다 (컨텍스트 비용 0).
//   2. reaMcp 토글 + projectMode + 프로필 mcpServers=rea + 고정 버전 설치 + Node 버전 + 지원 엔진
//      — 하나라도 빠지면 주입 안 됨.
//   3. 런타임/파괴적 도구는 allowReaRuntime=true 일 때만 열린다 (Claude disallowed / Codex disabled_tools).
//   4. Codex 는 전역 config.toml 이 아니라 thread/start·resume config 로만 주입한다.
//   5. 전역 setup(~/.claude.json 등 수정) 경로가 소스에 없다.
// 외부 설치(REA)·네트워크 없이 돈다 (fs 는 주입식 가짜 사용).
// 실행: node test-rea-mcp.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  REA_PINNED_VERSION,
  REA_RUNTIME_TOOLS,
  REA_SERVER_ENV,
  buildReaClaudeServer,
  buildReaCodexConfig,
  buildReaGuidance,
  decideRea,
  detectReaInstall,
  nodeSatisfiesRea,
  pickReaNode,
  profileRequestsRea,
  reaClaudeDisallowed,
} from "./src/rea-mcp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf-8").replace(/\r\n/g, "\n");

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

const ON = { reaMcp: true, projectMode: true };
const PROFILE = { name: "x", mcpServers: ["rea"] };
const INSTALL_OK = { ok: true, entry: "C:/h/.kda/tools/rea/node_modules/rea-agents/scripts/rea.mjs", version: REA_PINNED_VERSION };
const base = { flags: ON, profile: PROFILE, install: INSTALL_OK, nodeVersion: "v22.19.0", provider: "claude" };

console.log("\n[1] 결정 로직 (decideRea)");
check("모든 조건 충족 → enabled, 기본 runtime 차단", () => {
  const d = decideRea(base);
  assert.equal(d.enabled, true);
  assert.equal(d.allowRuntime, false);
  assert.equal(d.entry, INSTALL_OK.entry);
});
check("프로필에 rea 없음 → off + requested=false (안내도 없음)", () => {
  for (const profile of [undefined, null, {}, { mcpServers: [] }, { mcpServers: ["other"] }, { mcpServers: "rea" }]) {
    const d = decideRea({ ...base, profile });
    assert.equal(d.enabled, false);
    assert.equal(d.requested, false);
    assert.equal(buildReaGuidance(d), "");
  }
});
check("프로필 이름 대소문자/공백 무시", () => {
  assert.equal(profileRequestsRea({ mcpServers: ["  REA "] }), true);
});
check("reaMcp 토글 OFF → off", () => {
  assert.equal(decideRea({ ...base, flags: { ...ON, reaMcp: false } }).enabled, false);
  assert.equal(decideRea({ ...base, flags: { projectMode: true } }).enabled, false);
});
check("projectMode OFF → off", () => {
  assert.equal(decideRea({ ...base, flags: { ...ON, projectMode: false } }).enabled, false);
});
check("지원 엔진은 claude/codex 만", () => {
  assert.equal(decideRea({ ...base, provider: "codex" }).enabled, true);
  for (const provider of ["gemini-cli", "anthropic", "openai", "gemini", "openrouter", "chatgpt-web"]) {
    assert.equal(decideRea({ ...base, provider }).enabled, false, provider);
  }
});
check("미설치/버전 불일치 → off + 사유 노출", () => {
  const d = decideRea({ ...base, install: { ok: false, reason: "REA 버전 불일치 (설치 6.6.0, 고정 6.5.0)" } });
  assert.equal(d.enabled, false);
  assert.match(buildReaGuidance(d), /비활성.*버전 불일치/);
  assert.equal(decideRea({ ...base, install: null }).enabled, false);
});
check("Node 최소 버전 22.19 / 24.11 / 26+", () => {
  assert.equal(nodeSatisfiesRea("v22.19.0"), true);
  assert.equal(nodeSatisfiesRea("v22.18.9"), false);
  assert.equal(nodeSatisfiesRea("v24.10.0"), false);
  assert.equal(nodeSatisfiesRea("v24.11.0"), true);
  assert.equal(nodeSatisfiesRea("v23.9.0"), false);
  assert.equal(nodeSatisfiesRea("v26.0.0"), true);
  assert.equal(nodeSatisfiesRea("v20.1.0"), false);
  assert.equal(nodeSatisfiesRea("garbage"), false);
  assert.equal(decideRea({ ...base, nodeVersion: "v20.11.0" }).enabled, false);
});
check("allowReaRuntime=true 일 때만 runtime 허용 (truthy 문자열 불인정)", () => {
  assert.equal(decideRea({ ...base, profile: { ...PROFILE, allowReaRuntime: true } }).allowRuntime, true);
  assert.equal(decideRea({ ...base, profile: { ...PROFILE, allowReaRuntime: "true" } }).allowRuntime, false);
});

check("pickReaNode: 번들 v20 건너뛰고 PATH v22.19 선택, 버전 없는 후보 무시", () => {
  const picked = pickReaNode([
    { path: "C:/KDA/node-bundle/node.exe", version: "v20.18.0" },
    { path: "C:/broken/node.exe", version: null },
    { path: "C:/Program Files/nodejs/node.exe", version: "v22.19.0\n" },
    { path: "C:/later/node.exe", version: "v26.1.0" },
  ]);
  assert.deepEqual(picked, { path: "C:/Program Files/nodejs/node.exe", version: "v22.19.0" });
  assert.equal(pickReaNode([{ path: "C:/KDA/node-bundle/node.exe", version: "v20.18.0" }]), null);
  assert.equal(pickReaNode([{ path: "", version: "v24.11.0" }]), null);
  assert.equal(pickReaNode(null), null);
});

console.log("\n[2] 설치 탐지 (detectReaInstall — 가짜 fs)");
const fakeFs = (files) => ({
  existsSync: (p) => Object.keys(files).some((k) => path.normalize(p).endsWith(path.normalize(k))),
  readFileSync: (p) => {
    const k = Object.keys(files).find((f) => path.normalize(p).endsWith(path.normalize(f)));
    if (!k) throw new Error("ENOENT");
    return files[k];
  },
});
const PKG = "node_modules/rea-agents/package.json";
const ENTRY = "node_modules/rea-agents/scripts/rea.mjs";
check("고정 버전 + entry 존재 → ok", () => {
  const r = detectReaInstall("/h", fakeFs({ [PKG]: JSON.stringify({ version: REA_PINNED_VERSION }), [ENTRY]: "" }));
  assert.equal(r.ok, true);
  assert.ok(r.entry.endsWith(path.normalize(ENTRY)));
});
check("BOM 있는 package.json 도 읽음", () => {
  const r = detectReaInstall("/h", fakeFs({ [PKG]: "\uFEFF" + JSON.stringify({ version: REA_PINNED_VERSION }), [ENTRY]: "" }));
  assert.equal(r.ok, true);
});
check("버전 불일치 → ok=false", () => {
  const r = detectReaInstall("/h", fakeFs({ [PKG]: JSON.stringify({ version: "6.6.0" }), [ENTRY]: "" }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /버전 불일치/);
});
check("entry 없음/깨진 JSON → throw 없이 ok=false", () => {
  assert.equal(detectReaInstall("/h", fakeFs({ [PKG]: JSON.stringify({ version: REA_PINNED_VERSION }) })).ok, false);
  assert.equal(detectReaInstall("/h", fakeFs({ [PKG]: "{", [ENTRY]: "" })).ok, false);
});

console.log("\n[3] 주입 형태");
check("Claude 서버: node + entry mcp + compact 스키마 env", () => {
  const s = buildReaClaudeServer("C:/node.exe", "C:/e/rea.mjs");
  assert.deepEqual(s, { type: "stdio", command: "C:/node.exe", args: ["C:/e/rea.mjs", "mcp"], env: { ...REA_SERVER_ENV } });
  assert.equal(REA_SERVER_ENV.REA_MCP_INPUT_SCHEMA_PROFILE, "compact");
  assert.equal(REA_SERVER_ENV.REA_MCP_OUTPUT_SCHEMA_PROFILE, "off");
});
check("런타임 도구 목록 59개, 중복 없음, 핵심 위험 도구 포함", () => {
  assert.equal(REA_RUNTIME_TOOLS.length, 59);
  assert.equal(new Set(REA_RUNTIME_TOOLS).size, 59);
  for (const t of ["gdb_console", "instrument_with_frida", "install_adb_package", "capture_process_scenario", "execute_rizin_command", "set_comment"]) {
    assert.ok(REA_RUNTIME_TOOLS.includes(t), t);
  }
  for (const t of ["analyze_javascript_application", "inspect_managed_artifact", "trace_application_feature"]) {
    assert.ok(!REA_RUNTIME_TOOLS.includes(t), t);
  }
});
check("Claude disallowed: 기본 59개 mcp__rea__*, 허용 시 0개", () => {
  const d = reaClaudeDisallowed(false);
  assert.equal(d.length, 59);
  assert.ok(d.every((t) => t.startsWith("mcp__rea__")));
  assert.deepEqual(reaClaudeDisallowed(true), []);
});
check("Codex config: mcp_servers.rea + disabled_tools(기본) / 없음(허용)", () => {
  const c = buildReaCodexConfig("C:/node.exe", "C:/e/rea.mjs", false);
  assert.deepEqual(Object.keys(c.mcp_servers), ["rea"]);
  assert.equal(c.mcp_servers.rea.disabled_tools.length, 59);
  assert.equal(c.mcp_servers.rea.startup_timeout_sec, 60);
  assert.equal("disabled_tools" in buildReaCodexConfig("n", "e", true).mcp_servers.rea, false);
});
check("안내문: 활성 시 고정 버전/정적 전용/전역 setup 금지 명시", () => {
  const g = buildReaGuidance(decideRea(base));
  assert.match(g, new RegExp(`REA ${REA_PINNED_VERSION.replace(/\./g, "\\.")}`));
  assert.match(g, /정적 분석 도구만/);
  assert.match(g, /전역 setup/);
  assert.match(buildReaGuidance(decideRea({ ...base, profile: { ...PROFILE, allowReaRuntime: true } })), /K 의 확인/);
});

console.log("\n[4] 배선 (sidecar / bridge / Rust / frontend)");
const idx = read("sidecar/src/index.ts");
const bridgeSrc = read("sidecar/src/codex-app-server-bridge.mjs");
const lib = read("src-tauri/src/lib.rs");
const settings = read("src/components/Settings.tsx");
const db = read("src/db.ts");
const dialog = read("src/components/FolderInstructionsDialog.tsx");
const sidecarPkg = JSON.parse(read("sidecar/package.json"));
check("AgentFlags 에 reaMcp 기본 false + 정적 게이트 빈 목록", () => {
  assert.match(idx, /reaMcp: boolean;/);
  assert.match(idx, /projectMode: false,\n  reaMcp: false,\n\};/);
  assert.match(idx, /reaMcp: \[\],/);
});
check("ProjectProfile 에 mcpServers / allowReaRuntime", () => {
  assert.match(idx, /interface ProjectProfile \{[\s\S]*?mcpServers\?: string\[\];[\s\S]*?allowReaRuntime\?: boolean;[\s\S]*?\}/);
});
check("Claude 경로: 조건부 mcpConfig.rea + disallowed 병합 + 안내", () => {
  assert.match(idx, /resolveReaForTurn\(msg\.projectProfile, agentFlags, "claude"\)/);
  assert.match(idx, /if \(reaDecision\.enabled && reaDecision\.entry && reaDecision\.nodePath\) \{\n\s+mcpConfig\.rea = buildReaClaudeServer\(reaDecision\.nodePath, reaDecision\.entry\);/);
  assert.match(idx, /new Set\(\[\.\.\.toolFlags\.disallowed, \.\.\.gatedDisallowed, \.\.\.reaDisallowed\]\)/);
  assert.match(idx, /featureGuidance \+ reaGuidance;/);
});
check("Codex 경로: thread config 로만 주입 (전역 codex mcp add 아님)", () => {
  assert.match(idx, /resolveReaForTurn\(msg\.projectProfile, codexAgentFlags, "codex"\)/);
  assert.match(idx, /config: codexThreadConfig,/);
  assert.match(idx, /\+ buildReaGuidance\(codexReaDecision\);/);
  assert.match(bridgeSrc, /threadId: input\.threadId, approvalPolicy: "on-request", sandbox: "danger-full-access", \.\.\.threadConfig/);
  assert.match(bridgeSrc, /\.\.\.\(input\.model \? \{ model: input\.model \} : \{\}\), \.\.\.threadConfig/);
});
check("평소 대화는 설치 탐지(디스크 접근)·Node 탐지조차 안 함", () => {
  assert.match(idx, /const install = requested \? detectReaInstall\(os\.homedir\(\)\) : null;/);
  assert.match(idx, /const reaNode = requested \? resolveReaNodeRuntime\(\) : null;/);
});
check("번들 Node(v20) 회귀 방지: REA 는 sidecar execPath 가 아니라 선택된 런타임으로 실행", () => {
  assert.doesNotMatch(idx, /buildReaClaudeServer\(process\.execPath/);
  assert.doesNotMatch(idx, /buildReaCodexConfig\(process\.execPath/);
  assert.doesNotMatch(idx, /nodeVersion: process\.version,/);
  assert.match(idx, /buildReaCodexConfig\(codexReaDecision\.nodePath,/);
  assert.match(idx, /process\.env\.KDA_REA_NODE/);
});
check("전역 setup / npx 동적 실행 경로 없음", () => {
  for (const src of [idx, bridgeSrc, lib]) {
    assert.doesNotMatch(src, /rea-agents(@[\w.]+)? setup/);
    assert.doesNotMatch(src, /npx[^\n]*rea-agents/);
  }
});
check("빌드가 rea-mcp.mjs 를 dist 로 복사", () => {
  assert.match(sidecarPkg.scripts.build, /'rea-mcp\.mjs'/);
});
check("Rust: agent flag 키 7개에 reaMcp + rea_install_status 등록 + 고정 버전 동기화", () => {
  assert.match(lib, /const AGENT_FLAG_KEYS: \[&str; 7\] = \[[\s\S]*?"reaMcp",[\s\S]*?\];/);
  assert.match(lib, /async fn rea_install_status\(\)/);
  assert.match(lib, /\n\s+rea_install_status,\n/);
  const m = /const REA_PINNED_VERSION: &str = "([^"]+)";/.exec(lib);
  assert.equal(m?.[1], REA_PINNED_VERSION);
});
check("Settings: reaMcp 토글 + 설치 상태 표시", () => {
  assert.match(settings, /projectMode: false,\n\s+reaMcp: false,/);
  assert.match(settings, /reaMcp: !!f\?\.reaMcp,/);
  assert.match(settings, /key: "reaMcp",/);
  assert.match(settings, /invoke<[^>]*>\("rea_install_status"\)/);
});
check("db.ts: mcpServers / allowReaRuntime 파싱·저장 (런타임 단독 저장 금지)", () => {
  assert.match(db, /mcpServers\?: string\[\];/);
  assert.match(db, /const ms = strArr\(p\.mcpServers\);/);
  assert.match(db, /if \(p\.allowReaRuntime === true\) out\.allowReaRuntime = true;/);
  assert.match(db, /profile\.allowReaRuntime === true && ms\.some\(\(m\) => m\.toLowerCase\(\) === "rea"\)/);
});
check("폴더 대화상자: REA 사용 / 런타임 허용 체크박스 + 기타 MCP 이름 보존", () => {
  assert.match(dialog, /const \[projUseRea, setProjUseRea\]/);
  assert.match(dialog, /const \[projReaRuntime, setProjReaRuntime\]/);
  assert.match(dialog, /const mcp = \[\.\.\.otherMcpServers, \.\.\.\(projUseRea \? \["rea"\] : \[\]\)\];/);
  assert.match(dialog, /if \(projUseRea && projReaRuntime\) profile\.allowReaRuntime = true;/);
  assert.match(dialog, /disabled=\{saving \|\| !projUseRea\}/);
});

console.log("\n[5] 브리지 행위 — thread config 전달 (mock app-server)");
async function runBridge(start) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kda-rea-bridge-"));
  const capture = path.join(dir, "capture.jsonl");
  try {
    const proc = spawn(process.execPath, [path.join(here, "src", "codex-app-server-bridge.mjs")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, KDA_CAPTURE_FILE: capture },
    });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    const events = [];
    readline.createInterface({ input: proc.stdout }).on("line", (l) => events.push(JSON.parse(l)));
    proc.stdin.write(JSON.stringify({
      type: "start", codex: path.join(here, "test-fixtures", "mock-config-capture-server.cmd"), prompt: "p", ...start,
    }) + "\n");
    const timer = setTimeout(() => proc.kill(), 20000);
    const [code] = await once(proc, "close");
    clearTimeout(timer);
    assert.equal(code, 0, stderr);
    assert.equal(events.filter((e) => e.type === "turn.completed").length, 1);
    assert.ok(existsSync(capture), "mock 이 thread 요청을 받지 못함");
    return readFileSync(capture, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const cfg = buildReaCodexConfig("C:/node.exe", "C:/e/rea.mjs", false);
const bridgeCases = [
  ["새 스레드: config 전달", { config: cfg }, "thread/start", true],
  ["resume: config 전달", { threadId: "t-1", config: cfg }, "thread/resume", true],
  ["config 없음/null/배열 → 필드 자체 없음", { config: null }, "thread/start", false],
  ["배열 config 거부", { config: [1] }, "thread/start", false],
];
for (const [name, start, method, expectConfig] of bridgeCases) {
  try {
    const rows = await runBridge(start);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].method, method);
    if (expectConfig) assert.deepEqual(rows[0].params.config, cfg);
    else assert.equal("config" in rows[0].params, false);
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
