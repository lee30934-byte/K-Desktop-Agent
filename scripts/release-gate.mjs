#!/usr/bin/env node
// Phase 139 (v0.7.10) — #8 릴리스 전 자동 게이트.
//
// 동기 (왜 만들었나): v0.7.7~0.7.9 세 번 연속 릴리스가 모두 "사람이 체크리스트를
// 까먹어서" 버그를 동봉했다 — package-lock 버전 불일치, secret BOM 주입,
// webview2 캐시 stale, OAuth 상수 push 차단, 삭제했던 PDF 기능 재유입. 이걸
// 사람 기억이 아니라 스크립트가 강제하도록 단일 게이트로 묶는다.
//
// 이 게이트는 기존 인프라를 "중복 없이" 감싼다:
//   - 버전 동기화      → release-version-guard.mjs `check` 를 spawn (재사용)
//   - 회귀테스트 일괄  → sidecar/test-*.mjs 전부 실행 + 집계 (기존엔 러너 없었음)
//   - 금지 의존성/기능 → package.json deps + 삭제된 소스 파일 재유입 차단
//   - webview 캐시 메타 → index.html 의 no-cache 메타 3종 검증
//   - 빌드 / cargo     → npm run build, sidecar tsc, cargo check (--fast 면 생략)
//   - changelog        → 현재 버전 엔트리 존재 확인 + (--changelog-draft 면 초안 생성)
//
// 사용:
//   node scripts/release-gate.mjs              # 전체 게이트 (빌드 포함, 느림)
//   node scripts/release-gate.mjs --fast       # 정적 검사 + 회귀테스트만 (빌드/cargo 생략)
//   node scripts/release-gate.mjs --changelog-draft   # 마지막 tag 이후 커밋으로 초안 출력
//
// 종료 코드: 0 = 전부 통과, 1 = 하나라도 FAIL. WARN 은 통과로 친다(릴리스 차단 안 함).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const FAST = args.has("--fast");
const WANT_DRAFT = args.has("--changelog-draft");

// ─── 금지 목록 (삭제했던 기능이 다시 기어들어오는 것 차단) ────────────────────
// K 가 새 금지 항목을 추가하려면 여기에만 적으면 된다.
const FORBIDDEN_DEPS = ["pdf2json"]; // v0.7.8 에서 떼어낸 PDF 추출 의존성
const FORBIDDEN_FILES = [
  "sidecar/src/pdfText.ts",
  "sidecar/src/pdf-extract-cli.ts",
  "scripts/extract-pdf-text.ps1",
  "scripts/smoke-pdf-extraction.ps1",
];

// 환경 의존 회귀테스트: 순수 소스 정적 검사가 아니라 런타임 자원이 필요한 테스트.
// 예) test-headless-mcp.mjs 는 Python 을 spawn 하고 K-Personal-MCP server.py +
// 빌드된 sidecar/dist/index.js 를 읽는다. 이것들은 CI 의 fast 게이트 단계(빌드·MCP
// fetch 이전)나 깨끗한 체크아웃엔 없으므로 --fast 에선 건너뛴다(로컬 전체 게이트는 실행).
// 근본 원인: 모든 test-*.mjs 가 정적 검사라는 가정이 틀렸음 → 환경 의존분을 명시 분리.
const ENV_DEPENDENT_TESTS = new Set(["test-headless-mcp.mjs"]);

// ─── 결과 수집 ────────────────────────────────────────────────────────────
const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail: detail || "" });
  const icon = status === "PASS" ? "✅" : status === "WARN" ? "⚠️ " : status === "SKIP" ? "⏭️ " : "❌";
  console.log(`  ${icon} [${status}] ${name}${detail ? " — " + detail : ""}`);
}

function readText(rel) {
  return fs.readFileSync(path.join(rootPath, rel), "utf8");
}
function exists(rel) {
  return fs.existsSync(path.join(rootPath, rel));
}
function readJson(rel) {
  return JSON.parse(readText(rel));
}

// ─── 1. 버전 동기화 (guard 재사용) ────────────────────────────────────────
function checkVersionSync() {
  console.log("\n[1] 버전 파일 동기화 (release-version-guard check 재사용)");
  const r = spawnSync(process.execPath, [path.join(rootPath, "scripts", "release-version-guard.mjs"), "check"], {
    cwd: rootPath,
    encoding: "utf8",
  });
  const out = (r.stdout || "").trim();
  const err = (r.stderr || "").trim();
  if (r.status === 0) {
    record("version-sync", "PASS", out.replace(/^OK\s*/, ""));
  } else {
    record("version-sync", "FAIL", err || out || "guard check 실패");
  }
}

