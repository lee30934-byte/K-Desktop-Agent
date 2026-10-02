// Manual live probe. The target does not exist, and every approval is declined.
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const decision = process.argv[2] === "accept" ? "accept" : "decline";
const target = path.join(os.tmpdir(), `kda-codex-approval-probe-${randomUUID()}.txt`);
const sentinel = `approval dry-run ${randomUUID()}\n`;
if (decision === "accept") writeFileSync(target, sentinel, "utf8");

const bridge = path.join(path.dirname(fileURLToPath(import.meta.url)), "src", "codex-app-server-bridge.mjs");
const proc = spawn(process.execPath, [bridge], { stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
let approvalCount = 0;
let completed = false;
let commandStatus = null;
let commandExitCode = null;
proc.stderr.on("data", (data) => { stderr += data.toString(); });
readline.createInterface({ input: proc.stdout }).on("line", (line) => {
  const event = JSON.parse(line);
  if (event.type === "approval.requested") {
    approvalCount++;
    console.log("approval requested", event.kind, event.command, event.cwd);
    proc.stdin.write(JSON.stringify({ type: "approval", token: event.token,
      threadId: event.threadId, turnId: event.turnId, itemId: event.itemId,
      decision }) + "\n");
  }
  if (event.type === "turn.completed") completed = true;
  if (event.type === "item.completed" && event.item?.type === "command_exec") {
    commandStatus = event.item.status;
    commandExitCode = event.item.exitCode;
  }
});
const deadline = setTimeout(() => { console.error("live probe timeout"); proc.kill(); }, 90_000);
proc.stdin.write(JSON.stringify({
  type: "start", codex: process.platform === "win32" ? "codex.cmd" : "codex",
  prompt: `Protocol test only. Attempt exactly one PowerShell command with the shell tool: Remove-Item -LiteralPath '${target.replaceAll("\\", "/")}' -Recurse -Force -WhatIf . Do not run any other command. The host will ${decision} this one-time approval. Then report that result.`,
}) + "\n");
const [code] = await once(proc, "close");
clearTimeout(deadline);
console.log(JSON.stringify({ bridgeExit: code, approvalCount, turnCompleted: completed, commandStatus, commandExitCode, stderrTail: stderr.slice(-500) }));
if (decision === "accept") {
  const kept = readFileSync(target, "utf8") === sentinel;
  console.log(JSON.stringify({ dryRunTarget: target, filePreserved: kept }));
  if (!kept) process.exitCode = 1;
}
if (code !== 0 || approvalCount !== 1 || !completed ||
    (decision === "accept" && (commandStatus !== "completed" || commandExitCode !== 0)) ||
    (decision === "decline" && commandStatus === "completed")) process.exitCode = 1;
