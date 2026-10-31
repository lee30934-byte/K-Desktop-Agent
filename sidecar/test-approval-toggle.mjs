import assert from 'node:assert/strict';
import { automaticConfirmation, automaticResponse } from '../src/approvalAutomation.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import treeKill from 'tree-kill';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = name => ({ type: 'object', properties: { [name]: { type: 'boolean' } }, required: [name] });
for (const name of ['approve', 'approved', 'confirm', 'confirm_read', 'confirm_action']) {
  assert.deepEqual(automaticConfirmation(schema(name)), { [name]: true });
}
for (const empty of [
  { type: 'object', properties: {} },
  { type: 'object', properties: {}, required: [], additionalProperties: false },
]) assert.deepEqual(automaticConfirmation(empty), {}, 'Empty confirmation forms require no invented input');
for (const s of [null, {}, schema('remember_me'), { ...schema('approve'), required: [] },
  { type: 'object', properties: { answer: { type: 'string', default: 'yes' } }, required: ['answer'] },
  { type: 'object', properties: {}, required: ['missing'] },
  { type: 'object', properties: {}, additionalProperties: true },
  { type: 'object', properties: {}, futureConstraint: true },
  { ...schema('approve'), properties: { approve: { type: 'boolean' }, secret: { type: 'string' } } }]) {
  assert.equal(automaticConfirmation(s), null, 'Questions and arbitrary fields must remain manual');
}
const base = { type: 'codex_elicitation_request', id: 'kda-turn', token: 'token', threadId: 'thread',
  turnId: null, conversation_id: 'conv', expiresAt: Date.now() + 10000, schema: schema('approve') };
assert.equal(automaticResponse(base).action, 'accept');
assert.deepEqual(automaticResponse({ ...base, schema: { type: 'object', properties: {} } }),
  { action: 'accept', content: {} });
for (const patch of [{ id: '' }, { threadId: '' }, { token: '' }, { conversation_id: '' },
  { expiresAt: 0 }, { expiresAt: NaN }, { expiresAt: Infinity }]) assert.equal(automaticResponse({ ...base, ...patch }), null);

// Exercise the actual bridge with the same policy used by the rendered UI.
for (const enabled of [false, true]) {
  const proc = spawn(process.execPath, [path.join(here, 'src/codex-app-server-bridge.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const ended = once(proc, 'close');
  const timer = setTimeout(() => treeKill(proc.pid, 'SIGKILL', () => {}), 12000);
  let stderr = '', requests = 0;
  const responses = [];
  proc.stderr.on('data', d => stderr += d);
  const send = value => proc.stdin.write(JSON.stringify(value) + '\n');
  readline.createInterface({ input: proc.stdout }).on('line', line => {
    const event = JSON.parse(line);
    if (event.type !== 'approval.requested') return;
    requests++;
    assert.ok(event.expiresAt > Date.now());
    const request = { ...event, type: 'codex_approval_request', id: 'kda-turn', conversation_id: 'conv' };
    assert.equal(automaticResponse({ ...request, expiresAt: 0 }), null);
    assert.equal(automaticResponse({ ...request, itemId: '' }), null);
    assert.equal(automaticResponse({ ...request, command: 'x'.repeat(13000) }), null);
    const reply = enabled ? automaticResponse(request) : null;
    responses.push(reply);
    const payload = { type: 'approval', token: event.token, threadId: event.threadId,
      turnId: event.turnId, itemId: event.itemId, decision: reply?.action ?? 'decline' };
    send({ ...payload, itemId: 'other-item' });
    send(payload);
    send(payload);
  });
  const events = [];
  readline.createInterface({ input: proc.stdout }).on('line', line => events.push(JSON.parse(line)));
  send({ type: 'start', codex: path.join(here, 'test-fixtures/mock-app-server.cmd'), prompt: 'offline' });
  const [code] = await ended;
  clearTimeout(timer);
  assert.equal(code, 0, stderr);
  assert.equal(requests, 1);
  assert.equal(responses[0]?.action ?? null, enabled ? 'accept' : null);
  assert.equal(events.find(e => e.type === 'item.completed').item.status, enabled ? 'completed' : 'declined');
  assert.equal(events.filter(e => e.type === 'turn.completed').length, 1);
}
// The bridge must accept exactly the empty object, continue, and reject replay.
for (const enabled of [false, true]) {
  const proc = spawn(process.execPath, [path.join(here, 'src/codex-app-server-bridge.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, KDA_TEST_NODE: process.execPath, KDA_TEST_AUTO_APPROVAL: enabled ? '1' : '0' },
  });
  const ended = once(proc, 'close');
  let timedOut = false, stderr = '';
  const timer = setTimeout(() => { timedOut = true; treeKill(proc.pid, 'SIGKILL', () => {}); }, 12000);
  const events = [];
  proc.stderr.on('data', d => stderr += d);
  const send = value => proc.stdin.write(JSON.stringify(value) + '\n');
  readline.createInterface({ input: proc.stdout }).on('line', line => {
    const event = JSON.parse(line);
    events.push(event);
    if (event.type !== 'elicitation.requested') return;
    const request = { ...event, type: 'codex_elicitation_request', id: 'empty-turn', conversation_id: 'conv' };
    const reply = enabled ? automaticResponse(request) : { action: 'decline', content: null };
    assert.deepEqual(reply, enabled ? { action: 'accept', content: {} } : { action: 'decline', content: null });
    const payload = { type: 'elicitation', token: event.token, threadId: event.threadId, turnId: event.turnId, ...reply };
    send({ ...payload, threadId: 'wrong-thread' });
    send(payload);
    send(payload);
  });
  send({ type: 'start', codex: path.join(here, 'test-fixtures/mock-empty-confirmation-server.cmd'), prompt: 'offline empty confirmation' });
  const [code] = await ended;
  clearTimeout(timer);
  assert.equal(timedOut, false);
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  assert.equal(events.filter(e => e.type === 'elicitation.requested').length, 1);
  assert.equal(events.filter(e => e.type === 'elicitation.resolved').length, 1);
  const answer = events.find(e => e.type === 'item.completed' && e.item.type === 'agent_message');
  assert.deepEqual(JSON.parse(answer.item.text), { replies: 1, action: enabled ? 'accept' : 'decline' });
  assert.equal(events.filter(e => e.type === 'turn.completed').length, 1);
}
console.log('Approval toggle: confirmation policy, missing input/expiry rejection, bridge ON/OFF and replay isolation PASS');
