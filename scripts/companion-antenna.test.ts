// v0.7.84 — companion antenna ball must not be cut flat (frames 3-8 incl. the working pose were).
// Runs scripts/check-companion-antenna.py over every head sheet/tier. Python + Pillow are required
// (same as the atlas build); a missing interpreter fails loudly instead of silently skipping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const root = new URL("..", import.meta.url);

test("every head cell keeps a round, glowing antenna ball", () => {
  const py = process.platform === "win32" ? "py" : "python3";
  const args = process.platform === "win32" ? ["-3", "scripts/check-companion-antenna.py"] : ["scripts/check-companion-antenna.py"];
  const r = spawnSync(py, args, { cwd: root, encoding: "utf8" });
  assert.ok(!r.error, `python not runnable: ${r.error?.message}`);
  assert.equal(r.status, 0, (r.stdout || "") + (r.stderr || ""));
  assert.match(r.stdout, /checked (\d+) head cells/);
  assert.ok(Number(/checked (\d+)/.exec(r.stdout)![1]) >= 108);
});

test("atlas build recovers the antenna strip from the cell above (green pixels only)", () => {
  const src = fs.readFileSync(new URL("scripts/build-companion-atlas.py", root), "utf8");
  assert.match(src, /ANTENNA_OVERFLOW = \d+/);
  assert.match(src, /sg > sr \+ 12/);
  assert.match(src, /canvas\[dy - ANTENNA_OVERFLOW:dy, dx:dx \+ S\] = ball_strip/);
});
