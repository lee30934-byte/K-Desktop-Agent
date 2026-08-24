import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const sidecarDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(sidecarDir);
const runner = path.join(sidecarDir, "node_modules", "tsx", "dist", "cli.mjs");
const testFile = path.join(rootDir, "scripts", "conversation-turn-gate.test.ts");
const result = spawnSync(process.execPath, [runner, testFile], {
  cwd: rootDir,
  encoding: "utf8",
  windowsHide: true,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
assert.equal(result.status, 0, "single-flight behavior and wiring checks must pass");
console.log("single-flight release gate: 1/1");
