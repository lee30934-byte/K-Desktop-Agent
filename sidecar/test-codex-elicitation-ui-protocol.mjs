import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import treeKill from 'tree-kill';
const here = path.dirname(fileURLToPath(import.meta.url));
for (const action of ['accept', 'decline', 'cancel', 'invalid-content', 'timeout']) {
  const args = action === 'timeout' ? ['--import', pathToFileURL(path.join(here, 'test-fixtures/elicitation-fast-clock.mjs')).href] : [];
  const proc = spawn(process.execPath, [...args, path.join(here, 'src/codex-app-server-bridge.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, KDA_FIXTURE_ACTION: ['invalid-content', 'timeout'].includes(action) ? 'decline' : action }, windowsHide: true });
  const ended = once(proc, 'close');
  let err = '', count = 0, completed = 0, resolved = 0;
  const diagnostics = [], requests = [];
  proc.stderr.on('data', d => err += d);
  const timer = setTimeout(() => treeKill(proc.pid, 'SIGKILL', () => {}), 10000);
  const send = v => proc.stdin.write(JSON.stringify(v) + '\n');
  readline.createInterface({ input: proc.stdout }).on('line', line => {
    const v = JSON.parse(line);
    if (v.type === 'elicitation.diagnostic') diagnostics.push(v);
    if (v.type === 'turn.completed') completed++;
    if (v.type === 'elicitation.resolved') resolved++;
    if (v.type !== 'elicitation.requested') return;
    requests.push(v);
    count++;
    if (action === 'timeout') return;
    const reply = { type: 'elicitation', token: v.token, threadId: v.threadId, turnId: v.turnId,
      action: action === 'invalid-content' ? 'accept' : action, content: action === 'invalid-content' ? { approve: 'true' } : { approve: false } };
    if (count === 3) { setTimeout(() => send(reply), 10); return; } // resolved request cannot be reused
    send({ ...reply, threadId: 'other-thread' });
    send({ ...reply, turnId: 'stale-turn' });
    send({ ...reply, type: 'approval', decision: 'accept' });
    setTimeout(() => { send(reply); send(reply); }, 10); // duplicate consent must not execute twice
  });
  send({ type: 'start', codex: path.join(here, 'test-fixtures/mock-elicitation-ui-server.cmd'), prompt: 'offline' });
  const [code] = await ended;
  clearTimeout(timer);
  assert.equal(code, 0, err); assert.equal(count, 3); assert.equal(resolved, 3); assert.equal(completed, 1);
  assert.equal(new Set(requests.map(r => r.traceId)).size, 3);
  const expected = action === 'invalid-content' ? 'invalid_content' : action === 'timeout' ? 'timeout' : `${action}_forwarded`;
  for (const request of requests.slice(0, 2)) {
    const timeline = diagnostics.filter(d => d.traceId === request.traceId);
    assert.equal(timeline[0].reason, 'received');
    assert.ok(timeline.some(d => d.reason === 'awaiting_response'));
    assert.deepEqual(timeline.filter(d => d.terminal).map(d => d.reason), [expected]);
    if (action !== 'timeout') assert.equal(timeline.filter(d => d.reason === 'response_binding_mismatch').length, 2);
  }
  assert.ok(diagnostics.some(d => d.traceId === requests[2].traceId && d.reason === 'server_resolved' && d.terminal));
  if (action !== 'timeout') assert.ok(diagnostics.some(d => d.reason === 'unknown_or_resolved_response'));
  for (const d of diagnostics) {
    assert.deepEqual(Object.keys(d).sort(), ['elapsedMs', 'reason', 'terminal', 'traceId', 'type']);
    assert.ok(d.elapsedMs === null || d.elapsedMs >= 0);
    for (const request of requests) assert.ok(!JSON.stringify(d).includes(request.token), 'permission token leaked into diagnostics');
  }
}
console.log('MCP elicitation UI protocol + diagnostics: 5 scenarios; correlation, terminal reasons, binding/replay rejection and metadata-only logging PASS');
