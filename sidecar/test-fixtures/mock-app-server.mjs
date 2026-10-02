import readline from "node:readline";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const value = JSON.parse(line);
  if (value.method === "initialize") send({ id: value.id, result: {} });
  if (value.method === "thread/start" || value.method === "thread/resume") {
    send({ id: value.id, result: { thread: { id: "thread-test" } } });
  }
  if (value.method === "turn/start") {
    send({ id: value.id, result: { turn: { id: "turn-test" } } });
    send({ method: "item/started", params: { item: {
      id: "item-test", type: "commandExecution", command: "Get-Item test-target",
      cwd: "C:/test", status: "inProgress",
    } } });
    send({ id: 99, method: "item/commandExecution/requestApproval", params: {
      threadId: "thread-test", turnId: "turn-test", itemId: "item-test",
      command: "Get-Item test-target", cwd: "C:/test",
    } });
  }
  if (value.id === 99 && value.result?.decision) {
    send({ method: "item/completed", params: { item: {
      id: "item-test", type: "commandExecution", command: "Get-Item test-target",
      cwd: "C:/test", status: value.result.decision === "accept" ? "completed" : "declined",
    } } });
    send({ method: "turn/completed", params: { turn: { id: "turn-test", status: "completed" } } });
  }
});
