const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/browser_host_adapter.js'), 'utf8');

function harness() {
  let now = 100000, stopVisible = false, sends = 0;
  const nodes = [], intervals = new Set();
  class Textarea {
    constructor() { this.tagName = 'TEXTAREA'; this.isConnected = true; this.innerText = ''; }
    get value() { return this._value || ''; }
    set value(v) { this._value = v; }
    getBoundingClientRect() { return { width: 100, height: 20 }; }
    focus() {} dispatchEvent() {}
  }
  const box = new Textarea();
  const button = { isConnected: true, disabled: false, getBoundingClientRect: () => ({width: 20, height: 20}), click: () => { sends++; stopVisible = true; } };
  const stop = { ...button, click: () => { stopVisible = false; } };
  const ctx = { window: {}, location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/?temporary-chat=true' },
    URL, AbortController, Event, TextEncoder, HTMLTextAreaElement: Textarea,
    Date: class extends Date { static now() { return now; } },
    getComputedStyle: () => ({ visibility: 'visible' }),
    setTimeout: () => 0, clearTimeout() {}, setInterval: fn => { intervals.add(fn); return fn; }, clearInterval: fn => intervals.delete(fn),
    fetch: async () => ({ ok: true, url: 'https://chatgpt.com/api/auth/session', headers: { get: () => 'application/json' }, json: async () => ({ user: { id: 'test' } }) }),
    document: { querySelectorAll(selector) {
      if (selector === '[data-turn-id]') return nodes;
      if (selector.includes('prompt-textarea')) return [box];
      if (selector.includes('stop-button')) return stopVisible ? [stop] : [];
      if (selector.includes('send-button')) return [button];
      return [];
    } }
  };
  vm.runInNewContext(source, ctx);
  function assistant(id, text, final = false) {
    return { getAttribute: () => id, querySelector: sel => sel.includes('author-role') ? { innerText: text } : final ? {} : null };
  }
  return { api: ctx.window.__kdaPort, box, nodes, assistant, intervals,
    tick: ms => { now += ms; for (const fn of [...intervals]) fn(); },
    endStream: () => { stopVisible = false; }, sends: () => sends,
    ready: async () => { ctx.window.__kdaPort.snapshot(); await new Promise(resolve => setImmediate(resolve)); assert.equal(ctx.window.__kdaPort.snapshot().phase, 'ready'); }
  };
}

test('login probe never exports session data', async () => {
  const h = harness(); await h.ready();
  assert.equal(h.api.snapshot().authenticated, true);
  assert.equal(JSON.stringify(h.api.snapshot()).includes('"user"'), false);
});
test('a draft is preserved and never sent', async () => {
  const h = harness(); await h.ready(); h.box.value = 'existing draft';
  assert.throws(() => h.api.send('KDA_WEBVIEW2_OK'), /draft/);
  assert.equal(h.box.value, 'existing draft'); assert.equal(h.sends(), 0);
});
test('resubmission is rejected after an ambiguous result', async () => {
  const h = harness(); await h.ready(); h.api.send('KDA_WEBVIEW2_OK'); h.tick(100);
  assert.equal(h.sends(), 1); assert.throws(() => h.api.send('KDA_WEBVIEW2_OK'), /one-submit/);
  h.tick(180001); assert.equal(h.api.snapshot().phase, 'failed');
  assert.equal(h.sends(), 1);
});
test('old virtualized history cannot count as the new response', async () => {
  const h = harness(); await h.ready(); h.nodes.push(h.assistant('old', 'old final', true));
  h.api.send('KDA_WEBVIEW2_OK'); h.tick(100); h.endStream(); h.tick(3000);
  const s = h.api.snapshot(); assert.equal(s.text, ''); assert.notEqual(s.phase, 'completed');
});
test('a silent partial response does not count as completion', async () => {
  const h = harness(); await h.ready(); h.api.send('KDA_WEBVIEW2_OK'); h.tick(100);
  h.nodes.push(h.assistant('new', 'partial')); h.api.snapshot(); h.endStream(); h.tick(10000);
  assert.equal(h.api.snapshot().phase, 'streaming');
});
test('completion requires the bound final response and no stop control', async () => {
  const h = harness(); await h.ready(); h.api.send('KDA_WEBVIEW2_OK'); h.tick(100);
  h.nodes.push(h.assistant('new', 'KDA_WEBVIEW2_OK', true)); h.api.snapshot(); h.tick(2000);
  assert.equal(h.api.snapshot().phase, 'streaming'); h.endStream();
  assert.equal(h.api.snapshot().phase, 'completed');
});
test('duplicate identities fail without choosing an arbitrary response', async () => {
  const h = harness(); await h.ready(); h.api.send('KDA_WEBVIEW2_OK'); h.tick(100);
  h.nodes.push(h.assistant('new', 'a'), h.assistant('new', 'b'));
  assert.equal(h.api.snapshot().error, 'duplicate-turn-identity');
});
test('cancellation observes stop disappearing and does not resend', async () => {
  const h = harness(); await h.ready(); h.api.send('KDA_WEBVIEW2_OK'); h.tick(100); h.api.snapshot();
  assert.equal(h.api.stop().phase, 'cancelled'); assert.equal(h.sends(), 1);
});
test('stop before send cancels the pending click and times out explicitly', async () => {
  const h = harness(); await h.ready(); h.api.send('KDA_WEBVIEW2_OK'); h.api.stop(); h.tick(16000);
  assert.equal(h.sends(), 0); assert.equal(h.api.snapshot().error, 'stop-unconfirmed-close-browser');
});
