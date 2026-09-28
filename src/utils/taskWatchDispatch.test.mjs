import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchFirstAvailableWatch } from "./taskWatchDispatch.ts";

test("a busy conversation does not block a later ready watch", async () => {
  const attempted = [];
  const dispatched = await dispatchFirstAvailableWatch(["busy", "ready", "later"], async (watch) => {
    attempted.push(watch);
    return watch === "ready";
  });
  assert.equal(dispatched, true);
  assert.deepEqual(attempted, ["busy", "ready"]);
});

test("all deferred watches remain available for a later tick", async () => {
  const watches = ["busy", "missing"];
  const attempted = [];
  const dispatched = await dispatchFirstAvailableWatch(watches, async (watch) => {
    attempted.push(watch);
    return false;
  });
  assert.equal(dispatched, false);
  assert.deepEqual(attempted, watches);
  assert.deepEqual(watches, ["busy", "missing"]);
});
