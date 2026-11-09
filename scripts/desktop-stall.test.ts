import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DesktopStallMonitor, desktopStallMessage, isDesktopTool } from "../sidecar/src/desktopStall.ts";

test("only k-personal screen tools switch a turn into desktop mode", () => {
  assert.equal(isDesktopTool("mcp__k-personal__ui_click_by_name"), true);
  assert.equal(isDesktopTool("cc_mouse_click"), true);
  assert.equal(isDesktopTool("web_open"), true);
  assert.equal(isDesktopTool("Bash"), false);
  assert.equal(isDesktopTool("mcp__k-personal__db_memory_write"), false);
  assert.equal(isDesktopTool(undefined), false);
});

test("non-desktop turns never warn even after long silence", () => {
  const m = new DesktopStallMonitor(90_000, 180_000, 0);
  m.toolStarted("b1", "Bash", 0);
  m.toolDone("b1", 1_000);
  assert.equal(m.evaluate(10 * 60_000).state, "ok");
});

test("desktop turn: silence escalates to no_progress then stalled, reporting each change once", () => {
  const m = new DesktopStallMonitor(90_000, 180_000, 0);
  m.toolStarted("t1", "ui_find", 0);
  m.toolDone("t1", 1_000);
  assert.deepEqual(m.evaluate(60_000), { changed: false, state: "ok", idleMs: 59_000 });
  const warn = m.evaluate(91_000);
  assert.equal(warn.state, "no_progress"); assert.equal(warn.changed, true);
  assert.equal(m.evaluate(120_000).changed, false);
  const stall = m.evaluate(181_000);
  assert.equal(stall.state, "stalled"); assert.equal(stall.changed, true);
  m.progress(182_000);
  const back = m.evaluate(183_000);
  assert.equal(back.state, "ok"); assert.equal(back.changed, true);
});

test("a running tool is busy, not stalled", () => {
  const m = new DesktopStallMonitor(90_000, 180_000, 0);
  m.toolStarted("t1", "cc_screenshot", 0);
  m.toolStarted("b1", "Bash", 1_000);
  assert.equal(m.evaluate(10 * 60_000).state, "ok");
});

test("approval waits are reported as waiting_user, separate from stalls", () => {
  const m = new DesktopStallMonitor(90_000, 180_000, 0);
  m.toolStarted("t1", "ui_click_by_name", 0);
  m.waitStarted("approval-1", 1_000);
  assert.equal(m.evaluate(500_000).state, "waiting_user");
  m.waitEnded("approval-1", 500_000);
  m.toolDone("t1", 500_000);
  assert.equal(m.evaluate(501_000).state, "ok");
});

test("messages exist for every visible state and never for ok", () => {
  assert.equal(desktopStallMessage("ok", 0), null);
  assert.match(desktopStallMessage("no_progress", 91_000) ?? "", /91초/);
  assert.match(desktopStallMessage("stalled", 181_000) ?? "", /정지/);
  assert.match(desktopStallMessage("waiting_user", 0) ?? "", /승인/);
});

test("Claude and Codex turn paths both feed the monitor and emit desktop_stall", () => {
  const src = readFileSync(new URL("../sidecar/src/index.ts", import.meta.url), "utf8");
  const wires = src.match(/new DesktopStallMonitor\(/g) ?? [];
  assert.ok(wires.length >= 2, `monitor wired ${wires.length} times`);
  assert.ok((src.match(/type: "desktop_stall"/g) ?? []).length >= 1);
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /"desktop_stall"/);
});

test("toolBridge bounds screen-tool calls by family", () => {
  const src = readFileSync(new URL("../sidecar/src/toolBridge.ts", import.meta.url), "utf8");
  assert.match(src, /startsWith\('cc_'\)\) return 15_000/);
  assert.match(src, /startsWith\('ui_'\)\) return 20_000/);
  assert.match(src, /startsWith\('web_'\)\) return 45_000/);
  assert.match(src, /callTool\(name, request\.params\.arguments \?\? \{\}, toolTimeoutMs\(name\)\)/);
});

test("Claude path routes k-personal through toolBridge with a direct fallback switch", () => {
  const src = readFileSync(new URL("../sidecar/src/index.ts", import.meta.url), "utf8");
  const start = src.indexOf("async function handleViaClaudeCLI");
  const end = src.indexOf("async function handleViaCodexCLI");
  const claude = src.slice(start, end);
  assert.match(claude, /claudeBridge = turnToolBridge\(msg\)/);
  assert.match(claude, /KDA_CLAUDE_DIRECT_MCP !== "1"/);
  assert.ok((claude.match(/cleanupClaudeBridge\(\);/g) ?? []).length >= 2, "bridge dir cleaned on both exit paths");
});
