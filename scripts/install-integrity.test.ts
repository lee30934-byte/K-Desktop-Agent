// v0.7.84 — 불완전 설치 감지 · 재설치 · 업데이터 실패 대체 경로 회귀 테스트.
// 배경: 2026-11-09 v0.7.83 설치를 중간에 취소 → 실행 파일만 새 버전, sidecar/hooks 는 옛 파일,
//       그런데 auto-update.done.json 은 "installed" (실행 파일 버전만 봤기 때문).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decideIncompleteAction, describeInstallIntegrity, parseIntegrity } from "../src/installIntegrity.ts";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("complete / dev / 해석 불가 상태는 알림 없음, 재설치 판정도 complete", () => {
  for (const v of [{ state: "complete", appVersion: "0.7.84" }, { state: "dev" }, null, "x", { state: "weird" }]) {
    assert.equal(describeInstallIntegrity(v), null);
    assert.equal(decideIncompleteAction(v), "complete");
  }
});

test("incomplete 는 버전·이유·지난 오류를 담은 알림", () => {
  const n = describeInstallIntegrity({ state: "incomplete", appVersion: "0.7.84", reason: "설치 완료 표시가 없습니다", lastRepairError: "HTTP 504" });
  assert.ok(n);
  assert.match(n!.text, /v0\.7\.84 설치가 끝까지 완료되지 않았습니다/);
  assert.match(n!.detail ?? "", /설치 완료 표시가 없습니다/);
  assert.match(n!.detail ?? "", /HTTP 504/);
});

test("자동 재설치는 버전별 한도 안에서만 (무한 반복 금지)", () => {
  assert.equal(decideIncompleteAction({ state: "incomplete", autoAttempts: 0, maxAutoAttempts: 2 }), "auto-repair");
  assert.equal(decideIncompleteAction({ state: "incomplete", autoAttempts: 1, maxAutoAttempts: 2 }), "auto-repair");
  assert.equal(decideIncompleteAction({ state: "incomplete", autoAttempts: 2, maxAutoAttempts: 2 }), "give-up");
  assert.equal(decideIncompleteAction({ state: "incomplete" }), "auto-repair");
  assert.equal(parseIntegrity({ state: "incomplete" })?.state, "incomplete");
});

test("NSIS: 시작 때 완료 표시 삭제, 마지막 단계에서 버전 기록", () => {
  const nsh = read("../src-tauri/installer-hooks.nsh");
  const pre = nsh.slice(nsh.indexOf("!macro NSIS_HOOK_PREINSTALL"), nsh.indexOf("!macroend"));
  assert.match(pre, /Delete "\$INSTDIR\\install-complete\.txt"/);
  const postStart = nsh.indexOf("!macro NSIS_HOOK_POSTINSTALL");
  const post = nsh.slice(postStart, nsh.indexOf("!macroend", postStart));
  assert.match(post, /FileOpen \$9 "\$INSTDIR\\install-complete\.txt" w\n\s*FileWrite \$9 "\$\{VERSION\}"/);
  // 표시 기록은 POSTINSTALL 의 마지막 동작이어야 한다 (중간 Goto 로 건너뛰지 않게 라벨 뒤)
  assert.ok(post.lastIndexOf("endPointerCheck:") < post.indexOf("install-complete.txt"));
});

test("클릭 실수 방지: 파일 복사 중 [취소] 비활성, 업데이트는 passive(선택 화면 없음)", () => {
  const nsh = read("../src-tauri/installer-hooks.nsh");
  const pre = nsh.slice(nsh.indexOf("!macro NSIS_HOOK_PREINSTALL"), nsh.indexOf("!macroend"));
  assert.match(pre, /GetDlgItem \$0 \$HWNDPARENT 2\n\s*EnableWindow \$0 0/);
  const conf = JSON.parse(read("../src-tauri/tauri.conf.json"));
  assert.equal(conf.plugins.updater.windows.installMode, "passive");
  const rs = read("../src-tauri/src/lib.rs");
  assert.match(rs, /"\/P"\.to_string\(\), "\/R"\.to_string\(\), "\/UPDATE"\.to_string\(\)/);
});

test("Rust: 시작 시 검사·이벤트, 명령 등록, 서명 검증 전에는 실행하지 않음", () => {
  const rs = read("../src-tauri/src/lib.rs");
  assert.match(rs, /^mod install_integrity;$/m);
  assert.match(rs, /run_install_integrity_check\(&handle\);/);
  assert.match(rs, /app\.emit\("install-integrity", v\)/);
  for (const c of ["get_install_integrity", "repair_install"]) {
    assert.match(rs, new RegExp(`fn ${c}\\(`));
    assert.match(rs, new RegExp(`^\\s*${c},\\s*$`, "m"));
  }
  const body = rs.slice(rs.indexOf("async fn repair_install("), rs.indexOf("async fn repair_install(") + 6000);
  assert.ok(body.indexOf("verify_signature(") > 0 && body.indexOf("verify_signature(") < body.indexOf("spawn_detached("), "verify before launch");
  assert.match(body, /MAX_AUTO_ATTEMPTS/);
  assert.match(body, /"\/P"\.to_string\(\), "\/R"\.to_string\(\)/);
  const mod = read("../src-tauri/src/install_integrity.rs");
  assert.match(mod, /fn download_direct\(/);
  assert.match(mod, /fn download_via_api\(/);
  assert.match(mod, /application\/octet-stream/);
});

test("App: installed 판정 전 무결성 확인, 업데이터 실패 시 대체 경로, 알림과 [다시 설치]", () => {
  const app = read("../src/App.tsx");
  const installedCase = app.slice(app.indexOf('case "installed": {'), app.indexOf('case "expired":'));
  assert.ok(installedCase.indexOf('invoke("get_install_integrity")') < installedCase.indexOf('finish("installed"'));
  assert.match(installedCase, /repair_install", \{ version: current, reason: "auto-update-incomplete", auto: true \}/);
  assert.match(installedCase, /finish\("incomplete"/);
  assert.match(app, /reason: "updater-failed", auto: true/);
  assert.match(app, /listen\("install-integrity"/);
  assert.match(app, /className="session-refresh-toast kpm-notice install-notice"/);
  assert.match(app, /repair_install", \{ reason: "manual", auto: false \}/);
  const uc = read("../src/components/UpdateChecker.tsx");
  assert.match(uc, /reason: 'manual-update-fallback'/);
  assert.match(uc, /다른 경로로 설치/);
});
