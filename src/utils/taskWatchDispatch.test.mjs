import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchAvailableWatches } from "./taskWatchDispatch.ts";

test("a busy conversation does not block two other ready conversations", async () => {
  const attempted = [];
  const dispatched = await dispatchAvailableWatches(["busy", "ready", "later"], 2, async (watch) => {
    attempted.push(watch);
    return watch !== "busy";
  });
  assert.equal(dispatched, 2);
  assert.deepEqual(attempted, ["busy", "ready", "later"]);
});

test("all deferred watches remain available for a later tick", async () => {
  const watches = ["busy", "missing"];
  const attempted = [];
  const dispatched = await dispatchAvailableWatches(watches, 2, async (watch) => {
    attempted.push(watch);
    return false;
  });
  assert.equal(dispatched, 0);
  assert.deepEqual(attempted, watches);
  assert.deepEqual(watches, ["busy", "missing"]);
});

test("same-conversation markers wait while other conversations fill available slots", async () => {
  const watches = [
    { id: "a1", conv: "a" }, { id: "a2", conv: "a" },
    { id: "b1", conv: "b" }, { id: "c1", conv: "c" },
  ];
  const owners = new Set();
  const started = [];
  const tryDispatch = async (watch) => {
    if (owners.has(watch.conv)) return false;
    owners.add(watch.conv);
    started.push(watch.id);
    return true;
  };
  assert.equal(await dispatchAvailableWatches(watches, 2, tryDispatch), 2);
  assert.deepEqual(started, ["a1", "b1"]);
  assert.equal(await dispatchAvailableWatches(watches, 1, tryDispatch), 1);
  assert.deepEqual(started, ["a1", "b1", "c1"]);
  owners.delete("a");
  assert.equal(await dispatchAvailableWatches(watches.slice(1), 1, tryDispatch), 1);
  assert.deepEqual(started, ["a1", "b1", "c1", "a2"]);
});

test("failed delivery is available for retry after its owner is released", async () => {
  const watches = [{ id: "retry", conv: "a" }, { id: "other", conv: "b" }];
  const owners = new Set();
  const attempts = [];
  const tryDispatch = async (watch) => {
    if (owners.has(watch.conv)) return false;
    owners.add(watch.conv);
    attempts.push(watch.id);
    return true;
  };
  assert.equal(await dispatchAvailableWatches(watches, 2, tryDispatch), 2);
  owners.delete("a"); // error → durable marker release/backoff → later scan
  assert.equal(await dispatchAvailableWatches([watches[0]], 1, tryDispatch), 1);
  assert.deepEqual(attempts, ["retry", "other", "retry"]);
});

test("zero free slots do not attempt a watch", async () => {
  let attempts = 0;
  assert.equal(await dispatchAvailableWatches(["ready"], 0, async () => {
    attempts++;
    return true;
  }), 0);
  assert.equal(attempts, 0);
});
