import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import treeKill from "tree-kill";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = process.env.KDA_TEST_BRIDGE ?? path.join(here, "src", "codex-app-server-bridge.mjs");
const mock = path.join(here, "test-fixtures", "mock-elicitation-server.cmd");

async function run(decision) {
  const proc = spawn(process.execPath, [bridge], { stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  let stderr = "";
  let timedOut = false;
  proc.stderr.on("data", (data) => { stderr += data.toString(); });
  const timer = setTimeout(() => { timedOut = true; treeKill(proc.pid, "SIGKILL", () => {}); }, 10_000);
  const reader = readline.createInterface({ input: proc.stdout });
  reader.on("line", (line) => {
    const value = JSON.parse(line);
    events.push(value);
    if (value.type === "elicitation.requested") {
      proc.stdin.write(JSON.stringify({ type: "elicitation", token: value.token, threadId: value.threadId,
        turnId: value.turnId, action: "decline", content: null }) + "\n");
    }
    if (value.type !== "approval.requested") return;
    // An existing command token and a forged elicitation approval must never
    // authorize the form, nor consume the legitimate command/file consent.
    proc.stdin.write(JSON.stringify({ type: "approval", token: value.token,
      threadId: value.threadId, turnId: value.turnId, itemId: "elicit-1", decision: "accept" }) + "\n");
    proc.stdin.write(JSON.stringify({ type: "approval", token: value.token,
      threadId: value.threadId, turnId: value.turnId, itemId: value.itemId, decision }) + "\n");
  });
  proc.stdin.write(JSON.stringify({ type: "start", codex: mock, prompt: "offline protocol test" }) + "\n");
  const [code] = await once(proc, "close");
  clearTimeout(timer);
  assert.equal(timedOut, false, "bridge hung after elicitation");
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  assert.deepEqual(events.filter(e => e.type === "approval.requested").map(e => e.kind), ["command", "file"]);
  const notices = events.filter(e => e.type === "provider.notice");
  assert.equal(notices.length, 6);
  assert.equal(events.filter(e => e.type === "elicitation.requested").length, 6);
  assert.ok(notices.every(e => e.code === "mcp_elicitation_declined"));
  assert.ok(!JSON.stringify(events).includes("PRIVATE_URL_SENTINEL"), "unsupported authentication URL leaked");
  const answer = events.find(e => e.type === "item.completed" && e.item?.type === "agent_message");
  const audit = JSON.parse(answer.item.text);
  assert.equal(audit.continued, true);
  assert.equal(audit.received.length, 14);
  for (const request of audit.received) {
    assert.deepEqual(request.result, request.id === "command-request" || request.id === "file-request"
      ? { decision } : { action: "decline", content: null });
  }
  assert.equal(events.filter(e => e.type === "turn.completed").length, 1);
}

await run("decline");
await run("accept");
console.log("Codex elicitation: 12 request variants x 2 approval decisions PASS; command/file consent preserved; turn completed");
