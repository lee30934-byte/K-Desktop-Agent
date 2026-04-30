#!/usr/bin/env node
/**
 * Phase 11 G1 — REST tool-call regression smoke.
 *
 * Two test layers, both run on every push:
 *
 *   Layer 1 (mock HTTP, always runs):
 *     - Spins up a local HTTP server that mimics OpenAI / Gemini SSE responses.
 *     - Drives runOpenAIChatRound / runGeminiRound through them and asserts the
 *       accumulator correctly reconstructs streamed tool_calls and parsed args.
 *     - Exercises the translator round-trip and message builders.
 *     - Zero external deps. ~1 s. CI-safe.
 *
 *   Layer 2 (live MCP, opt-in via K_PERSONAL_MCP_PATH existing):
 *     - Actually calls a read-only K-Personal MCP tool (cc_screen_size — no side effects).
 *     - Verifies dispatchModelToolCall returns a sane text output.
 *     - SKIPPED automatically when K-Personal isn't installed (CI hosted runners).
 *
 * Exit codes:
 *   0 = all assertions passed
 *   1 = at least one assertion failed
 *   2 = harness setup failed (build missing, mock server couldn't bind, etc)
 */

import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distRoot = resolve(__dirname, "..", "dist");
const distMcp = resolve(distRoot, "mcpClient.js");
const distSchema = resolve(distRoot, "toolSchema.js");
const distRest = resolve(distRoot, "restTools.js");
for (const p of [distMcp, distSchema, distRest]) {
  if (!existsSync(p)) {
    console.log(`[smoke-rest-tools] missing dist file: ${p}`);
    console.log(`[smoke-rest-tools] run \`npm run build\` in sidecar/ first.`);
    process.exit(2);
  }
}
const fileUrl = (p) => `file://${p.replace(/\\/g, "/")}`;
const { MCPClient } = await import(fileUrl(distMcp));
const {
  toOpenAITools,
  toGeminiFunctionDeclarations,
  namespacedToolName,
  denamespaceToolName,
  dispatchModelToolCall,
} = await import(fileUrl(distSchema));
const {
  runOpenAIChatRound,
  runGeminiRound,
  buildOpenAIAssistantToolMessage,
  buildOpenAIToolResultMessage,
  buildGeminiModelToolCallContent,
  buildGeminiToolResponseContent,
} = await import(fileUrl(distRest));

