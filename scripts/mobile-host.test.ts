import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MobileHost } from '../sidecar/src/mobile-host';

test('mobile host: actual HTTP auth, lifecycle, voice isolation and idempotency', async t => {
  const reserve = net.createServer();
  await new Promise<void>(r => reserve.listen(0, '127.0.0.1', r));
  const port = (reserve.address() as net.AddressInfo).port;
  await new Promise<void>(r => reserve.close(() => r()));
  const origin = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(path.join(tmpdir(), 'kda-mobile-test-'));
  await writeFile(path.join(dir, 'index.html'), '<h1>isolated mobile fixture</h1>');
  const controls = new Map<string, (event: any) => void>();
  const requests: any[] = [], voice: any[] = [];
  let autoReply = true;
  let host: MobileHost;
  host = new MobileHost(event => {
    if (event.type === 'mobile_control_result') controls.get(event.id as string)?.(event);
    if (event.type === 'mobile_request') {
      requests.push(event);
      if (!autoReply) return;
      setTimeout(() => host.receive({ type: 'mobile_control', action: 'reply', requestId: event.requestId,
        result: { method: event.method, params: event.params, state: 'submitted' } }), 5);
    }
  }, message => { voice.push(message); }, dir);
  const control = (action: string, params: any = {}) => new Promise<any>((resolve, reject) => {
    const id = randomUUID();
    controls.set(id, event => { controls.delete(id); event.error ? reject(Error(event.error)) : resolve(event.result); });
    host.receive({ type: 'mobile_control', action, id, ...params });
  });
  const post = (route: string, body: any, token = '', headers: Record<string, string> = {}) => fetch(origin + route, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body),
  });
  const rpc = (token: string, method: string, params: any = {}, id = randomUUID()) => post('/api/rpc', { id, method, params }, token);
  try {
    await t.test('default off and rejects insecure remote origin', async () => {
      assert.equal(host.status().enabled, false);
      await assert.rejects(control('enable', { origin: 'http://192.168.50.1', port }));
    });
    await control('enable', { origin, port });
    await t.test('loopback static asset has defensive browser headers', async () => {
      const response = await fetch(origin);
      assert.equal(response.status, 200); assert.match(await response.text(), /isolated mobile/);
      assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(host.status().loopback, '127.0.0.1');
    });
    await t.test('unauthenticated commands cannot reach desktop', async () => {
      assert.equal((await rpc('', 'send', { text: 'never' })).status, 401); assert.equal(requests.length, 0);
    });
    await t.test('cross origin and hostile host blocked before pairing', async () => {
      assert.equal((await post('/api/pair', { code: host.status().pairingCode }, '', { Origin: 'https://evil.example' })).status, 403);
      // Undici fetch normalizes Host. Use the wire-level client to exercise rebinding protection.
      const code = await new Promise<number>(resolve => {
        http.get(origin, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode!); });
      });
      assert.equal(code, 403);
    });
    await t.test('wrong code rejected', async () => { assert.equal((await post('/api/pair', { code: 'invalid' })).status, 401); });
    const code = host.status().pairingCode;
    const paired = await (await post('/api/pair', { code })).json() as any;
    const token = paired.token;
    await t.test('pair code single use and session has bounded expiry', async () => {
      assert.equal(typeof token, 'string'); assert.ok(paired.expires > Date.now());
      assert.ok(paired.expires <= Date.now() + 8 * 60 * 60_000);
      assert.equal((await post('/api/pair', { code })).status, 401); assert.equal(host.status().pairingCode, '');
    });
    await t.test('concurrent repeated command accepted exactly once', async () => {
      const id = randomUUID(), before = requests.length;
      const responses = await Promise.all([rpc(token, 'send', { text: 'one task' }, id), rpc(token, 'send', { text: 'one task' }, id)]);
      assert.equal(requests.length - before, 1);
      assert.deepEqual(await responses[0].json(), await responses[1].json());
    });
    await t.test('read polling does not exhaust mutation replay budget', async () => {
      for (let i = 0; i < 270; i++) assert.equal((await rpc(token, 'status')).status, 200);
      assert.equal((await rpc(token, 'send', { text: 'still allowed after polling' })).status, 200);
    });
    await t.test('unsupported action and excessive body fail closed', async () => {
      assert.equal((await rpc(token, 'shell', { command: 'whoami' })).status, 400);
      assert.equal((await rpc(token, 'send', { text: 'x'.repeat(121000) })).status, 400);
    });
    const sessionId = randomUUID();
    await t.test('remote voice session ownership checked', async () => {
      assert.equal((await rpc(token, 'voice', { action: 'stop', sessionId })).status, 409);
      assert.equal((await rpc(token, 'voice', { action: 'start', sessionId, conversationId: randomUUID(), sdp: 'v=0' })).status, 200);
      assert.equal((await rpc(token, 'voice', { action: 'reply', sessionId: randomUUID() })).status, 409);
    });
    await t.test('voice stream contains only owned session events', async () => {
      host.publishVoice({ type: 'voice_event', sessionId: randomUUID(), kind: 'sdp', sdp: 'private-other-session' });
      host.publishVoice({ type: 'voice_event', sessionId, kind: 'sdp', sdp: 'owned-answer' });
      const value = await (await post('/api/events', { after: 0 }, token)).json() as any;
      assert.equal(value.events.length, 1); assert.equal(value.events[0].event.sdp, 'owned-answer');
    });
    await t.test('voice event overflow is explicit, never silently skips commands', async () => {
      for (let i = 0; i < 140; i++) host.publishVoice({ type: 'voice_event', sessionId, kind: 'command', token: randomUUID() });
      assert.equal((await post('/api/events', { after: 0 }, token)).status, 409);
    });
    await t.test('disconnect revokes token and stops voice, keeps PC work independent', async () => {
      assert.equal((await post('/api/disconnect', {}, token)).status, 200);
      assert.equal((await rpc(token, 'status')).status, 401);
      assert.deepEqual(voice[0], { type: 'voice_stop', sessionId });
    });
    await control('rotate');
    const token2 = ((await (await post('/api/pair', { code: host.status().pairingCode })).json()) as any).token;
    await t.test('desktop receipt can be claimed only once', async () => {
      autoReply = false;
      const before = requests.length;
      const work = rpc(token2, 'status');
      while (requests.length === before) await new Promise(r => setTimeout(r, 2));
      const requestId = requests[requests.length - 1].requestId;
      assert.deepEqual(await control('claim', { requestId }), { valid: true });
      assert.deepEqual(await control('claim', { requestId }), { valid: false });
      host.receive({ type: 'mobile_control', action: 'reply', requestId, result: { state: 'verified' } });
      assert.equal((await work).status, 200); autoReply = true;
    });
    await t.test('revoking before desktop receipt cancels pending request and blocks late claim', async () => {
      autoReply = false;
      const before = requests.length;
      const work = rpc(token2, 'send', { text: 'must not dispatch after revoke' });
      while (requests.length === before) await new Promise(r => setTimeout(r, 2));
      const requestId = requests[requests.length - 1].requestId;
      await post('/api/disconnect', {}, token2);
      assert.equal((await work).status, 409);
      assert.deepEqual(await control('claim', { requestId }), { valid: false }); autoReply = true;
    });
    await control('rotate');
    const token3 = ((await (await post('/api/pair', { code: host.status().pairingCode })).json()) as any).token;
    await t.test('idle session expires after 90 seconds', async () => {
      const now = Date.now;
      try { Date.now = () => now() + 91_000; assert.equal((await rpc(token3, 'status')).status, 401); }
      finally { Date.now = now; }
    });
    await t.test('disable closes listener and invalidates all pairing credentials', async () => {
      await control('disable'); assert.equal(host.status().enabled, false); assert.equal(host.status().pairingCode, '');
      await assert.rejects(fetch(origin));
    });
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }); }
});
