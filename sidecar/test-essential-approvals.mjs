import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import treeKill from 'tree-kill';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const enabled of [true, false]) {
  const proc = spawn(process.execPath, [process.env.KDA_TEST_BRIDGE ?? path.join(here, 'src/codex-app-server-bridge.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, KDA_TEST_NODE: process.execPath, KDA_TEST_ESSENTIAL: enabled ? '1' : '0' },
  });
  const events = [];
  let stderr = '';
  let timedOut = false;
  proc.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; treeKill(proc.pid, 'SIGKILL', () => {}); }, 15000);
  readline.createInterface({ input: proc.stdout }).on('line', line => {
    const event = JSON.parse(line);
    events.push(event);
    if (event.type === 'elicitation.requested') proc.stdin.write(JSON.stringify({ type: 'elicitation',
      token: event.token, threadId: event.threadId, turnId: event.turnId, action: 'decline', content: null }) + '\n');
  });
  proc.stdin.write(JSON.stringify({ type: 'start', codex: path.join(here, 'test-fixtures/mock-essential-approvals.cmd'),
    prompt: 'offline approval policy test', essentialApprovals: enabled }) + '\n');
  const [code] = await once(proc, 'close');
  clearTimeout(timer);
  assert.equal(timedOut, false, 'approval policy test timed out');
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  assert.equal(events.filter(e => e.type === 'elicitation.requested').length, enabled ? 11 : 12);
  assert.equal(events.filter(e => e.reason === 'confirmed_read_reused').length, enabled ? 1 : 0);
  const answer = events.find(e => e.type === 'item.completed' && e.item.type === 'agent_message');
  assert.deepEqual(JSON.parse(answer.item.text), { replies: 12 });
  assert.equal(events.filter(e => e.type === 'turn.completed').length, 1);
}
console.log('Essential approvals: 12 protocol cases x enabled/disabled PASS; risky, unknown, stale, ambiguous and unconfirmed requests still ask.');
