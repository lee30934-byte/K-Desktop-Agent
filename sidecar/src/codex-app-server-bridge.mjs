// One Codex app-server process per KDA turn. Stdout speaks the existing Codex
// exec JSONL event format plus approval.requested; stdin accepts start/approval.
// No approval is inferred from KDA permission settings or a previous turn.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import treeKill from "tree-kill";

const stopServer = () => {
  if (server?.pid) treeKill(server.pid, "SIGKILL", () => {});
};

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (message) => {
  process.stderr.write(`${String(message)}\n`);
  process.exitCode = 1;
  inputReader?.close();
  process.stdin.pause();
  stopServer();
};
let server;
let inputReader;
let nextId = 1;
let threadId = null;
let turnId = null;
let latestUsage = {};
let finished = false;
const calls = new Map();
const pending = new Map();
const items = new Map();

function send(value) {
  if (!server?.stdin?.writable) throw new Error("Codex app-server stdin closed");
  server.stdin.write(`${JSON.stringify(value)}\n`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    calls.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

function mapItem(item) {
  const type = {
    agentMessage: "agent_message",
    commandExecution: "command_exec",
    mcpToolCall: "mcp_tool_call",
    fileChange: "file_change",
  }[item.type] ?? item.type;
  return {
    ...item,
    type,
    output: item.aggregatedOutput ?? item.output,
    tool: item.tool,
    path: item.changes?.[0]?.path,
    change: item.changes,
  };
}

function decline(key) {
  const entry = pending.get(key);
  if (!entry) return;
  pending.delete(key);
  clearTimeout(entry.timer);
  send({ id: entry.rpcId, result: { decision: "decline" } });
}

function onServerMessage(message) {
  if (Object.hasOwn(message, "id") && !message.method) {
    const call = calls.get(message.id);
    if (!call) return;
    calls.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else call.resolve(message.result);
    return;
  }
  const { method, params = {} } = message;
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    if (!turnId && typeof params.turnId === "string") turnId = params.turnId;
    // Missing identifiers or a mismatched conversation cannot be approved.
    if (!threadId || !turnId || params.threadId !== threadId || params.turnId !== turnId || !params.itemId) {
      send({ id: message.id, result: { decision: "decline" } });
      return;
    }
    const item = items.get(params.itemId);
    const kind = method.includes("commandExecution") ? "command" : "file";
    const command = params.command ?? item?.command ?? null;
    const cwd = params.cwd ?? item?.cwd ?? null;
    const changes = kind === "file" ? item?.changes ?? null : null;
    if (kind === "command" && !command && !params.networkApprovalContext) {
      send({ id: message.id, result: { decision: "decline" } });
      return;
    }
    if (kind === "file" && (!Array.isArray(changes) || changes.length === 0)) {
      send({ id: message.id, result: { decision: "decline" } });
      return;
    }
    const token = randomUUID();
    const timer = setTimeout(() => decline(token), 120_000);
    pending.set(token, { rpcId: message.id, timer, threadId, turnId, itemId: params.itemId });
    emit({ type: "approval.requested", token, kind, threadId, turnId, itemId: params.itemId,
      command, cwd, changes, networkApprovalContext: params.networkApprovalContext ?? null,
      reason: params.reason ?? null });
    return;
  }
  if (method === "serverRequest/resolved") {
    for (const [token, entry] of pending) {
      if (entry.rpcId === params.requestId) {
        clearTimeout(entry.timer);
        pending.delete(token);
      }
    }
    return;
  }
  if (method === "thread/tokenUsage/updated") {
    latestUsage = params.tokenUsage?.last ?? params.tokenUsage?.total ?? latestUsage;
    return;
  }
  if (method === "item/started" && params.item) {
    items.set(params.item.id, params.item);
    emit({ type: "item.started", item: mapItem(params.item) });
    return;
  }
  if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
    emit({ type: "item.delta", item: { type: "agent_message", text: params.delta } });
    return;
  }
  if (method === "item/completed" && params.item) {
    items.delete(params.item.id);
    emit({ type: "item.completed", item: mapItem(params.item) });
    return;
  }
  if (method === "turn/completed") {
    if (finished) return;
    finished = true;
    for (const token of [...pending.keys()]) decline(token);
    if (params.turn?.status !== "completed") {
      fail(params.turn?.error?.message ?? `Codex turn ${params.turn?.status ?? "failed"}`);
      return;
    }
    emit({ type: "turn.completed", usage: {
      input_tokens: latestUsage.inputTokens ?? 0,
      cached_input_tokens: latestUsage.cachedInputTokens ?? 0,
      output_tokens: latestUsage.outputTokens ?? 0,
    } });
    stopServer();
    return;
  }
  // Unknown server-initiated requests must not wait forever or inherit consent.
  if (Object.hasOwn(message, "id") && method) fail(`Unsupported Codex approval request: ${method}`);
}

async function start(input) {
  if (server) throw new Error("bridge already started");
  const codex = input.codex;
  if (typeof codex !== "string" || !codex || typeof input.prompt !== "string") throw new Error("invalid bridge start");
  server = spawn(codex, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32", windowsHide: true,
    env: process.env,
  });
  server.on("error", (error) => fail(error.message));
  server.on("close", (code) => {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
    if (!finished) fail(`Codex app-server closed before turn completion (exit ${code})`);
    inputReader?.close();
    process.stdin.pause();
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const reader = readline.createInterface({ input: server.stdout, crlfDelay: Infinity });
  reader.on("line", (line) => {
    try { onServerMessage(JSON.parse(line)); }
    catch (error) { fail(`Codex app-server protocol: ${error.message}`); }
  });
  await request("initialize", { clientInfo: { name: "k_desktop_agent", title: "K Desktop Agent", version: "0.7.41" } });
  send({ method: "initialized", params: {} });
  const threadParams = input.threadId
    ? { threadId: input.threadId, approvalPolicy: "on-request", sandbox: "danger-full-access" }
    : { approvalPolicy: "on-request", sandbox: "danger-full-access", cwd: process.cwd(),
        ...(input.model ? { model: input.model } : {}) };
  const thread = await request(input.threadId ? "thread/resume" : "thread/start", threadParams);
  threadId = thread?.thread?.id;
  if (!threadId) throw new Error("Codex app-server returned no thread id");
  emit({ type: "thread.started", thread_id: threadId });
  const turn = await request("turn/start", { threadId,
    input: [{ type: "text", text: input.prompt }], cwd: process.cwd(),
    approvalPolicy: "on-request", sandboxPolicy: { type: "dangerFullAccess" },
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  });
  if (turnId && turn?.turn?.id !== turnId) throw new Error("Codex turn id changed during approval");
  turnId = turn?.turn?.id;
  if (!turnId) throw new Error("Codex app-server returned no turn id");
  emit({ type: "turn.started" });
}

inputReader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
inputReader.on("line", (line) => {
  try {
    const value = JSON.parse(line);
    if (value.type === "start") { void start(value).catch((error) => fail(error.message)); return; }
    if (value.type !== "approval") return;
    const entry = pending.get(value.token);
    if (!entry || value.threadId !== entry.threadId || value.turnId !== entry.turnId || value.itemId !== entry.itemId) return;
    if (value.decision !== "accept" && value.decision !== "decline") return;
    pending.delete(value.token);
    clearTimeout(entry.timer);
    send({ id: entry.rpcId, result: { decision: value.decision } });
  } catch (error) { fail(`Codex bridge input: ${error.message}`); }
});
