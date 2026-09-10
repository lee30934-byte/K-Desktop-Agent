/** Isolated, credential-free smoke against the built sidecar and real Windows child processes. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import treeKill from "../sidecar/node_modules/tree-kill/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = fs.mkdtempSync(path.join(root, "evidence", "conversation-smoke-"));
const home = path.join(run, "home");
for (const dir of [home, path.join(home, ".kda", "memory"), path.join(run, "tmp")]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(home, ".kda", "sidecar-config.json"), JSON.stringify({ anthropicRatePollingEnabled: false, gitSync: { enabled: false }, gitSyncTeam: { enabled: false } }));
fs.writeFileSync(path.join(home, ".kda", "memory", "fixture.md"), "Isolated test fixture.");
fs.cpSync(path.join(root, "sidecar", "dist"), path.join(run, "dist"), { recursive: true, errorOnExist: true, force: false });
fs.symlinkSync(path.join(root, "sidecar", "node_modules"), path.join(run, "node_modules"), "junction");
const preload = path.join(run, "preload.mjs");
fs.writeFileSync(preload, `import os from 'node:os';\nimport {syncBuiltinESMExports} from 'node:module';\nos.homedir = () => ${JSON.stringify(home)};\nos.tmpdir = () => ${JSON.stringify(path.join(run, "tmp"))};\nsyncBuiltinESMExports();\n`);
const fixture = path.join(run, "fake-cli.cjs");
fs.writeFileSync(fixture, `
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex fixture 1.0'); process.exit(0); }
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  const emit = e => console.log(JSON.stringify(e));
  const claude = process.argv.includes('--output-format');
  const gemini = process.argv.includes('--skip-trust');
  const done = () => emit(claude ? {type:'result',subtype:'success',result:'fixture-pid='+process.pid,session_id:'fixture-session-'+process.pid,usage:{input_tokens:1,output_tokens:1}} : gemini ? {type:'result',status:'success',stats:{input_tokens:1,output_tokens:1}} : {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
  if (claude) { emit({type:'system',subtype:'init',session_id:'fixture-session-'+process.pid}); emit({type:'assistant',message:{content:[{type:'text',text:'fixture-pid='+process.pid}]}}); }
  else if (gemini) { emit({type:'init',session_id:'fixture-session-'+process.pid}); emit({type:'message',role:'assistant',content:'fixture-pid='+process.pid}); }
  else { emit({type:'thread.started',thread_id:'fixture-session-'+process.pid}); emit({type:'item.completed',item:{type:'agent_message',text:'fixture-pid='+process.pid}}); }
  if (input.includes('KDA_TEST_EARLY_DONE')) done();
  if (input.includes('KDA_TEST_HOLD') || input.includes('KDA_TEST_EARLY_DONE')) {
    const timer=setInterval(() => {
      if(fs.existsSync(${JSON.stringify(path.join(run, "release"))})) { clearInterval(timer); if (!input.includes('KDA_TEST_EARLY_DONE')) done(); }
    },25);
  } else done();
});
`);
const cli = path.join(run, "fake-cli.cmd");
fs.writeFileSync(cli, '@echo off\r\n"' + process.execPath + '" "' + fixture + '" %*\r\n');
const proc = spawn(process.execPath, ["--import", pathToFileURL(preload).href, path.join(run, "dist", "index.js")], {
  cwd: run, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, APPDATA: path.join(run, "appdata"), CLAUDE_CLI: cli, CODEX_CLI: cli, GEMINI_CLI: cli, K_PERSONAL_MCP_PATH: path.join(run, "no-mcp"), KDA_MEMORY_DIR: path.join(home, ".kda", "memory") },
});
const events = []; const waiting = new Set(); let buffer = "";
proc.stdout.on("data", chunk => {
  buffer += chunk.toString(); let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    try { const event = JSON.parse(line); events.push(event); for (const check of [...waiting]) check(); } catch {}
  }
});
let stderr = ""; proc.stderr.on("data", chunk => { stderr += chunk; });
function waitFor(predicate, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(check); reject(Error("timeout: " + label)); }, 20_000);
    const check = () => { const found = events.find(predicate); if (found) { clearTimeout(timer); waiting.delete(check); resolve(found); } };
    waiting.add(check); check();
  });
}
const send = msg => proc.stdin.write(JSON.stringify(msg) + "\n");
const start = (id, conversation_id, content, defaultPath, provider = "codex") => send({ type: "user_message", id, conversation_id, content, provider, ...(provider === "gemini-cli" ? { api_key: "isolated-fixture-not-a-real-key" } : {}), ...(defaultPath ? { projectProfile: { defaultPath } } : {}) });
const event = (type, id) => waitFor(e => e.type === type && e.id === id, type + ":" + id);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const checks = [];
try {
  await waitFor(e => e.type === "ready", "ready");
  assert.ok(events.some(e => e.type === "log" && e.message?.includes("anthropicRatePollingEnabled=false")), "isolated fixture settings must be loaded");
  start("a1", "a", "KDA_TEST_HOLD"); const a = await event("assistant_delta", "a1");
  start("b1", "b", "KDA_TEST_HOLD"); const b = await event("assistant_delta", "b1");
  assert.equal(a.conversationId, "a"); assert.equal(b.conversationId, "b"); checks.push("two conversations run independently");
  start("a-duplicate", "a", "KDA_TEST_HOLD"); await event("error", "a-duplicate"); checks.push("same conversation duplicate rejected");
  send({ type: "interrupt", id: "a1" }); await event("turn_stopped", "a1");
  assert.equal(alive(Number(a.text.match(/fixture-pid=(\d+)/)[1])), false);
  assert.equal(alive(Number(b.text.match(/fixture-pid=(\d+)/)[1])), true); checks.push("stop acknowledgement follows actual process exit and leaves other chat alive");
  send({ type: "interrupt", id: "b1" }); await event("turn_stopped", "b1");
  start("early", "c", "KDA_TEST_EARLY_DONE"); await event("assistant_delta", "early");
  start("early-duplicate", "c", "normal"); await event("error", "early-duplicate");
  assert.equal(events.some(e => e.id === "early" && e.type === "done"), false); checks.push("provider completion does not release a still-running process");
  send({ type: "interrupt", id: "early" }); await event("turn_stopped", "early");
  const workspace = path.join(run, "shared");
  start("lease-a", "d", "KDA_TEST_HOLD", workspace); await event("assistant_delta", "lease-a");
  start("lease-b", "e", "KDA_TEST_HOLD", workspace); await event("turn_waiting", "lease-b");
  send({ type: "interrupt", id: "lease-b" }); await event("turn_stopped", "lease-b");
  assert.equal(events.some(e => e.id === "lease-b" && e.type === "assistant_delta"), false); checks.push("cancel while waiting does not spawn a process");
  send({ type: "interrupt", id: "lease-a" }); await event("turn_stopped", "lease-a");
  start("replacement", "a", "normal"); await event("done", "replacement"); checks.push("new turn can start after confirmed stop");
  for (const provider of ["claude", "gemini-cli"]) {
    const id = provider + "-stop";
    start(id, id, "KDA_TEST_HOLD", undefined, provider);
    const response = await event("assistant_delta", id);
    send({ type: "interrupt", id }); await event("turn_stopped", id);
    assert.equal(alive(Number(response.text.match(/fixture-pid=(\d+)/)[1])), false);
    start(provider + "-done", id, "normal", undefined, provider);
    await event("done", provider + "-done");
    checks.push(provider + " process stop and replacement verified");
  }
  fs.writeFileSync(path.join(run, "result.json"), JSON.stringify({ ok: true, checks, events: events.filter(e => e.id).map(({ type, id, conversationId }) => ({ type, id, conversationId })) }, null, 2));
  console.log("sidecar process smoke: " + checks.length + "/" + checks.length + " PASS\n" + run);
} catch (err) {
  fs.writeFileSync(path.join(run, "failure.json"), JSON.stringify({ error: String(err), events, stderr }, null, 2));
  console.error(String(err) + "\n" + run); process.exitCode = 1;
} finally {
  await new Promise(resolve => treeKill(proc.pid, "SIGKILL", () => resolve()));
}
