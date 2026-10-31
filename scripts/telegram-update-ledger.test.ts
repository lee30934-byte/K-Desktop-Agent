import { test } from "node:test";
import assert from "node:assert/strict";
import { processTelegramUpdate, TelegramUpdateLedger } from "../src/telegramUpdateLedger.ts";

const item = (updateId: number, state?: string) => ({ updateId, state, chatId: "chat", text: "read only", updatedAt: updateId });

test("new update is claimed once and completed replay is ignored", () => {
  const ledger = new TelegramUpdateLedger([]);
  assert.equal(ledger.claim(item(10)), "new");
  assert.equal(ledger.claim(item(10)), "inflight");
  ledger.complete(10, 20);
  assert.equal(ledger.claim(item(10)), "completed");
  assert.equal(ledger.uncertainCount, 0);
});

test("processing record restored after restart becomes uncertain, never redispatched", () => {
  const first = new TelegramUpdateLedger([]);
  assert.equal(first.claim(item(11)), "new");
  const restored = new TelegramUpdateLedger(first.toJSON());
  assert.equal(restored.claim(item(11)), "uncertain");
  assert.equal(restored.needsNotice(11), true);
  restored.markNoticeSent(11);
  assert.equal(restored.needsNotice(11), false);
  assert.equal(restored.claim(item(11)), "uncertain");
});

test("failed persistence can release an unstarted in-memory claim", () => {
  const ledger = new TelegramUpdateLedger([]);
  assert.equal(ledger.claim(item(12)), "new");
  ledger.cancelUnpersistedClaim(12);
  assert.equal(ledger.claim(item(12)), "new");
});

test("invalid rows are discarded and ledger remains bounded", () => {
  const ledger = new TelegramUpdateLedger([null, { updateId: "x" }, ...Array.from({ length: 300 }, (_, i) => ({ ...item(i), state: "completed" }))], 12);
  assert.equal(ledger.toJSON().length, 12);
  assert.equal(ledger.claim(item(299)), "completed");
});

test("durable processing claims before dispatch and ack follows completion", async () => {
  const ledger = new TelegramUpdateLedger([]);
  const order: string[] = [];
  const result = await processTelegramUpdate({
    ledger, updateId: 20, chatId: "chat", text: "safe", now: 30,
    persist: () => order.push(`persist:${ledger.toJSON()[0]?.state}`),
    dispatch: async () => { order.push("dispatch"); },
    notifyUncertain: async () => true,
    acknowledge: () => order.push("ack"),
  });
  assert.equal(result, "new");
  assert.deepEqual(order, ["persist:processing", "dispatch", "persist:completed", "ack"]);
});

test("dispatch failure is reported as uncertain and never falls back to another target", async () => {
  const ledger = new TelegramUpdateLedger([]);
  let dispatches = 0;
  let notices = 0;
  let acks = 0;
  const run = () => processTelegramUpdate({
    ledger, updateId: 21, chatId: "chat", text: "do not duplicate", now: 31,
    persist: () => {},
    dispatch: async () => { dispatches++; throw new Error("partial failure"); },
    notifyUncertain: async () => { notices++; return true; },
    acknowledge: () => { acks++; },
  });
  assert.equal(await run(), "uncertain");
  assert.equal(await run(), "uncertain");
  assert.equal(dispatches, 1);
  assert.equal(notices, 1);
  assert.equal(acks, 2);
});

test("persist failure before dispatch prevents execution and releases the claim", async () => {
  const ledger = new TelegramUpdateLedger([]);
  let dispatches = 0;
  await assert.rejects(processTelegramUpdate({
    ledger, updateId: 22, chatId: "chat", text: "safe", now: 32,
    persist: () => { throw new Error("storage full"); },
    dispatch: async () => { dispatches++; },
    notifyUncertain: async () => true,
    acknowledge: () => {},
  }));
  assert.equal(dispatches, 0);
  assert.equal(ledger.claim(item(22)), "new");
});

test("completion storage failure never acknowledges or dispatches the same update again", async () => {
  const ledger = new TelegramUpdateLedger([]);
  let durable: unknown, writes = 0, dispatches = 0, acks = 0;
  const run = () => processTelegramUpdate({ ledger, updateId: 30, chatId: "chat", text: "once", now: 40,
    persist: () => { if (++writes === 2) throw Error("quota"); durable = ledger.toJSON(); },
    dispatch: async () => { dispatches++; }, notifyUncertain: async () => true, acknowledge: () => { acks++; } });
  await assert.rejects(run(), /quota/);
  assert.equal(acks, 0);
  assert.equal(ledger.uncertainCount, 1);
  assert.equal(new TelegramUpdateLedger(durable).uncertainCount, 1);
  assert.equal(await run(), "uncertain");
  assert.equal(dispatches, 1);
  assert.equal(acks, 1);
});

test("uncertainty notification failure retries notice, never execution", async () => {
  const ledger = new TelegramUpdateLedger([{ ...item(40), state: "processing" }]);
  let sends = 0, acks = 0;
  const run = () => processTelegramUpdate({ ledger, updateId: 40, chatId: "chat", text: "once", now: 50,
    persist: () => {}, dispatch: async () => assert.fail("must not execute"),
    notifyUncertain: async () => ++sends > 1, acknowledge: () => { acks++; } });
  await assert.rejects(run(), /notice_failed/);
  assert.equal(acks, 0);
  assert.equal(await run(), "uncertain");
  assert.equal(acks, 1);
});

test("unresolved rows cannot be evicted to allow replay", () => {
  const ledger = new TelegramUpdateLedger([{ ...item(1), state: "processing" }, { ...item(2), state: "uncertain" }], 2);
  assert.equal(ledger.uncertainCount, 2);
  assert.throws(() => ledger.claim(item(3)), /full_unresolved/);
  assert.equal(ledger.claim(item(1)), "uncertain");
});

test("corrupt or inaccessible storage blocks dispatch and retains the original data", () => {
  for (const read of [() => "{bad", () => '{"bad":true}', () => { throw Error("denied"); }]) {
    const ledger = TelegramUpdateLedger.fromStorage(read);
    assert.equal(ledger.blocked, true);
    assert.throws(() => ledger.claim(item(50)), /unavailable/);
  }
  assert.equal(TelegramUpdateLedger.fromStorage(() => null).claim(item(50)), "new");
});

test("in-flight duplicates neither dispatch nor acknowledge the first request", async () => {
  const ledger = new TelegramUpdateLedger([]);
  ledger.claim(item(60));
  assert.equal(await processTelegramUpdate({ ledger, updateId: 60, chatId: "chat", text: "once", now: 61,
    persist: () => assert.fail(), dispatch: async () => assert.fail(),
    notifyUncertain: async () => assert.fail(), acknowledge: () => assert.fail() }), "inflight");
});
