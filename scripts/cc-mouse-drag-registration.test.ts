import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDesktopTool } from "../sidecar/src/desktopStall.ts";

// v0.7.88: k-personal KPM_VERSION 3 adds cc_mouse_drag (button-hold drag with input lock, target-window check and
// guaranteed release). It must be gated like the other input tools, or it is either unusable (missing from the
// permission map) or ungated (missing from Settings). The desktop guard remedy must point to it so real drag work
// is not attempted from the shell.
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function systemControlBlock(text: string): string {
  const start = text.indexOf("system_control: [");
  assert.ok(start >= 0, "system_control list present");
  return text.slice(start, text.indexOf("]", start));
}

test("cc_mouse_drag is in the system_control permission map next to cc_mouse_click", () => {
  const block = systemControlBlock(src("sidecar/src/index.ts"));
  assert.ok(block.includes('"mcp__k-personal__cc_mouse_click"'));
  assert.ok(block.includes('"mcp__k-personal__cc_mouse_drag"'));
});

test("the perm-gate mirror lists cc_mouse_drag too", () => {
  assert.ok(systemControlBlock(src("sidecar/test-perm-gate.mjs")).includes('"mcp__k-personal__cc_mouse_drag"'));
});

test("Settings shows cc_mouse_drag under system control and marks it destructive", () => {
  const line = src("src/components/Settings.tsx").split("\n").find((l) => l.includes('"mcp__k-personal__cc_mouse_drag"'));
  assert.ok(line, "Settings entry present");
  assert.match(line!, /destructive:\s*true/);
});

test("cc_mouse_drag counts as a desktop tool and the shell-input remedy names it", () => {
  assert.equal(isDesktopTool("mcp__k-personal__cc_mouse_drag"), true);
  assert.ok(src("sidecar/hooks/desktopBypass.mjs").includes("cc_mouse_drag"));
});

test("the bundled k-personal pin requires KPM_VERSION 3 (the version that ships cc_mouse_drag)", () => {
  const lock = JSON.parse(src("kpersonal.lock.json"));
  assert.ok(lock.kpmVersion >= 3, `kpmVersion ${lock.kpmVersion}`);
});
