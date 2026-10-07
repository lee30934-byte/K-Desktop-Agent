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
  proc.stderr.on('data', d => err += d);
  const timer = setTimeout(() => treeKill(proc.pid, 'SIGKILL', () => {}), 10000);
  const send = v => proc.stdin.write(JSON.stringify(v) + '\n');
  readline.createInterface({ input: proc.stdout }).on('line', line => {
    const v = JSON.parse(line);
    if (v.type === 'turn.completed') completed++;
    if (v.type === 'elicitation.resolved') resolved++;
    if (v.type !== 'elicitation.requested') return;
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
}
console.log('MCP elicitation UI protocol: accept/decline/cancel/invalid-content, null turn ID, exact token binding, replay and resolved request rejection PASS');
