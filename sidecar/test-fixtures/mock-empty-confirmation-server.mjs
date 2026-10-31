import assert from 'node:assert/strict';
import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const context = { threadId: 'thread-empty', turnId: 'turn-empty' };
let replies = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line);
  if (value.method === 'initialize') send({ id: value.id, result: {} });
  if (value.method === 'thread/start') send({ id: value.id, result: { thread: { id: context.threadId } } });
  if (value.method === 'turn/start') {
    send({ id: value.id, result: { turn: { id: context.turnId } } });
    send({ method: 'item/started', params: { ...context, item: {
      id: 'tool-empty', type: 'mcpToolCall', server: 'k-personal', tool: 'ui_find',
      arguments: { title_contains: 'fixture', name: 'fixture' },
    } } });
    send({ id: 'empty-consent', method: 'mcpServer/elicitation/request', params: {
      ...context, serverName: 'k-personal', mode: 'form',
      message: 'Allow the k-personal MCP server to run tool "ui_find"?',
      requestedSchema: { type: 'object', properties: {} },
    } });
  }
  if (!value.method && value.id === 'empty-consent') {
    assert.equal(++replies, 1, 'The same tool confirmation must never be answered twice');
    const action = process.env.KDA_TEST_AUTO_APPROVAL === '1' ? 'accept' : 'decline';
    assert.deepEqual(value.result, { action, content: action === 'accept' ? {} : null });
    send({ method: 'serverRequest/resolved', params: { requestId: value.id } });
    send({ method: 'item/completed', params: { ...context, item: {
      id: 'empty-answer', type: 'agentMessage', text: JSON.stringify({ replies, action }),
    } } });
    send({ method: 'turn/completed', params: { turn: { id: context.turnId, status: 'completed' } } });
  }
});
