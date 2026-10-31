// One Codex app-server process per KDA turn. Stdout speaks the existing Codex
// exec JSONL event format plus approval.requested; stdin accepts start/approval.
// No approval is inherited from a previous turn. KDA can suppress an exact,
// redundant confirm_read form for an already-confirmed active read call.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import treeKill from "tree-kill";
import { parseElicitationSchema, validateElicitationContent } from "./mcp-elicitation-schema.mjs";

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
let essentialApprovals = false;
const autoResolved = new Set();
// Keep this explicit: arbitrary evaluate, UI actions, writes and new tools ask.
const readConfirmationTools = new Set([
  "fm_list_directory", "fm_file_info", "fm_recent_files", "fm_search_files",
  "fm_disk_usage", "fm_operation_log", "fm_list_backups", "db_todo_list",
  "db_note_search", "db_note_list", "db_habit_list", "app_list_registered",
  "app_list_running", "ui_dump_tree", "ui_find", "ui_get_text", "ui_list_windows",
  "web_snapshot", "web_get_text", "web_url", "cc_screenshot",
  "cc_screenshot_region", "cc_mouse_position", "cc_screen_size", "cc_list_windows",
  "clip_get", "clip_snippet_list",
]);

function redundantReadContent(params) {
  if (!essentialApprovals || params.serverName !== "k-personal") return null;
  const fields = parseElicitationSchema(params.requestedSchema);
  if (fields?.length !== 1 || fields[0].name !== "confirm_read" ||
      fields[0].type !== "boolean" || !fields[0].required) return null;
  // Elicitation has no itemId. Ambiguous concurrent calls must still ask.
  const active = [...items.values()].filter(i => i.type === "mcpToolCall" && i.server === "k-personal");
  if (active.length !== 1) return null;
  const call = active[0];
  if (call._threadId !== threadId || call._turnId !== turnId ||
      !readConfirmationTools.has(call.tool) || call.arguments?.confirm_read !== true) return null;
  return { confirm_read: true };
}

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

// Diagnostics deliberately exclude RPC IDs, permission tokens, server payloads,
// field names and submitted values. traceId is an independent correlation ID.
function diagnostic(entry, reason, terminal = false) {
  emit({ type: "elicitation.diagnostic", traceId: entry?.traceId ?? null,
    reason, terminal, elapsedMs: entry ? Math.max(0, Date.now() - entry.createdAt) : null });
}

