import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserHostClient } from "../sidecar/src/browserHost.js";

test("out-of-order replies remain bound to exact request and owner", async () => {
  const messages: Record<string, unknown>[] = [];
  const client = new BrowserHostClient(m => messages.push(m));
  const a = client.request("owner-a", "status");
  const b = client.request("owner-b", "status");
  const ar = messages[0].request as Record<string, unknown>;
  const br = messages[1].request as Record<string, unknown>;
  client.receive({ type: "browser_host_reply", requestId: ar.requestId, owner: "owner-b", status: { text: "wrong" } });
  client.receive({ type: "browser_host_reply", ...br, status: { phase: "ready", text: "B" } });
  client.receive({ type: "browser_host_reply", ...ar, status: { phase: "ready", text: "A" } });
  assert.equal((await a).text, "A"); assert.equal((await b).text, "B");
});
test("timeout never resubmits a send", async () => {
  let sends = 0;
  const client = new BrowserHostClient(() => { sends++; }, 10);
  await assert.rejects(client.request("owner", "send", "hello"), /timeout-no-retry/);
  assert.equal(sends, 1);
});
test("disconnect rejects in-flight work and consumes late replies", async () => {
  let request: Record<string, unknown> = {};
  const client = new BrowserHostClient(m => { request = m.request as Record<string, unknown>; });
  const promise = client.request("owner", "send", "hello");
  client.dispose();
  await assert.rejects(promise, /disconnected/);
  await assert.rejects(client.request("owner", "open"), /disconnected/);
  assert.equal(client.receive({ type: "browser_host_reply", ...request, status: { phase: "completed" } }), true);
  assert.equal(client.receive({ type: "user_message" }), false);
});

test("unverified authentication stays null and diagnostic replies are action-bound", async () => {
  let request: Record<string, unknown> = {};
  const client = new BrowserHostClient(m => { request = m.request as Record<string, unknown>; });
  const pending = client.request("owner", "status");
  client.receive({type:"browser_host_reply", ...request, status:{phase:"login-required", authenticated:null, authState:"unverified"}});
  assert.equal((await pending).authenticated, null);
  const diagnostic = client.request("owner", "diagnostics");
  client.receive({type:"browser_host_reply", ...request, status:{events:[],windows:[]}});
  assert.deepEqual(await diagnostic, {events:[],windows:[]});
  for (const status of [{}, {phase:"ready",authenticated:"false"}, {phase:"unknown"}, {events:[],windows:[]}]) {
    const bad = client.request("owner", "status");
    client.receive({type:"browser_host_reply", ...request, status});
    await assert.rejects(bad, /invalid-browser-reply/);
  }
  const badDiagnostic = client.request("owner", "diagnostics");
  client.receive({type:"browser_host_reply", ...request, status:{events:[{event:"destroyed"}],windows:[]}});
  await assert.rejects(badDiagnostic, /invalid-browser-reply/);
  client.dispose();
});
test("write failure and malformed replies fail explicitly", async () => {
  const broken = new BrowserHostClient(() => { throw new Error("pipe"); });
  await assert.rejects(broken.request("owner", "send", "hello"), /write-failed/);
  await assert.rejects(broken.request("../owner", "open"), /invalid-browser-owner/);
  let request: Record<string, unknown> = {};
  const client = new BrowserHostClient(m => { request = m.request as Record<string, unknown>; });
  const p = client.request("owner", "status");
  client.receive({ type: "browser_host_reply", ...request, status: [] });
  await assert.rejects(p, /invalid-browser-reply/);
});
