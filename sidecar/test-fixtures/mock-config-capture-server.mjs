// v0.7.48 — thread/start·thread/resume 파라미터를 KDA_CAPTURE_FILE 에 기록하는 mock app-server.
// test-rea-mcp.mjs 가 브리지의 스레드 단위 config 전달(REA 주입)을 검증할 때 쓴다.
import readline from "node:readline";
import { appendFileSync } from "node:fs";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const value = JSON.parse(line);
  if (value.method === "initialize") send({ id: value.id, result: {} });
  if (value.method === "thread/start" || value.method === "thread/resume") {
    appendFileSync(process.env.KDA_CAPTURE_FILE, JSON.stringify({ method: value.method, params: value.params }) + "\n");
    send({ id: value.id, result: { thread: { id: "thread-test" } } });
  }
  if (value.method === "turn/start") {
    send({ id: value.id, result: { turn: { id: "turn-test" } } });
    send({ method: "turn/completed", params: { turn: { id: "turn-test", status: "completed" } } });
  }
});
