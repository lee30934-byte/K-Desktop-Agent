import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConversationControl, buildSteeringMessage, type PendingSend } from "../src/conversationControl.ts";
import { TurnLifecycle } from "../sidecar/src/turnLifecycle.ts";
import { ExecutionLeases, workspaceLeaseKey } from "../sidecar/src/executionLeases.ts";
import { ConversationMessageWriter } from "../src/messagePersistence.ts";
import { observeProcessClose } from "../sidecar/src/processCompletion.ts";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

let passed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) { await fn(); passed++; console.log("PASS " + name); }
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const item = (conversationId: string, id: string, mode: "queue" | "steer" = "queue"): PendingSend => ({ id, conversationId, text: id, mode, queuedAt: 1 });

await test("대화 3개 동시 실행과 같은 대화 중복 차단", () => {
  const c = new ConversationControl();
  for (const id of ["a", "b", "c"]) assert.ok(c.claim(id, id + "1"));
  assert.equal(c.claim("a", "a2"), false);
  assert.deepEqual([...c.activeConversationIds()], ["a", "b", "c"]);
});
await test("창 전환과 무관한 정지 대상, 종료 확인 전 잠금 유지", () => {
  const c = new ConversationControl(); c.claim("a", "a1"); c.claim("b", "b1");
  assert.equal(c.stopping("a"), "a1"); assert.equal(c.owner("a"), "a1");
  assert.equal(c.claim("a", "a2"), false); assert.equal(c.owner("b"), "b1");
  c.finish("a", "a1", "stopped"); assert.ok(c.claim("a", "a2"));
});
await test("이전 작업의 지연 완료·오류가 새 실행을 해제하지 않음", () => {
  const c = new ConversationControl(); c.claim("a", "old"); c.finish("a", "old", "stopped"); c.claim("a", "new");
  assert.equal(c.finish("a", "old", "failed"), false);
  assert.equal(c.accepts("a", "old"), false); assert.equal(c.owner("a"), "new");
});
await test("여러 예약 보존, 중복 요청 멱등 처리, 대화 간 큐 격리", () => {
  const c = new ConversationControl(); c.enqueue(item("a", "a1")); c.enqueue(item("a", "a2")); c.enqueue(item("b", "b1")); c.enqueue(item("a", "a1"));
  assert.equal(c.queues.get("a")?.length, 2); assert.equal(c.peek("b")?.id, "b1");
  c.remove("a", "a1"); assert.equal(c.peek("a")?.id, "a2"); assert.equal(c.peek("b")?.id, "b1");
});
await test("정지 후 예약·자동 재개 보류, 다른 대화는 계속 진행", () => {
  const c = new ConversationControl(); c.pause("a"); c.enqueue(item("a", "q"));
  assert.equal(c.canAutoRun("a"), false); assert.equal(c.canAutoRun("b"), true);
  c.resume("a"); assert.equal(c.canAutoRun("a"), true);
  c.allPaused = true; assert.equal(c.canAutoRun("a"), false); assert.equal(c.canAutoRun("b"), false);
});
await test("실패 시 자동 예약 반복 실행 방지", () => {
  const c = new ConversationControl(); c.claim("a", "t"); c.enqueue(item("a", "q")); c.finish("a", "t", "failed");
  assert.equal(c.canAutoRun("a"), false); assert.equal(c.peek("a")?.id, "q");
});
await test("추가 지시는 원래 목표와 완료 결과를 보존하도록 전달", () => {
  const prompt = buildSteeringMessage("출력 형식을 CSV로 변경");
  assert.match(prompt, /기존|이전 목표/); assert.match(prompt, /중복 실행/); assert.ok(prompt.endsWith("출력 형식을 CSV로 변경"));
});
await test("모델 done 수신만으로 실행 소유권을 해제하지 않음", () => {
  const life = new TurnLifecycle(); assert.ok(life.claim("one", "a"));
  life.terminal("one", { type: "done", agentId: "session-a" });
  assert.equal(life.claim("two", "a"), false);
  assert.equal(life.finish("one")?.agentId, "session-a"); assert.ok(life.claim("two", "a"));
});
await test("출력 분석 중 먼저 도착한 프로세스 close 이벤트를 놓치지 않음", async () => {
  const process = new EventEmitter();
  const closed = observeProcessClose(process as ChildProcess);
  process.emit("close", 0);
  await Promise.resolve();
  assert.deepEqual(await closed, { code: 0, error: undefined });
});
await test("프로세스 시작 실패도 close 확인 후 보고", async () => {
  const process = new EventEmitter(); const closed = observeProcessClose(process as ChildProcess);
  const error = new Error("spawn failed"); process.emit("error", error); process.emit("close", -2);
  assert.equal((await closed).error, error);
});
await test("정지 접수 후 재시도·하위 실행 차단, 종료 뒤에만 ACK", () => {
  const life = new TurnLifecycle(); life.claim("t", "a"); life.stop("t");
  assert.throws(() => life.assertRunning("t")); assert.throws(() => life.assertRunning("t#codex"));
  assert.equal(life.claim("replacement", "a"), false);
  life.terminal("t", { type: "error", message: "process killed" });
  assert.equal(life.finish("t")?.type, "turn_stopped"); assert.ok(life.claim("replacement", "a"));
  assert.equal(life.claim("t", "another-chat"), false);
});
await test("에러 뒤 done 이벤트가 실패를 성공으로 덮지 않음", () => {
  const life = new TurnLifecycle(); life.claim("t", "a"); life.terminal("t", { type: "error", message: "failure" }); life.terminal("t", { type: "done" });
  const done = life.finish("t"); assert.equal(done?.type, "error"); assert.equal(done?.conversationId, "a");
});
await test("같은 폴더는 종료까지 대기, 다른 프로젝트는 동시 실행", async () => {
  const leases = new ExecutionLeases(); const shared = workspaceLeaseKey("C:\\Projects\\KDA\\");
  assert.equal(shared, workspaceLeaseKey("c:/projects/kda"));
  await leases.acquire("a", [shared]);
  let acquired = false; const pending = leases.acquire("b", [shared]).then(() => { acquired = true; });
  await leases.acquire("c", [workspaceLeaseKey("C:/Projects/Other")]);
  assert.equal(acquired, false); assert.ok(leases.isWaiting("b"));
  leases.release("a"); await pending; assert.equal(acquired, true);
});
await test("상위·하위 폴더 충돌과 문자열 접두사 오탐 방지", async () => {
  const leases = new ExecutionLeases(); await leases.acquire("a", [workspaceLeaseKey("C:/repo")]);
  const pending = leases.acquire("b", [workspaceLeaseKey("C:/repo/sub")]);
  assert.ok(leases.isWaiting("b")); await leases.acquire("c", [workspaceLeaseKey("C:/repo-other")]);
  leases.release("a"); await pending;
});
await test("공유 자원 대기 중 정지하면 자원 해제 뒤에도 시작하지 않음", async () => {
  const leases = new ExecutionLeases(); await leases.acquire("a", ["session:shared"]);
  const pending = leases.acquire("b", ["session:shared"]);
  const rejection = assert.rejects(pending, /정지/); leases.cancel("b"); await rejection;
  leases.release("a"); assert.equal(leases.isWaiting("b"), false);
});
await test("메시지 쓰기는 대화별 순서 보장, 다른 대화는 독립 저장", async () => {
  const latch = deferred(); const written: string[] = [];
  const writer = new ConversationMessageWriter<string>(async (id, text) => { if (text === "partial") await latch.promise; written.push(id + ":" + text); });
  const partial = writer.write("a", "partial"); const final = writer.write("a", "final");
  await writer.write("b", "independent"); assert.deepEqual(written, ["b:independent"]);
  latch.resolve(); await Promise.all([partial, final]); await writer.drain("a");
  assert.deepEqual(written, ["b:independent", "a:partial", "a:final"]);
});
await test("저장 실패는 재개 전에 감지되며 이후 쓰기 재시도 가능", async () => {
  let fail = true; const writer = new ConversationMessageWriter<string>(async () => { if (fail) throw Error("disk full"); });
  await assert.rejects(writer.write("a", "first")); await assert.rejects(writer.drain("a"));
  fail = false; await writer.write("a", "retry"); await writer.drain("a");
});
await test("실제 앱 배선: 현재 대화 폴백·타이머 정지·전역 안전 모드 제거", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const sidecar = readFileSync(new URL("../sidecar/src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(app, /turnToConvMap\.current\.get\(ev\.id\) \?\? activeConversationIdRef/);
  assert.doesNotMatch(app, /type QueuedSend|queuedSendRef|flushTimerRef|conversationTurnGateRef\.current\.clear\(\)/);
  assert.match(app, /sendOwnedMessage/); assert.match(app, /\(event\.conversation_id \?\? event\.conversationId\) !== eventConversationId/);
  assert.doesNotMatch(sidecar, /let _currentTurnSafeMode|releaseConversationTurnById/);
  assert.match(sidecar, /await Promise\.allSettled\(orchestrationExecutions/);
});
console.log("conversation-control: " + passed + "/" + passed + " PASS");
