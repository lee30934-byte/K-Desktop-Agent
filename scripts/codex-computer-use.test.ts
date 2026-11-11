// v0.7.84 / v0.7.86 — KDA 도구와 겹치는 Codex 내장 기능 차단 회귀 테스트.
// 2026-11-10: 다른 PC 의 Codex 가 내장 computer use 를 골라 턴이 헛돔 (npm CLI 에는 실행기 없음).
// 2026-11-11 K 확정: Codex 내장 화면/브라우저 기능은 쓰지 않고 KDA 도구(k-personal)로만 조작.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CODEX_DISABLED_FEATURES, codexAppServerArgs } from "../sidecar/src/codex-features.mjs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test("겹치는 내장 기능 목록: 화면·브라우저 조작은 끄고, 엔진 본체·음성·이미지·플러그인은 유지", () => {
  for (const f of ["computer_use", "browser_use", "browser_use_external", "in_app_browser"]) {
    assert.ok(CODEX_DISABLED_FEATURES.includes(f), f);
  }
  for (const keep of ["shell_tool", "unified_exec", "in_app_voice", "image_generation", "plugins", "apps", "skill_search"]) {
    assert.ok(!CODEX_DISABLED_FEATURES.includes(keep), keep);
  }
});

test("app-server 인자는 -c features.<x>=false 형식만 쓴다 (--disable 금지: 구버전 CLI 시작 실패, 2026-11-11 실측)", () => {
  const args = codexAppServerArgs();
  assert.deepEqual(args.slice(0, 2), ["app-server", "--stdio"]);
  const rest = args.slice(2);
  assert.equal(rest.length, CODEX_DISABLED_FEATURES.length * 2);
  for (let i = 0; i < rest.length; i += 2) {
    assert.equal(rest[i], "-c");
    assert.match(rest[i + 1], /^features\.[a-z_]+=false$/);
  }
  assert.ok(!args.includes("--disable"));
});

test("작업·음성 세션 모두 공용 인자로 Codex app-server 를 띄운다", () => {
  const bridge = read("../sidecar/src/codex-app-server-bridge.mjs");
  assert.match(bridge, /import \{ codexAppServerArgs \} from "\.\/codex-features\.mjs";/);
  assert.match(bridge, /spawn\(codex, codexAppServerArgs\(\), \{/);
  const voice = read("../sidecar/src/codex-voice.mjs");
  assert.match(voice, /import \{ codexAppServerArgs \} from '\.\/codex-features\.mjs';/);
  assert.match(voice, /spawnProcess\(codex, codexAppServerArgs\(\), \{/);
});

test("--disable 형식은 쓰지 않는다", () => {
  for (const f of ["../sidecar/src/codex-app-server-bridge.mjs", "../sidecar/src/codex-voice.mjs", "../sidecar/src/codex-features.mjs"]) {
    const code = read(f).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.doesNotMatch(code, /["']--disable["']/, f);
  }
});

test("sidecar 의 다른 곳에서 app-server 를 직접 인자로 띄우지 않는다 (우회 경로 없음)", () => {
  const dir = new URL("../sidecar/src/", import.meta.url);
  const offenders: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(ts|mjs|js)$/.test(name) || name === "codex-features.mjs") continue;
    const text = fs.readFileSync(new URL(name, dir), "utf8");
    if (/["']app-server["']\s*,\s*["']--stdio["']/.test(text)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});

test("빌드 때 세 파일을 dist 로 복사한다 (설치본에 적용)", () => {
  const pkg = JSON.parse(read("../sidecar/package.json"));
  for (const f of ["codex-app-server-bridge.mjs", "codex-voice.mjs", "codex-features.mjs"]) {
    assert.match(pkg.scripts.build, new RegExp(f.replace(/\./g, "\\.")));
  }
});
