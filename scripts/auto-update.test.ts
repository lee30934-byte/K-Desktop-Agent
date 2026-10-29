// v0.7.57 — 릴리즈 후 자동 설치 판정 테스트.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  decideAutoUpdate, parseAutoUpdateRequest, compareSemver, updaterVersionMatches,
  AUTO_UPDATE_IDLE_MS, AUTO_UPDATE_EXPIRE_MS,
} from "../src/autoUpdate.ts";

const T0 = Date.parse("2026-10-29T12:00:00Z");
const req = (version = "0.7.57", at = T0) => JSON.stringify({ version, requestedAt: new Date(at).toISOString(), reason: "test" });
const base = { current: "0.7.56", now: T0 + 5 * 60_000, busy: false, idleSince: T0 };

test("요청 없음 → none", () => {
  assert.deepEqual(decideAutoUpdate({ ...base, raw: null }), { action: "none" });
  assert.deepEqual(decideAutoUpdate({ ...base, raw: "  " }), { action: "none" });
});

test("깨진 요청 → invalid (설치 안 함)", () => {
  assert.equal(decideAutoUpdate({ ...base, raw: "{" }).action, "invalid");
  assert.equal(decideAutoUpdate({ ...base, raw: JSON.stringify({ version: "latest", requestedAt: new Date(T0).toISOString() }) }).action, "invalid");
  assert.equal(decideAutoUpdate({ ...base, raw: JSON.stringify({ version: "0.7.57" }) }).action, "invalid");
});

test("BOM·v 접두 허용", () => {
  const p = parseAutoUpdateRequest("﻿" + JSON.stringify({ version: "v0.7.57", requestedAt: new Date(T0).toISOString() }));
  assert.ok(p && !("invalid" in p) && p.version === "0.7.57");
});

test("이미 같거나 높은 버전 → installed (다운그레이드 금지)", () => {
  assert.equal(decideAutoUpdate({ ...base, raw: req(), current: "0.7.57" }).action, "installed");
  assert.equal(decideAutoUpdate({ ...base, raw: req(), current: "0.7.58" }).action, "installed");
  assert.equal(decideAutoUpdate({ ...base, raw: req("0.7.57"), current: "0.8.0" }).action, "installed");
});

test("작업 중이면 대기, 한가한 시간이 90초 미만이어도 대기", () => {
  assert.deepEqual(decideAutoUpdate({ ...base, raw: req(), busy: true }), { action: "wait", why: "busy" });
  assert.deepEqual(decideAutoUpdate({ ...base, raw: req(), idleSince: null }), { action: "wait", why: "idle" });
  assert.deepEqual(decideAutoUpdate({ ...base, raw: req(), idleSince: base.now - AUTO_UPDATE_IDLE_MS + 1000 }), { action: "wait", why: "idle" });
});

test("한가 90초 이상 → install", () => {
  assert.deepEqual(decideAutoUpdate({ ...base, raw: req(), idleSince: base.now - AUTO_UPDATE_IDLE_MS }), { action: "install", version: "0.7.57" });
});

test("3시간 지난 요청 → expired (설치 안 함)", () => {
  assert.equal(decideAutoUpdate({ ...base, raw: req("0.7.57", T0), now: T0 + AUTO_UPDATE_EXPIRE_MS + 1 }).action, "expired");
});

test("버전 비교·업데이터 버전 일치 검사", () => {
  assert.equal(compareSemver("0.7.9", "0.7.10"), -1);
  assert.equal(compareSemver("0.7.57", "0.7.57"), 0);
  assert.equal(compareSemver("1.0.0", "0.9.99"), 1);
  assert.equal(updaterVersionMatches("0.7.57", "0.7.57"), true);
  assert.equal(updaterVersionMatches("0.7.58", "0.7.57"), false); // 더 높은 버전도 자동 설치 금지
  assert.equal(updaterVersionMatches(undefined, "0.7.57"), false);
});

test("App 배선: 폴링·한가 판정·서명 업데이터·버전 일치 검사·done 기록", () => {
  const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /invoke<string \| null>\("auto_update_request_read"\)/);
  assert.match(app, /activeConversationIds\(\)\.size > 0/);
  assert.match(app, /taskWatchTurnsRef\.current\.size > 0/);
  assert.match(app, /updaterVersionMatches\(update\.version, d\.version\)/);
  assert.ok(app.indexOf("updaterVersionMatches(update.version") < app.indexOf("await update.downloadAndInstall();"));
  assert.match(app, /setInterval\(\(\) => \{ void autoUpdateTickRef\.current\(\); \}, AUTO_UPDATE_POLL_MS\)/);
  const rs = fs.readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const c of ["auto_update_request_read", "auto_update_finish", "auto_update_log"]) {
    assert.match(rs, new RegExp(`fn ${c}\\(`));
    assert.match(rs, new RegExp(`^\\s*${c},\\s*$`, "m"));
  }
});
