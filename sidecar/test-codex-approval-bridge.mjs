import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(here, "src", "codex-app-server-bridge.mjs");
const mock = path.join(here, "test-fixtures", "mock-app-server.cmd");

async function run(decision) {
  const proc = spawn(process.execPath, [bridge], { stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  let stderr = "";
  proc.stderr.on("data", (data) => { stderr += data.toString(); });
  const reader = readline.createInterface({ input: proc.stdout });
  reader.on("line", (line) => {
    const value = JSON.parse(line);
    events.push(value);
    if (value.type !== "approval.requested") return;
    // Wrong item id cannot reuse consent, even with a valid token.
    proc.stdin.write(JSON.stringify({ type: "approval", token: value.token,
      threadId: value.threadId, turnId: value.turnId, itemId: "other-item", decision: "accept" }) + "\n");
    setTimeout(() => proc.stdin.write(JSON.stringify({ type: "approval", token: value.token,
      threadId: value.threadId, turnId: value.turnId, itemId: value.itemId, decision }) + "\n"), 30);
  });
  proc.stdin.write(JSON.stringify({ type: "start", codex: mock, prompt: "test prompt" }) + "\n");
  const [code] = await once(proc, "close");
  assert.equal(code, 0, stderr);
  const approval = events.find((event) => event.type === "approval.requested");
  assert.ok(approval);
  assert.equal(approval.command, "Get-Item test-target");
  assert.equal(approval.cwd, "C:/test");
  const command = events.find((event) => event.type === "item.completed")?.item;
  assert.equal(command?.status, decision === "accept" ? "completed" : "declined");
  assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
}

await run("decline");
await run("accept");
console.log("Codex approval bridge: decline, exact-request accept, stale-item rejection passed");
