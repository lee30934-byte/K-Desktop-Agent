// v0.7.84 — Codex 내장 computer_use 차단 회귀 테스트.
// 2026-11-10: 다른 PC 의 Codex 가 내장 computer use 로 화면을 직접 조작 → KDA 입력 잠금·대상 창 확인·
// 실패 신호·멈춤 감시를 모두 우회. 화면 조작은 k-personal 경로 하나로만 하도록 모든 Codex 실행에서 끈다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test("대화 턴용 Codex app-server 는 computer_use 를 끄고 시작", () => {
  const src = read("../sidecar/src/codex-app-server-bridge.mjs");
  assert.match(src, /spawn\(codex, \["app-server", "--stdio", "-c", "features\.computer_use=false"\]/);
  assert.doesNotMatch(src, /spawn\(codex, \["app-server", "--stdio"\]/);
});

test("음성 세션용 Codex app-server 도 computer_use 를 끄고 시작", () => {
  const src = read("../sidecar/src/codex-voice.mjs");
  assert.match(src, /spawnProcess\(codex, \['app-server', '--stdio', '-c', 'features\.computer_use=false'\]/);
});

test("--disable 형식은 쓰지 않는다 (기능 이름을 모르는 구버전 Codex 가 시작 실패, 2026-11-11 실측)", () => {
  for (const f of ["../sidecar/src/codex-app-server-bridge.mjs", "../sidecar/src/codex-voice.mjs"]) {
    const code = read(f).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.doesNotMatch(code, /["']--disable["']/, f);
  }
});

test("sidecar 의 다른 곳에서 Codex app-server 를 따로 띄우지 않는다 (우회 경로 없음)", () => {
  const dir = new URL("../sidecar/src/", import.meta.url);
  const offenders: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(ts|mjs|js)$/.test(name)) continue;
    const text = fs.readFileSync(new URL(name, dir), "utf8");
    for (const m of text.matchAll(/["']app-server["']\s*,\s*["']--stdio["'](\s*\])?/g)) {
      if (m[1]) offenders.push(name); // --stdio 바로 뒤에서 인자 목록이 끝나면 computer_use 미차단
    }
  }
  assert.deepEqual(offenders, []);
});

test("빌드 시 두 파일이 dist 로 복사된다 (설치본에도 적용)", () => {
  const pkg = JSON.parse(read("../sidecar/package.json"));
  assert.match(pkg.scripts.build, /codex-app-server-bridge\.mjs/);
  assert.match(pkg.scripts.build, /codex-voice\.mjs/);
});
