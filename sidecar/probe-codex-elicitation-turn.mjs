// Offline sidecar protocol probe. No GUI or model/API call. All user state is
// redirected to a fresh evidence directory; the installed app stays running.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import readline from "node:readline";
import treeKill from "tree-kill";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const entry = process.argv[2] ?? path.join(here, "dist", "index.js");
const baseline = process.argv.includes("--expect-old-failure");
const evidence = path.join(root, "evidence");
mkdirSync(evidence, { recursive: true });
const home = mkdtempSync(path.join(evidence, baseline ? "elicitation-installed-" : "elicitation-candidate-"));
mkdirSync(path.join(home, ".kda", "memory"), { recursive: true });
mkdirSync(path.join(home, "tmp"));
writeFileSync(path.join(home, ".kda", "sidecar-config.json"), JSON.stringify({ anthropicRatePollingEnabled: false, gitSync: { enabled: false }, gitSyncTeam: { enabled: false } }));
const preload = path.join(home, "preload.mjs");
writeFileSync(preload, `import os from 'node:os';\nimport {syncBuiltinESMExports} from 'node:module';\nos.homedir = () => ${JSON.stringify(home)};\nos.tmpdir = () => ${JSON.stringify(path.join(home, "tmp"))};\nsyncBuiltinESMExports();\n`);
const proc = spawn(process.execPath, ["--import", pathToFileURL(preload).href, entry], {
  cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, KDA_HEADLESS: "1", APPDATA: path.join(home, "appdata"),
    K_PERSONAL_MCP_PATH: path.join(home, "no-mcp"), KDA_MEMORY_DIR: path.join(home, ".kda", "memory"),
    CODEX_CLI: path.join(here, "test-fixtures", "mock-elicitation-server.cmd"), KDA_ELICITATION_ONLY: "1" },
});
const closed = once(proc, "close");
const events = [];
const turns = baseline ? ["elicitation-first"] : ["elicitation-first", "elicitation-next"];
const conversation = "elicitation-protocol-probe";
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; treeKill(proc.pid, "SIGKILL", () => {}); }, 35_000);
proc.stderr.resume();
function sendTurn(id) {
  proc.stdin.write(JSON.stringify({ type: "user_message", id, conversation_id: conversation,
    content: "offline elicitation test", provider: "codex", history: [] }) + "\n");
}
readline.createInterface({ input: proc.stdout }).on("line", line => {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (!turns.includes(event.id)) return;
  events.push(event);
  if (event.type === "done" || event.type === "error") {
    if (!baseline && event.id === turns[0] && event.type === "done") sendTurn(turns[1]);
    else proc.stdin.end();
  }
});
sendTurn(turns[0]);
const [exitCode] = await closed;
clearTimeout(timeout);
const result = { baseline, entry, exitCode, timedOut,
  notices: events.filter(e => e.type === "provider_notice").length,
  approvals: events.filter(e => e.type === "codex_approval_request").length,
  terminals: events.filter(e => e.type === "done" || e.type === "error"),
  correctlyRouted: events.length > 0 && events.every(e => e.conversation_id === conversation) };
writeFileSync(path.join(home, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, evidence: path.join(home, "result.json") }));
assert.equal(timedOut, false);
assert.equal(exitCode, 0);
assert.equal(result.correctlyRouted, true);
assert.equal(result.approvals, 0);
if (baseline) {
  assert.equal(result.terminals.length, 1);
  assert.equal(result.terminals[0].type, "error");
  assert.match(result.terminals[0].message, /Unsupported Codex approval request: mcpServer\/elicitation\/request/);
} else {
  assert.equal(result.notices, 24);
  assert.deepEqual(result.terminals.map(e => [e.id, e.type]), turns.map(id => [id, "done"]));
  for (const id of turns) {
    const lastAnswer = events.filter(e => e.id === id && e.type === "assistant_delta").at(-1);
    assert.equal(JSON.parse(lastAnswer.text).continued, true);
  }
}
