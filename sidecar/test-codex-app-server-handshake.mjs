// Read-only protocol smoke: no turn/start, model inference, or tool execution.
import { spawn } from "node:child_process";
import readline from "node:readline";

const proc = spawn(process.platform === "win32" ? "codex.cmd" : "codex", ["app-server", "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32", windowsHide: true,
});
let stderr = "";
proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
const reader = readline.createInterface({ input: proc.stdout });
const send = (value) => proc.stdin.write(`${JSON.stringify(value)}\n`);
const deadline = setTimeout(() => { console.error("app-server handshake timeout", stderr); proc.kill(); process.exitCode = 1; }, 12_000);
reader.on("line", (line) => {
  const value = JSON.parse(line);
  if (value.id === 1) {
    if (value.error) throw Error(value.error.message);
    send({ method: "initialized", params: {} });
    send({ id: 2, method: "thread/start", params: {
      cwd: process.cwd(), approvalPolicy: "on-request", sandbox: "danger-full-access",
    } });
  }
  if (value.id === 2) {
    clearTimeout(deadline);
    if (value.error) {
      console.error("thread/start rejected", value.error.message);
      process.exitCode = 1;
    } else {
      console.log("app-server initialize and onRequest thread/start accepted", value.result?.thread?.id ? "thread id present" : "thread id missing");
      if (!value.result?.thread?.id) process.exitCode = 1;
    }
    proc.kill();
  }
});
send({ id: 1, method: "initialize", params: {
  clientInfo: { name: "k_desktop_agent", title: "K Desktop Agent", version: "0.7.31" },
} });