const failures = [];
const noopLogger = () => {};

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failures.push(msg);
  }
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}\n    expected: ${b}\n    actual:   ${a}`);
    failures.push(msg);
  }
}

// ─── Mock HTTP server ─────────────────────────────────────────────────────
//
// One server, route by URL path. Each route returns an SSE stream that mirrors a real
// provider's response shape. We split each "frame" with `\n\n` per SSE spec; the runners
// read incrementally so we drip-feed bytes (write, then setImmediate, then write...).

let server;
let baseUrl;

async function startMockServer() {
  return new Promise((resolveServer, rejectServer) => {
    server = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const reqBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : {};
        await routeRequest(req, res, reqBody);
      } catch (e) {
        res.statusCode = 500;
        res.end(String(e));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolveServer();
    });
    server.on("error", rejectServer);
  });
}

async function stopMockServer() {
  return new Promise((res) => server.close(() => res()));
}

function sse(res, frames) {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  // drip-feed each frame so the stream parser sees realistic chunking.
  const send = async () => {
    for (const f of frames) {
      res.write(`data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`);
      await new Promise((r) => setImmediate(r));
    }
    res.end();
  };
  void send();
}

async function routeRequest(req, res, body) {
  const url = req.url || "";

  // ── /openai/text-only ─────────────────────────────────────────────────
  // Streams 3 small text deltas + usage. No tool calls.
  if (url === "/openai/text-only") {
    sse(res, [
      { choices: [{ delta: { content: "안녕" } }] },
      { choices: [{ delta: { content: " K" } }] },
      { choices: [{ delta: { content: "님!" }, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      "[DONE]",
    ]);
    return;
  }

  // ── /openai/with-tool ────────────────────────────────────────────────
  // Streams a tool_call split across many deltas (typical OpenAI behaviour) — id and
  // function.name on the first delta, function.arguments fragmented over 4 frames.
  if (url === "/openai/with-tool") {
    sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "mcp__k-personal__fm_list_directory", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "path" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\":\"C:" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "/temp\"}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { usage: { prompt_tokens: 50, completion_tokens: 12 } },
      "[DONE]",
    ]);
    return;
  }

  // ── /openai/parallel-tools ────────────────────────────────────────────
  // Two tool calls in the same round, interleaved deltas.
  if (url === "/openai/parallel-tools") {
    sse(res, [
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: "call_a", type: "function", function: { name: "mcp__k-personal__cc_screen_size", arguments: "" } },
        { index: 1, id: "call_b", type: "function", function: { name: "mcp__k-personal__clip_get", arguments: "" } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "{}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]);
    return;
  }

  // ── /gemini/with-tool ─────────────────────────────────────────────────
  // Single chunk with text + functionCall in the same response (typical Gemini).
  if (url === "/gemini/with-tool") {
    sse(res, [
      {
        candidates: [{
          content: {
            parts: [
              { text: "지금 화면 크기를 확인할게요." },
              { functionCall: { name: "mcp__k-personal__cc_screen_size", args: {} } },
            ],
          },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 8 },
      },
    ]);
    return;
  }

  res.statusCode = 404;
  res.end(`unknown route ${url}`);
}

// ─── Layer 1: mock HTTP runners ───────────────────────────────────────────
async function runLayer1() {
  console.log(`\n[smoke-rest-tools] Layer 1 — mock HTTP runners`);
  await startMockServer();
  console.log(`  mock server: ${baseUrl}`);

  // Test 1: OpenAI text-only round
  {
    const r = await runOpenAIChatRound({
      endpoint: `${baseUrl}/openai/text-only`,
      headers: { "content-type": "application/json" },
      body: { model: "x", messages: [], stream: true },
      signal: new AbortController().signal,
      logger: noopLogger,
    });
    assertEq(r.text, "안녕 K님!", "OpenAI text-only: text accumulated");
    assertEq(r.toolCalls.length, 0, "OpenAI text-only: no tool calls");
    assertEq(r.finishReason, "stop", "OpenAI text-only: finish_reason=stop");
    assertEq(r.inputTokens, 10, "OpenAI text-only: input tokens");
    assertEq(r.outputTokens, 5, "OpenAI text-only: output tokens");
  }

  // Test 2: OpenAI with fragmented tool_call args
  {
    const onTextChunks = [];
    const r = await runOpenAIChatRound({
      endpoint: `${baseUrl}/openai/with-tool`,
      headers: { "content-type": "application/json" },
      body: {},
      signal: new AbortController().signal,
      onDelta: { onText: (t) => onTextChunks.push(t) },
      logger: noopLogger,
    });
    assertEq(onTextChunks.length, 0, "OpenAI w/tool: no text deltas (tool-only round)");
    assertEq(r.toolCalls.length, 1, "OpenAI w/tool: one tool call");
    assertEq(r.toolCalls[0].id, "call_abc", "OpenAI w/tool: id captured from first delta");
    assertEq(r.toolCalls[0].name, "mcp__k-personal__fm_list_directory", "OpenAI w/tool: name captured");
    assertEq(r.toolCalls[0].args, { path: "C:/temp" }, "OpenAI w/tool: fragmented JSON args reassembled + parsed");
    assertEq(r.finishReason, "tool_calls", "OpenAI w/tool: finish_reason=tool_calls");
  }

  // Test 3: OpenAI parallel tool calls
  {
    const r = await runOpenAIChatRound({
      endpoint: `${baseUrl}/openai/parallel-tools`,
      headers: { "content-type": "application/json" },
      body: {},
      signal: new AbortController().signal,
      logger: noopLogger,
    });
    assertEq(r.toolCalls.length, 2, "OpenAI parallel: two tool calls");
    assertEq(r.toolCalls[0].name, "mcp__k-personal__cc_screen_size", "OpenAI parallel: index 0 = cc_screen_size");
    assertEq(r.toolCalls[1].name, "mcp__k-personal__clip_get", "OpenAI parallel: index 1 = clip_get");
    assertEq(r.toolCalls[0].args, {}, "OpenAI parallel: zero-arg call has empty args object");
  }

  // Test 4: Gemini text + functionCall in same chunk
  {
    const onTextChunks = [];
    const r = await runGeminiRound({
      endpoint: `${baseUrl}/gemini/with-tool`,
      headers: { "content-type": "application/json" },
      body: {},
      signal: new AbortController().signal,
      onDelta: { onText: (t) => onTextChunks.push(t) },
      logger: noopLogger,
    });
    assertEq(r.text, "지금 화면 크기를 확인할게요.", "Gemini: text accumulated");
    assertEq(onTextChunks.length, 1, "Gemini: text streamed via onText callback");
    assertEq(r.toolCalls.length, 1, "Gemini: one functionCall");
    assertEq(r.toolCalls[0].name, "mcp__k-personal__cc_screen_size", "Gemini: functionCall name");
    assertEq(r.toolCalls[0].args, {}, "Gemini: empty args");
    assertEq(r.finishReason, "STOP", "Gemini: finishReason=STOP");
    assert(r.toolCalls[0].id.startsWith("gem-"), "Gemini: synthesised id has gem- prefix");
  }

  // Test 5: message builders
  {
    const oaiAsst = buildOpenAIAssistantToolMessage("plan: list dir", [
      { id: "call_x", name: "mcp__k-personal__fm_list_directory", args: { path: "C:/" } },
    ]);
    assertEq(oaiAsst.role, "assistant", "builder: OpenAI assistant role");
    assertEq(oaiAsst.tool_calls[0].function.arguments, '{"path":"C:/"}', "builder: OpenAI args serialised as JSON string");

    const oaiTool = buildOpenAIToolResultMessage("call_x", "ok 5 entries");
    assertEq(oaiTool.role, "tool", "builder: OpenAI tool role");
    assertEq(oaiTool.tool_call_id, "call_x", "builder: OpenAI tool_call_id linkage");

    const gemModel = buildGeminiModelToolCallContent("planning", [
      { id: "gem-1", name: "mcp__k-personal__cc_screen_size", args: {} },
    ]);
    assertEq(gemModel.role, "model", "builder: Gemini model role");
    assertEq(gemModel.parts.length, 2, "builder: Gemini text + functionCall both in parts");

    const gemResp = buildGeminiToolResponseContent([{ name: "mcp__k-personal__cc_screen_size", output: "1920x1080" }]);
    assertEq(gemResp.role, "user", "builder: Gemini functionResponse goes in user role");
    assertEq(gemResp.parts[0].functionResponse.response.content, "1920x1080", "builder: Gemini response content wrapped");
  }

  // Test 6: namespacing helpers (regression — was wrong in early G1.2)
  {
    assertEq(namespacedToolName("fm_list_directory"), "mcp__k-personal__fm_list_directory", "namespace: prefix");
    assertEq(denamespaceToolName("mcp__k-personal__fm_list_directory"), "fm_list_directory", "namespace: round-trip");
    assertEq(denamespaceToolName("Bash"), null, "namespace: foreign tool returns null");
  }

  await stopMockServer();
}

// ─── Layer 2: live MCP dispatch (opt-in) ──────────────────────────────────
async function runLayer2() {
  const serverPath = process.env.K_PERSONAL_MCP_PATH ?? "C:/Users/user/Documents/K-Personal-MCP/server.py";
  if (!existsSync(serverPath)) {
    console.log(`\n[smoke-rest-tools] Layer 2 — SKIPPED (K-Personal not at ${serverPath})`);
    return;
  }
  console.log(`\n[smoke-rest-tools] Layer 2 — live MCP dispatch (server=${serverPath})`);

  const client = new MCPClient(
    "k-personal",
    process.env.PYTHON_EXE ?? "python",
    [serverPath],
    {},
    noopLogger,
  );

  try {
    const tools = await client.listTools();
    assert(tools.length >= 30, `Layer 2: tools/list returned ${tools.length} tools (>= 30)`);

    const oaiTools = toOpenAITools(tools);
    assertEq(oaiTools.length, tools.length, "Layer 2: translator preserves count when no disallow");

    const knownTools = new Set(oaiTools.map((t) => t.function.name));

    // Pick a safe read-only tool — cc_screen_size returns a string, no side effects.
    const target = namespacedToolName("cc_screen_size");
    assert(knownTools.has(target), "Layer 2: cc_screen_size present in catalog");

    const result = await dispatchModelToolCall({
      client,
      namespacedName: target,
      args: {},
      disallowed: new Set(),
      knownTools,
      callTimeoutMs: 10_000,
    });
    assert(result.ok, "Layer 2: dispatch returned ok");
    if (result.ok) {
      assert(typeof result.text === "string" && result.text.length > 0, `Layer 2: result has text (got: ${result.text?.slice(0, 80)})`);
      assert(!result.isError, "Layer 2: result not flagged isError");
      // cc_screen_size text typically contains digits (e.g. "1920x1080" or similar)
      assert(/\d/.test(result.text), "Layer 2: result text contains digits (likely a screen size)");
    }

    // Negative path: hallucinated tool name → ok:false with reason
    const bad = await dispatchModelToolCall({
      client,
      namespacedName: "mcp__k-personal__nonexistent_tool",
      args: {},
      disallowed: new Set(),
      knownTools,
      callTimeoutMs: 5_000,
    });
    assert(!bad.ok, "Layer 2: dispatch rejects unknown tool name");

    // Disallowed → also rejected before reaching MCP
    const blocked = await dispatchModelToolCall({
      client,
      namespacedName: target,
      args: {},
      disallowed: new Set([target]),
      knownTools,
      callTimeoutMs: 5_000,
    });
    assert(!blocked.ok, "Layer 2: dispatch rejects disallowed tool");
  } finally {
    client.stop();
  }
}

// ─── Run ───────────────────────────────────────────────────────────────────
try {
  await runLayer1();
  await runLayer2();
} catch (e) {
  console.log(`\n[smoke-rest-tools] harness error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(2);
}

if (failures.length === 0) {
  console.log(`\n[smoke-rest-tools] PASS`);
  setTimeout(() => process.exit(0), 100);
} else {
  console.log(`\n[smoke-rest-tools] FAIL (${failures.length} assertion${failures.length === 1 ? "" : "s"})`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
