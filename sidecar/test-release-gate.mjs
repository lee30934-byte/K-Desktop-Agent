// Phase 139 (v0.7.10) — #8 릴리스 전 자동 게이트 정적 회귀 테스트.
//
// 검증 대상: scripts/release-gate.mjs 가 (1) 버전 동기화 guard 재사용 (2) webview 캐시
// 메타 검사 (3) 금지 의존성/삭제 파일 차단 (4) 회귀테스트 일괄 실행 (5) changelog 검사
// (6) 빌드/cargo (--fast 게이트) 단계를 모두 가지고, package.json 에 배선됐는지 확인.
// 주의: 이 테스트는 게이트를 "실행"하지 않는다 — 게이트가 sidecar/test-*.mjs 를 전부
// 돌리므로 실행하면 무한 재귀. 소스만 정적 검사.
// 실행: node test-release-gate.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const gate = readFileSync(path.join(root, "scripts", "release-gate.mjs"), "utf-8");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

console.log("Phase 139 — #8 릴리스 게이트 회귀 테스트\n");

// ── 1. 단계 함수 존재 ──────────────────────────────────────────────────────
console.log("[1] 게이트 단계 함수");
check("checkVersionSync 존재", /function checkVersionSync\(/.test(gate));
check("checkWebviewCacheMeta 존재", /function checkWebviewCacheMeta\(/.test(gate));
check("checkForbidden 존재", /function checkForbidden\(/.test(gate));
check("runRegressionTests 존재", /function runRegressionTests\(/.test(gate));
check("checkChangelog 존재", /function checkChangelog\(/.test(gate));
check("runHeavyBuilds 존재", /function runHeavyBuilds\(/.test(gate));
check("generateChangelogDraft 존재", /function generateChangelogDraft\(/.test(gate));

// ── 2. 버전 동기화 guard 재사용 (중복 금지) ────────────────────────────────
console.log("\n[2] release-version-guard 재사용 (로직 중복 X)");
check("release-version-guard.mjs 를 spawn", /release-version-guard\.mjs.*"check"|"check".*release-version-guard\.mjs/s.test(gate) || /release-version-guard\.mjs/.test(gate));
check("spawnSync 로 guard 실행", /spawnSync\(process\.execPath, \[path\.join\(rootPath, "scripts", "release-version-guard\.mjs"\), "check"\]/.test(gate));

// ── 3. webview 캐시 메타 3종 ───────────────────────────────────────────────
console.log("\n[3] webview2 캐시 메타 검증");
check("Cache-Control no-cache 검사", /Cache-Control\["']\["'\]\[\^>\]\*no-cache/.test(gate) || /Cache-Control[\s\S]{0,30}no-cache/.test(gate));
check("Pragma no-cache 검사", /Pragma[\s\S]{0,30}no-cache/.test(gate));
check("Expires 0 검사", /Expires[\s\S]{0,40}content/.test(gate));

// ── 4. 금지 의존성/파일 ────────────────────────────────────────────────────
console.log("\n[4] 금지 목록");
check("FORBIDDEN_DEPS 에 pdf2json", /FORBIDDEN_DEPS = \[[^\]]*"pdf2json"/.test(gate));
check("FORBIDDEN_FILES 에 pdfText.ts", /FORBIDDEN_FILES = \[[\s\S]*?pdfText\.ts/.test(gate));
check("package.json + sidecar/package.json deps 모두 스캔", /depSources = \["package\.json", "sidecar\/package\.json"\]/.test(gate));

// ── 5. 회귀테스트 일괄 실행 ────────────────────────────────────────────────
console.log("\n[5] 회귀테스트 러너");
check("sidecar test-*.mjs glob", /\^test-\.\*\\\.mjs\$/.test(gate));
check("결과 N/M 통과 파싱", /결과:\\s\*\(\\d\+\)\\\/\(\\d\+\)\\s\*통과/.test(gate));
check("자기 자신(test-release-gate)도 패턴에 포함되나 spawn 만 — 무한재귀 아님", /spawnSync\(process\.execPath, \[f\]/.test(gate));
check("ENV_DEPENDENT_TESTS 에 test-headless-mcp (환경 의존)", /ENV_DEPENDENT_TESTS = new Set\(\["test-headless-mcp\.mjs"\]\)/.test(gate));
check("--fast 면 환경 의존 테스트 SKIP (CI 빌드 전 단계 자원 부재 회피)", /if \(FAST && ENV_DEPENDENT_TESTS\.has\(f\)\) \{[\s\S]*?skipped\+\+;/.test(gate));

// ── 6. --fast 게이트 ───────────────────────────────────────────────────────
console.log("\n[6] --fast 플래그");
check("FAST 플래그 파싱", /const FAST = args\.has\("--fast"\)/.test(gate));
check("--fast 면 빌드/cargo SKIP", /if \(FAST\) \{[\s\S]*?record\("sidecar-build", "SKIP"/.test(gate));
check("WANT_DRAFT 플래그", /const WANT_DRAFT = args\.has\("--changelog-draft"\)/.test(gate));

// ── 7. 종료 코드 / 요약 ────────────────────────────────────────────────────
console.log("\n[7] 종료 코드 (FAIL 시 차단)");
check("FAIL 있으면 exit 1", /if \(fails\.length > 0\) \{[\s\S]*?process\.exit\(1\)/.test(gate));
check("WARN 은 통과 (릴리스 차단 안 함)", /통과\(릴리스 가능\)/.test(gate));
check("성공 시 exit 0", /process\.exit\(0\)/.test(gate));

// ── 8. package.json 배선 ───────────────────────────────────────────────────
console.log("\n[8] package.json npm 스크립트");
check("release:gate 스크립트", pkg.scripts?.["release:gate"] === "node scripts/release-gate.mjs");
check("release:gate:fast 스크립트", pkg.scripts?.["release:gate:fast"] === "node scripts/release-gate.mjs --fast");

console.log(`\n결과: ${pass}/${pass + fail} 통과`);
process.exit(fail > 0 ? 1 : 0);
