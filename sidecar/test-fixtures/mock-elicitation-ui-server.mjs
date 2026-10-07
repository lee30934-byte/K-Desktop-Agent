import assert from 'node:assert/strict';
import readline from 'node:readline';
const send = v => process.stdout.write(JSON.stringify(v) + '\n');
const base = { threadId: 'thread-ui', serverName: 'fixture', mode: 'openai/form', message: 'Approve fixture read once?',
  requestedSchema: { type: 'object', properties: { approve: { type: 'boolean', default: true } }, required: ['approve'] } };
let responses = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const v = JSON.parse(line);
  if (v.method === 'initialize') send({ id: v.id, result: {} });
  if (v.method === 'thread/start') send({ id: v.id, result: { thread: { id: 'thread-ui' } } });
  if (v.method === 'turn/start') {
    send({ id: v.id, result: { turn: { id: 'turn-ui' } } });
    send({ id: 0, method: 'mcpServer/elicitation/request', params: { ...base, turnId: null } });
    send({ id: 'second', method: 'mcpServer/elicitation/request', params: { ...base, turnId: 'turn-ui' } });
  }
  if (!v.method && Object.hasOwn(v, 'id')) {
    assert.ok([0, 'second'].includes(v.id));
    const action = process.env.KDA_FIXTURE_ACTION ?? 'accept';
    assert.deepEqual(v.result, { action, content: action === 'accept' ? { approve: false } : null });
    responses++;
    if (responses === 2) {
      send({ method: 'serverRequest/resolved', params: { requestId: 'second' } });
      send({ id: 'resolved', method: 'mcpServer/elicitation/request', params: { ...base, turnId: 'turn-ui' } });
      send({ method: 'serverRequest/resolved', params: { requestId: 'resolved' } });
      setTimeout(() => send({ method: 'turn/completed', params: { turn: { id: 'turn-ui', status: 'completed' } } }), 50);
    }
  }
});