// ─── 2. webview2 캐시 stale 방지 메타 ─────────────────────────────────────
function checkWebviewCacheMeta() {
  console.log("\n[2] webview2 캐시 stale 방지 메타 (index.html)");
  let html;
  try {
    html = readText("index.html");
  } catch {
    record("webview-cache-meta", "FAIL", "index.html 을 읽을 수 없음");
    return;
  }
  const needles = [
    { re: /http-equiv=["']Cache-Control["'][^>]*no-cache/i, label: "Cache-Control no-cache" },
    { re: /http-equiv=["']Pragma["'][^>]*no-cache/i, label: "Pragma no-cache" },
    { re: /http-equiv=["']Expires["'][^>]*content=["']0["']/i, label: "Expires 0" },
  ];
  const missing = needles.filter((n) => !n.re.test(html)).map((n) => n.label);
  if (missing.length === 0) {
    record("webview-cache-meta", "PASS", "no-cache 메타 3종 존재");
  } else {
    record("webview-cache-meta", "FAIL", `누락: ${missing.join(", ")} — in-app 업데이트 후 옛 번들 캐시 위험`);
  }
}

// ─── 3. 금지 의존성 / 삭제 기능 재유입 ────────────────────────────────────
function checkForbidden() {
  console.log("\n[3] 금지 의존성 / 삭제 기능 재유입 차단");
  const depSources = ["package.json", "sidecar/package.json"];
  const foundDeps = [];
  for (const src of depSources) {
    if (!exists(src)) continue;
    let pkg;
    try {
      pkg = readJson(src);
    } catch {
      continue;
    }
    const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const dep of FORBIDDEN_DEPS) {
      if (all[dep]) foundDeps.push(`${dep} (${src})`);
    }
  }
  if (foundDeps.length === 0) {
    record("forbidden-deps", "PASS", `금지 의존성 없음 (${FORBIDDEN_DEPS.join(", ")})`);
  } else {
    record("forbidden-deps", "FAIL", `재유입: ${foundDeps.join(", ")}`);
  }

  const foundFiles = FORBIDDEN_FILES.filter((f) => exists(f));
  if (foundFiles.length === 0) {
    record("forbidden-files", "PASS", `삭제된 소스 파일 없음 (${FORBIDDEN_FILES.length}개 감시)`);
  } else {
    record("forbidden-files", "FAIL", `부활: ${foundFiles.join(", ")}`);
  }
}

// ─── 4. 회귀테스트 일괄 실행 + 집계 ───────────────────────────────────────
function runRegressionTests() {
  console.log("\n[4] 회귀테스트 (sidecar/test-*.mjs 전부)");
  const sidecarDir = path.join(rootPath, "sidecar");
  let files;
  try {
    files = fs.readdirSync(sidecarDir).filter((f) => /^test-.*\.mjs$/.test(f)).sort();
  } catch {
    record("regression", "FAIL", "sidecar 디렉터리를 읽을 수 없음");
    return;
  }
  if (files.length === 0) {
    record("regression", "WARN", "회귀테스트 파일이 없음");
    return;
  }
  let failed = 0;
  let totalPass = 0;
  let totalAll = 0;
  let skipped = 0;
  for (const f of files) {
    if (FAST && ENV_DEPENDENT_TESTS.has(f)) {
      skipped++;
      console.log(`     · ${f}: ⏭️  SKIP (환경 의존 — Python/MCP/dist 필요, --fast 제외)`);
      continue;
    }
    const r = spawnSync(process.execPath, [f], { cwd: sidecarDir, encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    const m = /결과:\s*(\d+)\/(\d+)\s*통과/.exec(out);
    if (m) {
      totalPass += Number(m[1]);
      totalAll += Number(m[2]);
    }
    if (r.status === 0) {
      console.log(`     · ${f}: ${m ? m[1] + "/" + m[2] : "통과"}`);
    } else {
      failed++;
      console.log(`     · ${f}: ❌ exit ${r.status} ${m ? "(" + m[1] + "/" + m[2] + ")" : ""}`);
    }
  }
  const ran = files.length - skipped;
  const skipNote = skipped > 0 ? `, ${skipped}개 환경의존 SKIP` : "";
  if (failed === 0) {
    record("regression", "PASS", `${ran}개 파일, ${totalPass}/${totalAll} assertion 통과${skipNote}`);
  } else {
    record("regression", "FAIL", `${failed}/${ran}개 파일 실패${skipNote}`);
  }
}

// ─── 5. changelog 엔트리 / 초안 ───────────────────────────────────────────
function checkChangelog() {
  console.log("\n[5] CHANGELOG 현재 버전 엔트리");
  let version;
  try {
    version = readJson("package.json").version;
  } catch {
    record("changelog", "FAIL", "package.json version 읽기 실패");
    return;
  }
  let changelog = "";
  try {
    changelog = readText("CHANGELOG.md");
  } catch {
    record("changelog", "FAIL", "CHANGELOG.md 없음");
    return;
  }
  const pattern = new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}`, "m");
  if (pattern.test(changelog)) {
    record("changelog", "PASS", `## [${version}] 엔트리 존재`);
  } else {
    // 릴리스 직전엔 FAIL 이어야 하나, 개발 중엔 아직 미작성이 정상 → WARN.
    record("changelog", "WARN", `## [${version}] 엔트리 아직 없음 — 릴리스 전 작성 필요 (--changelog-draft 로 초안 생성)`);
  }
}

function generateChangelogDraft() {
  console.log("\n[초안] 마지막 tag 이후 커밋 → CHANGELOG 초안");
  let lastTag = "";
  try {
    lastTag = execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"], {
      cwd: rootPath,
      encoding: "utf8",
    }).trim();
  } catch {
    lastTag = "";
  }
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  let log = "";
  try {
    log = execFileSync("git", ["log", range, "--no-merges", "--pretty=format:%s"], {
      cwd: rootPath,
      encoding: "utf8",
    }).trim();
  } catch {
    console.log("  (git log 실패 — git 저장소가 아닐 수 있음)");
    return;
  }
  const version = readJson("package.json").version;
  const date = new Date().toISOString().slice(0, 10);
  const lines = log ? log.split(/\r?\n/).filter(Boolean) : [];
  console.log("");
  console.log(`## [${version}] - ${date}`);
  console.log("");
  console.log("### Changed");
  if (lines.length === 0) {
    console.log(`- (${lastTag || "초기"} 이후 커밋 없음)`);
  } else {
    for (const l of lines) console.log(`- ${l}`);
  }
  console.log("");
  console.log(`  (위 초안을 검토·분류해 CHANGELOG.md 의 [Unreleased] 아래에 붙여넣으세요. ${lines.length}개 커밋, range=${range})`);
}

// ─── 6. 빌드 / cargo (heavy, --fast 면 생략) ──────────────────────────────
function runHeavyBuilds() {
  if (FAST) {
    console.log("\n[6] 빌드 검증 [SKIP --fast]");
    record("sidecar-build", "SKIP", "--fast");
    record("frontend-build", "SKIP", "--fast");
    record("cargo-check", "SKIP", "--fast");
    return;
  }
  console.log("\n[6] 빌드 검증 (sidecar tsc / frontend build / cargo check)");

  // 6a. sidecar tsc
  const sc = spawnSync(npmCmd(), ["run", "build"], {
    cwd: path.join(rootPath, "sidecar"),
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  record("sidecar-build", sc.status === 0 ? "PASS" : "FAIL", sc.status === 0 ? "tsc 통과" : tail(sc.stderr || sc.stdout));

  // 6b. frontend build (tsc && vite build)
  const fe = spawnSync(npmCmd(), ["run", "build"], {
    cwd: rootPath,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  record("frontend-build", fe.status === 0 ? "PASS" : "FAIL", fe.status === 0 ? "tsc && vite build 통과" : tail(fe.stderr || fe.stdout));

  // 6c. cargo check
  const cc = spawnSync("cargo", ["check", "--quiet"], {
    cwd: path.join(rootPath, "src-tauri"),
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (cc.error) {
    record("cargo-check", "WARN", "cargo 미설치 — Rust 검증 생략");
  } else {
    record("cargo-check", cc.status === 0 ? "PASS" : "FAIL", cc.status === 0 ? "cargo check 통과" : tail(cc.stderr || cc.stdout));
  }
}

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
function tail(s) {
  if (!s) return "(no output)";
  const lines = s.trim().split(/\r?\n/);
  return lines.slice(-3).join(" | ");
}

// ─── 메인 ─────────────────────────────────────────────────────────────────
console.log(`릴리스 전 자동 게이트 (#8)${FAST ? " [--fast]" : ""}\n`);

checkVersionSync();
checkWebviewCacheMeta();
checkForbidden();
runRegressionTests();
checkChangelog();
runHeavyBuilds();
if (WANT_DRAFT) generateChangelogDraft();

// ─── 요약 ─────────────────────────────────────────────────────────────────
const fails = results.filter((r) => r.status === "FAIL");
const warns = results.filter((r) => r.status === "WARN");
console.log("\n────────────────────────────────────────");
console.log(
  `요약: ${results.filter((r) => r.status === "PASS").length} PASS, ${warns.length} WARN, ${fails.length} FAIL, ${results.filter((r) => r.status === "SKIP").length} SKIP`,
);
if (fails.length > 0) {
  console.log(`\n❌ 릴리스 차단 — 다음 게이트 실패:`);
  for (const f of fails) console.log(`   - ${f.name}: ${f.detail}`);
  process.exit(1);
}
if (warns.length > 0) {
  console.log(`\n⚠️  통과(릴리스 가능)하나 확인 필요:`);
  for (const w of warns) console.log(`   - ${w.name}: ${w.detail}`);
}
console.log("\n✅ 릴리스 게이트 통과");
process.exit(0);
