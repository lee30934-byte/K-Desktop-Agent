import assert from "node:assert/strict";
import readline from "node:readline";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const base = { threadId: "thread-test", turnId: "turn-test", serverName: "test-mcp" };
const form = { mode: "form", message: "PRIVATE_MESSAGE_SENTINEL", requestedSchema: {
  type: "object", properties: { approve: { type: "boolean", default: true } }, required: ["approve"],
} };
const cases = [
  { ...base, ...form },
  { ...base, mode: "url", message: "PRIVATE_MESSAGE_SENTINEL", elicitationId: "url-test",
    url: "https://example.invalid/auth?token=PRIVATE_URL_SENTINEL" },
  { ...base, ...form, mode: "openai/form" },
  { ...base, ...form, mode: "openaiForm" },
  { ...base, ...form, turnId: null },
  { threadId: "thread-test", serverName: "test-mcp", ...form },
  { ...base, ...form, threadId: "other-thread" },
  { ...base, ...form, turnId: "stale-turn" },
  { ...base, mode: "future-mode" },
  {},
  null,
  { ...base, ...form, requestedSchema: { type: "object", properties: {} } },
];
const expected = new Set(cases.map((_, i) => i === 0 ? 0 : `elicit-${i}`));
const received = [];
let approvalDone = process.env.KDA_ELICITATION_ONLY === "1";
let fileSent = false;
let ended = false;
function complete() {
  if (ended || expected.size || !approvalDone) return;
  ended = true;
  send({ method: "item/completed", params: { item: {
    id: "answer", type: "agentMessage", text: JSON.stringify({ received, continued: true }),
  } } });
  send({ method: "turn/completed", params: { turn: { id: "turn-test", status: "completed" } } });
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const value = JSON.parse(line);
  if (value.method === "initialize") send({ id: value.id, result: {} });
  if (value.method === "thread/start" || value.method === "thread/resume") {
    send({ id: value.id, result: { thread: { id: "thread-test" } } });
  }
  if (value.method === "turn/start") {
    send({ id: value.id, result: { turn: { id: "turn-test" } } });
    if (!approvalDone) {
      send({ method: "item/started", params: { item: { id: "command-test", type: "commandExecution",
        command: "Get-Item test-target", cwd: "C:/test" } } });
      send({ id: "command-request", method: "item/commandExecution/requestApproval", params: {
        ...base, itemId: "command-test", command: "Get-Item test-target", cwd: "C:/test",
      } });
    }
    // A notification with no request ID must not produce a fabricated reply.
    send({ method: "mcpServer/elicitation/request", params: { ...base, ...form } });
    cases.forEach((params, i) => send({ id: i === 0 ? 0 : `elicit-${i}`,
      method: "mcpServer/elicitation/request", params }));
  }
  if (!value.method && Object.hasOwn(value, "id")) {
    if (expected.has(value.id)) {
      const index = value.id === 0 ? 0 : Number(value.id.slice(7));
      const accepted = process.env.KDA_PROBE_ELICITATION_ACTION === 'accept' && [0, 2, 3, 4, 5, 11].includes(index);
      assert.deepEqual(value.result, accepted ? { action: 'accept', content: index === 11 ? {} : { approve: false } } : { action: 'decline', content: null });
      expected.delete(value.id);
      received.push({ id: value.id, result: value.result });
      send({ method: "serverRequest/resolved", params: { requestId: value.id } });
    } else if (value.id === "command-request" && !fileSent) {
      assert.ok(["accept", "decline"].includes(value.result?.decision));
      received.push({ id: value.id, result: value.result });
      fileSent = true;
      send({ method: "item/started", params: { item: { id: "file-test", type: "fileChange",
        changes: [{ path: "C:/test/fixture.txt", kind: "add", diff: "+fixture" }] } } });
      send({ id: "file-request", method: "item/fileChange/requestApproval", params: { ...base, itemId: "file-test" } });
    } else if (value.id === "file-request" && !approvalDone) {
      assert.ok(["accept", "decline"].includes(value.result?.decision));
      received.push({ id: value.id, result: value.result });
      approvalDone = true;
    } else {
      throw new Error(`Unexpected or duplicate response: ${JSON.stringify(value)}`);
    }
    complete();
  }
});
