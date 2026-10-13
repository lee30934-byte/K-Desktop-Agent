import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ConversationControl } from "../src/conversationControl";
import { settleWatchFailure, watchBlockReason, persistWatchResult, watchRecoveryPrompt, visibleWaitingWatches, waitingWatchKey, type ReadyWatch, type WatchDelivery } from "../src/utils/taskWatchRecovery";
import { dispatchAvailableWatches } from "../src/utils/taskWatchDispatch";
const dir = mkdtempSync(path.join(tmpdir(), "kda-watch-recovery-"));
const capacity = "Codex CLI exited with code 1\nstderr (tail):\nSelected model is at capacity. Please try a different model.";
let passed = 0;
function raw(op: string, file: string, args: Record<string, unknown> = {}) {
  const r = spawnSync(process.env.KDA_TEST_WATCH_DRIVER!, [], { input: JSON.stringify({ op, path: path.join(dir, file + ".json"), ...args }), encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
}
function rust(op: string, file: string, args: Record<string, unknown> = {}) { const r = raw(op, file, args); assert.equal(r.ok, true, r.error); return r.value; }
function setup(file: string) { rust("write", file, { marker: { id: file, conversationId: "chat", watch: { type: "file", path: "already-completed.done" }, run: { startedAt: "past", pid: 0 } } }); }
function scanned(file: string, now = 1_000_000, session = "app-one"): ReadyWatch { return { id: file, file, title: file, conversationId: "chat", prompt: "process result", note: "completion file rechecked", status: "fired", delivery: rust("view", file, { now, session }) }; }
async function test(name: string, fn: () => unknown | Promise<unknown>) { await fn(); console.log("PASS " + name); passed++; }

await test("waiting banner shows only the open conversation and stays dismissed until reason changes", () => {
  const watches = [
    { id: "same", title: "current", reason: "user-paused", conversationId: "chat" },
    { id: "other", title: "another project", reason: "conversation-running", conversationId: "elsewhere" },
    { id: "unbound", title: "unbound", reason: "requires-user" },
  ];
  assert.deepEqual(visibleWaitingWatches(watches, "chat", new Set()).map(w => w.id), ["same"]);
  assert.deepEqual(visibleWaitingWatches(watches, null, new Set()), []);
  const dismissed = new Set([waitingWatchKey(watches[0])]);
  assert.deepEqual(visibleWaitingWatches(watches, "chat", dismissed), []);
  assert.deepEqual(visibleWaitingWatches([{ ...watches[0], reason: "retry-exhausted" }], "chat", dismissed).map(w => w.id), ["same"]);
});

await test("reproduce v0.7.44 failed-turn pause deadlock", () => {
  const c = new ConversationControl(); c.claim("chat", "old"); c.finish("chat", "old", "failed");
  assert.equal(c.canAutoRun("chat"), false); assert.equal(c.paused.has("chat"), true);
});
await test("real Rust capacity release -> backoff -> frontend retry -> durable result -> ACK", async () => {
  setup("capacity"); const c = new ConversationControl(); c.claim("chat", "one"); rust("claim", "capacity", { turn: "one", now: 100 });
  const d = await settleWatchFailure(c, "chat", "one", async () => rust("release", "capacity", { turn: "one", error: capacity, now: 200 }));
  assert.equal(d.state, "retry_wait"); assert.equal(d.nextAttemptAt, 30200); assert.equal(c.canAutoRun("chat"), true);
  assert.equal(raw("claim", "capacity", { turn: "early", now: 30199 }).ok, false);
  const w = scanned("capacity", 30200); assert.equal(watchBlockReason(w, c, "chat"), undefined);
  let calls = 0; const dispatch = async () => { if (!c.canAutoRun("chat") || !c.claim("chat", "two")) return false; rust("claim", "capacity", { turn: "two", now: 30200 }); calls++; return true; };
  await dispatchAvailableWatches([w, w], 3, dispatch); assert.equal(calls, 1);
  rust("result", "capacity", { turn: "two", text: "processed existing output", now: 30400 });
  const writes = new Map(); let acks = 0;
  assert.equal(await persistWatchResult(scanned("capacity"), async (conv, id, text) => { writes.set(conv + id, text); }, async (file, turn) => { rust("ack", file, { turn }); acks++; }), true);
  c.finish("chat", "two", "completed"); assert.equal(writes.size, 1); assert.equal(acks, 1); assert.equal(existsSync(path.join(dir, "capacity.json")), false);
  assert.equal(raw("claim", "capacity", { turn: "duplicate", now: 100000 }).ok, false);
  rust("ack", "capacity", { turn: "two" });
});
await test("user stop during asynchronous retry decision is preserved and survives restart", async () => {
  setup("stop"); const c = new ConversationControl(); c.claim("chat", "one"); rust("claim", "stop", { turn: "one", now: 100 });
  let resolve!: (v: WatchDelivery) => void;
  const settling = settleWatchFailure(c, "chat", "one", () => new Promise((r) => { resolve = r; }));
  c.pause("chat"); c.allPaused = true;
  resolve(rust("release", "stop", { turn: "one", error: capacity, now: 200 })); await settling;
  assert.equal(c.canAutoRun("chat"), false); assert.equal(c.autoRunBlockReason("chat"), "all-paused");
  const restored = new ConversationControl(); restored.restorePauses(JSON.parse(JSON.stringify(c.pauseSnapshot())), [...c.paused]);
  assert.equal(watchBlockReason(scanned("stop"), restored, "chat"), "user-paused");
});
await test("stopped/approval/auth errors cannot become transport retries", async () => {
  for (const error of ["사용자가 정지함 — 대화 자동 실행 보류", "approval denied after connection reset", "user rejected MCP tool call", "authentication failed", "unknown tool failure", "quota exceeded"]) {
    assert.equal(rust("classify", "unused", { error }), "requires-user");
  }
  setup("approval"); const c = new ConversationControl(); c.claim("chat", "t"); rust("claim", "approval", { turn: "t" });
  const d = await settleWatchFailure(c, "chat", "t", async () => rust("release", "approval", { turn: "t", error: "user rejected approval", now: 200 }));
  assert.equal(d.state, "blocked"); assert.equal(c.canAutoRun("chat"), false);
});
await test("transport retries are bounded across process restarts and repeated terminal events", async () => {
  setup("bounded"); let now = 1;
  for (let i = 1; i <= 5; i++) {
    const c = new ConversationControl(); const turn = `t${i}`; c.claim("chat", turn);
    rust("claim", "bounded", { turn, now, session: `restart-${i}` });
    const d = await settleWatchFailure(c, "chat", turn, async () => rust("release", "bounded", { turn, error: "ECONNRESET", now: now + 1 }));
    assert.equal(d.attempts, i); assert.equal(d.state, i < 5 ? "retry_wait" : "exhausted");
    assert.deepEqual(rust("release", "bounded", { turn, error: "ECONNRESET", now: now + 99999 }), d);
    assert.equal(c.canAutoRun("chat"), i < 5); now = (d.nextAttemptAt ?? now) + 1;
  }
  assert.equal(raw("claim", "bounded", { turn: "sixth", now: 1e9 }).ok, false);
});
await test("restart after final response but before DB/ACK never calls model again", async () => {
  setup("result"); rust("claim", "result", { turn: "final" }); rust("result", "result", { turn: "final", text: "final response", now: 700 });
  const w = scanned("result", 1000, "new-app"); assert.equal(w.delivery?.state, "result_ready");
  await assert.rejects(persistWatchResult(w, async () => { throw Error("DB temporarily unavailable"); }, async () => { assert.fail("must not ack failed save"); }));
  const d = rust("release", "result", { turn: "final", error: "DB failed", now: 1001 }); assert.equal(d.state, "result_ready");
  const saved = new Map();
  const save = async (conv: string, id: string, text: string) => { saved.set(conv + id, text); };
  await assert.rejects(persistWatchResult(w, save, async () => { throw Error("ACK unavailable"); }));
  await persistWatchResult(scanned("result", 2000, "third-app"), save, async (file, turn) => { rust("ack", file, { turn }); });
  assert.equal(saved.size, 1);
});
await test("ambiguous interrupted claim and legacy pause require review", () => {
  setup("interrupted"); rust("claim", "interrupted", { turn: "old", now: 1 });
  assert.equal(scanned("interrupted", 1e9, "restarted").delivery?.reason, "interrupted-delivery-review");
  assert.equal(raw("claim", "interrupted", { turn: "new", now: 1e9, session: "restarted" }).ok, false);
  const c = new ConversationControl(); c.restorePauses(null, ["chat"]); assert.equal(c.autoRunBlockReason("chat"), "legacy-paused");
});
await test("late events and claim stealing cannot unlock or complete another owner", () => {
  setup("owner"); rust("claim", "owner", { turn: "owner", now: 1 });
  assert.equal(raw("claim", "owner", { turn: "steal", now: 1e9 }).ok, false);
  assert.equal(raw("release", "owner", { turn: "stranger", error: capacity }).ok, false);
  assert.equal(raw("result", "owner", { turn: "stranger", text: "wrong" }).ok, false);
  assert.equal(raw("ack", "owner", { turn: "stranger" }).ok, false);
  assert.equal(raw("ack", "owner", { turn: "owner" }).ok, false);
});
await test("IPC release failure holds safely; another conversation still progresses", async () => {
  const c = new ConversationControl(); c.claim("chat", "one");
  await assert.rejects(settleWatchFailure(c, "chat", "one", async () => { throw Error("disk failure"); }));
  assert.equal(c.autoRunBlockReason("chat"), "failure-paused"); assert.equal(c.canAutoRun("other"), true);
});
await test("recheck real completion file and producer before retry; timeout is not completion", () => {
  const done = path.join(dir, "producer.done"); writeFileSync(done, "complete");
  rust("write", "observed", { marker: { id: "observed", conversationId: "chat", watch: { type: "file", path: done }, run: { startedAt: "past", pid: 123 } } });
  assert.equal(rust("observation", "observed", { alive: true }), "producer-still-running");
  assert.equal(rust("observation", "observed", { alive: false }), null);
  rust("claim", "observed", { turn: "first", now: 1 });
  rust("release", "observed", { turn: "first", error: capacity, now: 2 });
  unlinkSync(done); // only this test's temporary completion fixture
  assert.equal(rust("observation", "observed", { alive: false, timeout: true }), "watch-condition-missing");
  const marker = rust("read", "observed"); assert.equal(marker.run.startedAt, "past"); assert.equal(marker.run.pid, 123);
});
await test("production wiring stages result, rechecks completion/processes, and displays deferred reasons", () => {
  const app = readFileSync("src/App.tsx", "utf8"); const rs = readFileSync("src-tauri/src/lib.rs", "utf8");
  assert.match(app, /settleWatchFailure\(conversationTurnGateRef.current/);
  assert.match(app, /ev.id && !failedWatch/); assert.match(app, /watchBlockReason\(w,/);
  assert.match(app, /task-watch-waiting/); assert.match(app, /watchBlockLabel\(w.reason\)/);
  assert.match(app, /task_watch_record_result[\s\S]*?saveMessage\(convForTurn[\s\S]*?task_watch_ack/);
  assert.match(rs, /fn task_watch_claim_marker[\s\S]*?eval_watch[\s\S]*?task_watch_recovery::observation_block[\s\S]*?task_watch_recovery::claim/);
  assert.match(rs, /marker.get\("_delivery"\).is_some\(\) \{ RunGate::NotApplicable/);
  assert.match(watchRecoveryPrompt(scanned("owner")), /프로세스.*현재 상태|프로세스의 현재 상태/);
  assert.match(watchRecoveryPrompt(scanned("owner")), /재실행 승인이 아닙니다/);
});
console.log(`${passed} integration scenarios PASS; real Rust ledger and frontend control; evidence ${dir}`);