function decline(key, reason = "timeout") {
  const entry = pending.get(key);
  if (!entry) return;
  pending.delete(key);
  clearTimeout(entry.timer);
  send({ id: entry.rpcId, result: entry.kind === "elicitation"
    ? { action: "decline", content: null } : { decision: "decline" } });
  if (entry.kind === "elicitation") {
    diagnostic(entry, reason, true);
    emit({ type: "elicitation.resolved", token: key });
  }
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
  if (method === "mcpServer/elicitation/request") {
    const trace = { traceId: randomUUID(), createdAt: Date.now() };
    diagnostic(trace, "received");
    if (typeof message.id !== "string" && !Number.isSafeInteger(message.id)) {
      diagnostic(trace, "invalid_request", true); return;
    }
    // turnId is optional in Codex 0.158. The process and RPC ID bind requests
    // lacking it to this KDA turn. Mismatching non-null IDs are never accepted.
    const valid = !finished && params && threadId && params.threadId === threadId &&
      (params.turnId == null || (typeof params.turnId === "string" && (!turnId || params.turnId === turnId))) &&
      typeof params.serverName === "string" && params.serverName.length > 0 && params.serverName.length <= 200 &&
      typeof params.message === "string" && params.message.trim().length > 0 && params.message.length <= 12000 &&
      ["form", "openai/form", "openaiForm"].includes(params.mode) && parseElicitationSchema(params.requestedSchema);
    if (!valid || pending.size >= 16) {
      diagnostic(trace, pending.size >= 16 ? "pending_limit" :
        finished ? "turn_finished" : params?.threadId !== threadId ? "request_thread_mismatch" :
        params?.turnId != null && turnId && params.turnId !== turnId ? "request_turn_mismatch" :
        !["form", "openai/form", "openaiForm"].includes(params?.mode) ? "unsupported_mode" :
        !parseElicitationSchema(params?.requestedSchema) ? "unsupported_schema" : "invalid_request", true);
      send({ id: message.id, result: { action: "decline", content: null } });
      emit({ type: "provider.notice", code: "mcp_elicitation_declined",
        message: "연결된 도구의 요청 형식·대화 정보를 확인할 수 없어 거절했습니다. URL 인증과 지원하지 않는 입력 형식은 승인되지 않으며 대화는 계속됩니다." });
      return;
    }
    if ([...pending.values()].some(e => e.rpcId === message.id)) {
      diagnostic(trace, "duplicate_request"); return;
    }
    if (autoResolved.has(message.id)) { diagnostic(trace, "duplicate_request", true); return; }
    const content = redundantReadContent(params);
    if (content && validateElicitationContent(params.requestedSchema, content)) {
      autoResolved.add(message.id);
      send({ id: message.id, result: { action: "accept", content } });
      diagnostic(trace, "confirmed_read_reused", true);
      return;
    }
    if (!turnId && params.turnId) turnId = params.turnId;
    const token = randomUUID();
    const expiresAt = Date.now() + 120_000;
    const timer = setTimeout(() => decline(token), 120_000);
    pending.set(token, { ...trace, kind: "elicitation", rpcId: message.id, timer, threadId,
      turnId: params.turnId ?? null, schema: params.requestedSchema, expiresAt });
    diagnostic(trace, "awaiting_response");
    emit({ type: "elicitation.requested", traceId: trace.traceId, token, threadId, turnId: params.turnId ?? null,
      serverName: params.serverName, message: params.message, schema: params.requestedSchema, expiresAt });
    return;
  }
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
    const expiresAt = Date.now() + 120_000;
    const timer = setTimeout(() => decline(token), 120_000);
    pending.set(token, { rpcId: message.id, timer, threadId, turnId, itemId: params.itemId, expiresAt });
    emit({ type: "approval.requested", token, kind, threadId, turnId, itemId: params.itemId, expiresAt,
      command, cwd, changes, networkApprovalContext: params.networkApprovalContext ?? null,
      reason: params.reason ?? null });
    return;
  }
  if (method === "serverRequest/resolved") {
    for (const [token, entry] of pending) {
      if (entry.rpcId === params.requestId) {
        clearTimeout(entry.timer);
        pending.delete(token);
        if (entry.kind === "elicitation") {
          diagnostic(entry, "server_resolved", true);
          emit({ type: "elicitation.resolved", token });
        }
      }
    }
    return;
  }
  if (method === "thread/tokenUsage/updated") {
    latestUsage = params.tokenUsage?.last ?? params.tokenUsage?.total ?? latestUsage;
    return;
  }
  if (method === "item/started" && params.item) {
    items.set(params.item.id, { ...params.item, _threadId: params.threadId, _turnId: params.turnId });
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
    for (const token of [...pending.keys()]) decline(token, "turn_finished");
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
  essentialApprovals = input.essentialApprovals === true;
  if (server) throw new Error("bridge already started");
  const codex = input.codex;
  if (typeof codex !== "string" || !codex || typeof input.prompt !== "string") throw new Error("invalid bridge start");
  server = spawn(codex, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32", windowsHide: true,
    env: process.env,
  });
  server.on("error", (error) => fail(error.message));
  server.on("close", (code) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      if (entry.kind === "elicitation") diagnostic(entry, "server_closed", true);
    }
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
  // v0.7.48 — 스레드 단위 config override (현재 REA MCP 주입용). 전역 config.toml 은 건드리지 않는다.
  // resume 에도 같이 실어야 그 turn 의 app-server 프로세스가 MCP 서버를 띄운다.
  const threadConfig = input.config && typeof input.config === "object" && !Array.isArray(input.config)
    ? { config: input.config } : {};
  const threadParams = input.threadId
    ? { threadId: input.threadId, approvalPolicy: "on-request", sandbox: "danger-full-access", ...threadConfig }
    : { approvalPolicy: "on-request", sandbox: "danger-full-access", cwd: process.cwd(),
        ...(input.model ? { model: input.model } : {}), ...threadConfig };
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
    if (value.type === "elicitation") {
      const entry = pending.get(value.token);
      if (!entry || entry.kind !== "elicitation") { diagnostic(null, "unknown_or_resolved_response"); return; }
      if (value.threadId !== entry.threadId || value.turnId !== entry.turnId) {
        diagnostic(entry, "response_binding_mismatch"); return;
      }
      diagnostic(entry, "response_received");
      if (Date.now() >= entry.expiresAt) { decline(value.token); return; }
      if (!["accept", "decline", "cancel"].includes(value.action)) { diagnostic(entry, "invalid_action"); return; }
      if (value.action === "accept" && !validateElicitationContent(entry.schema, value.content)) {
        decline(value.token, "invalid_content"); return;
      }
      pending.delete(value.token);
      clearTimeout(entry.timer);
      send({ id: entry.rpcId, result: { action: value.action, content: value.action === "accept" ? value.content : null } });
      diagnostic(entry, `${value.action}_forwarded`, true);
      emit({ type: "elicitation.resolved", token: value.token });
      return;
    }
    if (value.type !== "approval") return;
    const entry = pending.get(value.token);
    if (!entry || entry.kind === "elicitation" || value.threadId !== entry.threadId || value.turnId !== entry.turnId || value.itemId !== entry.itemId) return;
    if (Date.now() >= entry.expiresAt) { decline(value.token); return; }
    if (value.decision !== "accept" && value.decision !== "decline") return;
    pending.delete(value.token);
    clearTimeout(entry.timer);
    send({ id: entry.rpcId, result: { decision: value.decision } });
  } catch (error) { fail(`Codex bridge input: ${error.message}`); }
});
