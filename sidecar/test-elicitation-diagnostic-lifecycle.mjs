import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import treeKill from 'tree-kill';
const here = path.dirname(fileURLToPath(import.meta.url));
for (const reason of ['turn_finished', 'server_closed']) {
  const proc = spawn(process.execPath, [path.join(here, 'src/codex-app-server-bridge.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, KDA_FIXTURE_END: reason, KDA_FIXTURE_ACTION: 'decline' },
  });
  const closed = once(proc, 'close'), events = [];
  let stderr = '', timeout = false;
  proc.stderr.on('data', d => stderr += d);
  const timer = setTimeout(() => { timeout = true; treeKill(proc.pid, 'SIGKILL', () => {}); }, 10000);
  readline.createInterface({ input: proc.stdout }).on('line', line => events.push(JSON.parse(line)));
  proc.stdin.write(JSON.stringify({ type: 'start', codex: path.join(here, 'test-fixtures/mock-elicitation-ui-server.cmd'), prompt: 'offline' }) + '\n');
  const [code] = await closed;
  clearTimeout(timer);
  assert.equal(timeout, false);
  assert.equal(code, reason === 'server_closed' ? 1 : 0, stderr);
  const requests = events.filter(e => e.type === 'elicitation.requested');
  assert.equal(requests.length, 2);
  const terminal = events.filter(e => e.type === 'elicitation.diagnostic' && e.terminal);
  assert.equal(terminal.length, 2);
  for (const r of requests) assert.deepEqual(terminal.filter(d => d.traceId === r.traceId).map(d => d.reason), [reason]);
}
console.log('Elicitation pending-request cleanup: turn completion and provider disconnect PASS');
