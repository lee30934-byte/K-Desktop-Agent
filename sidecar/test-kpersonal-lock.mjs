// v0.7.82 — k-personal(MCP 도구) 버전핀 + 다른 PC 자동 업그레이드 경로 회귀 검사.
// 이 검사가 막는 사고:
//  - CI 가 K-Personal-MCP main HEAD 를 그대로 번들 (검증 안 된 코드 배포)
//  - tauri.conf 의 bundled-mcp 파일 목록이 손으로 적혀 새 모듈(tool_errors/input_guard)이 빠짐
//  - 이미 설치된 PC 의 k-personal 이 KDA 업데이트 후에도 옛 버전으로 남음
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error(`FAIL ${name}`);
  passed += 1;
  console.log(`ok ${name}`);
}

const lock = JSON.parse(read("kpersonal.lock.json"));
ok("lock commit is a full sha", /^[0-9a-f]{40}$/.test(lock.commit));
ok("lock kpmVersion is a positive integer", Number.isInteger(lock.kpmVersion) && lock.kpmVersion >= 2);

const yml = read(".github/workflows/release.yml");
ok("release.yml reads kpersonal.lock.json", yml.includes("kpersonal.lock.json"));
ok("release.yml checks out the locked commit", /git checkout --quiet \$lock\.commit/.test(yml));
ok("release.yml verifies KPM_VERSION", yml.includes("bundled-mcp/KPM_VERSION"));
ok("release.yml no longer bundles main HEAD shallow", !yml.includes("git clone --depth=1 https://github.com/lee30934-byte/K-Personal-MCP.git"));

const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const res = conf.bundle.resources;
ok("bundle uses bundled-mcp glob", res.includes("../bundled-mcp/**/*"));
ok("bundle has no hand-written bundled-mcp file list", res.filter((r) => r.startsWith("../bundled-mcp/")).length === 1);

const lib = read("src-tauri/src/lib.rs");
ok("lib.rs declares kpersonal_upgrade module", lib.includes("mod kpersonal_upgrade;"));
ok("setup spawns k-personal upgrade", /deploy_bundled_mcp_if_needed\(\);\n[^\n]*\n\s*spawn_kpersonal_upgrade\(handle\.clone\(\)\);/.test(lib));
ok("status command registered", /\n\s*get_kpersonal_update_status,\n/.test(lib));
const up = read("src-tauri/src/kpersonal_upgrade.rs");
ok("upgrade embeds lock file", up.includes('include_str!("../../kpersonal.lock.json")'));
ok("upgrade refuses local changes", up.includes("--untracked-files=no") && up.includes("LOCAL_CHANGES:"));
ok("upgrade uses ff-only", up.includes('"--ff-only"'));
ok("upgrade backs up before overwrite", up.includes("backups") && up.includes("백업 실패"));
ok("KPM_VERSION written only after pip", up.indexOf("pip_install(target)") < up.indexOf('bundle.join("KPM_VERSION")'));

const app = read("src/App.tsx");
ok("App listens kpersonal-update", app.includes('listen("kpersonal-update"'));
ok("App reads stored status for race", app.includes('invoke("get_kpersonal_update_status")'));

const src = read("src/kpersonalUpdate.ts");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { describeKpersonalUpdate } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const now = 1_800_000_000;
ok("failed -> error notice", describeKpersonalUpdate({ state: "failed", error: "x", at: now }, now)?.kind === "error");
ok("upgraded -> ok notice", describeKpersonalUpdate({ state: "upgraded", fromVersion: 1, toVersion: 2, at: now }, now)?.text.includes("v1 → v2"));
ok("current -> no notice", describeKpersonalUpdate({ state: "current", at: now }, now) === null);
ok("stale result -> no notice", describeKpersonalUpdate({ state: "failed", at: now - 601 }, now) === null);
ok("garbage -> no notice", describeKpersonalUpdate("x", now) === null && describeKpersonalUpdate(null, now) === null);

console.log(`\nkpersonal-lock: ${passed} passed`);
