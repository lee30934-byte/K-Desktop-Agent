import assert from 'node:assert/strict';
import readline from 'node:readline';

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const context = { threadId: 'thread-test', turnId: 'turn-test' };
const schema = { type: 'object', properties: { confirm_read: { type: 'boolean' } }, required: ['confirm_read'] };
const read = { id: 'read', type: 'mcpToolCall', server: 'k-personal', tool: 'fm_file_info', arguments: { path: 'fixture', confirm_read: true } };
const cases = [
  { name: 'confirmed-read', item: read, auto: true, duplicate: true },
  { name: 'missing-consent', item: { ...read, arguments: { path: 'fixture' } } },
  { name: 'string-consent', item: { ...read, arguments: { confirm_read: 'true' } } },
  { name: 'write-call', item: { ...read, tool: 'web_click' } },
  { name: 'unknown-tool', item: { ...read, tool: 'new_tool' } },
  { name: 'unknown-server', item: { ...read, server: 'other' }, serverName: 'other' },
  { name: 'new-question', item: read, schema: { type: 'object', properties: { approve: { type: 'boolean', default: true } }, required: ['approve'] } },
  { name: 'extra-field', item: read, schema: { ...schema, properties: { ...schema.properties, scope: { type: 'string' } } } },
  { name: 'no-call' },
  { name: 'finished-call', item: read, completed: true },
  { name: 'parallel-calls', item: read, parallel: true },
  { name: 'foreign-context', item: read, context: { threadId: 'other-thread', turnId: 'other-turn' } },
];
let index = 0;
let replies = 0;
function next() {
  if (index === cases.length) {
    send({ method: 'item/completed', params: { ...context, item: { id: 'answer', type: 'agentMessage', text: JSON.stringify({ replies }) } } });
    send({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'completed' } } });
    return;
  }
  const c = cases[index];
  if (c.item) send({ method: 'item/started', params: { ...(c.context ?? context), item: c.item } });
  if (c.parallel) send({ method: 'item/started', params: { ...context, item: { ...read, id: 'second' } } });
  if (c.completed) send({ method: 'item/completed', params: { ...context, item: c.item } });
  const request = { id: `request-${index}`, method: 'mcpServer/elicitation/request', params: {
    ...context, serverName: c.serverName ?? 'k-personal', mode: 'form', message: c.name,
    requestedSchema: c.schema ?? schema,
  } };
  send(request);
  if (c.duplicate) send(request);
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line);
  if (value.method === 'initialize') send({ id: value.id, result: {} });
  if (value.method === 'thread/start') send({ id: value.id, result: { thread: { id: 'thread-test' } } });
  if (value.method === 'turn/start') {
    send({ id: value.id, result: { turn: { id: 'turn-test' } } });
    setTimeout(next, 30);
  }
  if (!value.method && value.id?.startsWith('request-')) {
    assert.equal(value.id, `request-${index}`, 'duplicate or stale approval response');
    const c = cases[index];
    const auto = process.env.KDA_TEST_ESSENTIAL === '1' && c.auto;
    assert.deepEqual(value.result, auto ? { action: 'accept', content: { confirm_read: true } } : { action: 'decline', content: null });
    replies++;
    if (c.item) send({ method: 'item/completed', params: { ...context, item: c.item } });
    if (c.parallel) send({ method: 'item/completed', params: { ...context, item: { ...read, id: 'second' } } });
    index++;
    setTimeout(next, 10);
  }
});
