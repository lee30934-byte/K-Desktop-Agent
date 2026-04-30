#!/usr/bin/env node
/**
 * Probe the K-Personal MCP server through our new MCPClient wrapper.
 *
 * Spawns the real Python server, runs initialize + tools/list, prints a summary, and
 * exits 0 on success / 1 on failure. Lets us verify G1.1 (the wrapper) before any
 * provider-side code is written. NOT a CI smoke — that's G1.5 (smoke-mcp-call.ps1).
 *
 * Usage:
 *   node sidecar/scripts/probe-mcp.mjs
 *   K_PERSONAL_MCP_PATH=C:/path/to/server.py node sidecar/scripts/probe-mcp.mjs
 *
 * Expects sidecar to be already built (`npm run build` in sidecar/).
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(__dirname, "..", "dist", "mcpClient.js");
if (!existsSync(distPath)) {
  console.error(`[probe-mcp] dist not built: ${distPath}`);
  console.error(`[probe-mcp] run \`npm run build\` in sidecar/ first.`);
  process.exit(2);
}

const { MCPClient } = await import(`file://${distPath.replace(/\\/g, "/")}`);

const serverPath =
  process.env.K_PERSONAL_MCP_PATH ??
  "C:/Users/user/Documents/K-Personal-MCP/server.py";
const python = process.env.PYTHON_EXE ?? "python";

if (!existsSync(serverPath)) {
  console.error(`[probe-mcp] K-Personal server not found: ${serverPath}`);
  console.error(`[probe-mcp] set K_PERSONAL_MCP_PATH if it lives elsewhere.`);
  process.exit(2);
}

const log = (level, msg) => console.error(`[probe-mcp] ${level}: ${msg}`);

const client = new MCPClient(
  "k-personal",
  python,
  [serverPath],
  {},
  log,
);

try {
  console.error(`[probe-mcp] starting subprocess (${python} ${serverPath})...`);
  const t0 = Date.now();
  await client.start();
  const handshakeMs = Date.now() - t0;
  const info = client.getServerInfo();
  console.error(`[probe-mcp] handshake OK in ${handshakeMs}ms — server=${info.name ?? "?"}@${info.version ?? "?"}`);

  const t1 = Date.now();
  const tools = await client.listTools();
  const listMs = Date.now() - t1;
  console.error(`[probe-mcp] tools/list OK in ${listMs}ms — ${tools.length} tools`);

  // Print a compact one-line summary of each tool (name + arg count).
  for (const t of tools) {
    const props = t.inputSchema?.properties ?? {};
    const required = Array.isArray(t.inputSchema?.required) ? t.inputSchema.required.length : 0;
    const total = Object.keys(props).length;
    console.log(`  ${t.name}  (args: ${required}/${total} required/total)`);
  }

  // Sanity threshold — K-Personal advertises ~42 tools today; require >= 30 so a future
  // intentional pruning still passes but a complete misconfiguration (0 tools) fails.
  if (tools.length < 30) {
    console.error(`[probe-mcp] FAIL: expected >= 30 tools, got ${tools.length}`);
    client.stop();
    process.exit(1);
  }

  // ─── G1.2: verify schema translator output for 3 representative tools ────
  const { toOpenAITools, toGeminiFunctionDeclarations, toAnthropicTools, namespacedToolName, denamespaceToolName } = await import(
    `file://${distPath.replace("mcpClient.js", "toolSchema.js").replace(/\\/g, "/")}`
  );

  // Pick representatives: zero-arg, simple-arg, multi-arg.
  const samples = ["cc_screenshot", "fm_list_directory", "cc_screenshot_region"]
    .map((n) => tools.find((t) => t.name === n))
    .filter(Boolean);
  if (samples.length !== 3) {
    console.error(`[probe-mcp] FAIL: missing sample tool(s) — got ${samples.map((t) => t.name).join(",")}`);
    process.exit(1);
  }

  const oai = toOpenAITools(samples);
  const gem = toGeminiFunctionDeclarations(samples);
  const ant = toAnthropicTools(samples);

  console.error(`\n[probe-mcp] ── translator output (representative samples) ──`);
  console.error(`[probe-mcp] OpenAI tools (${oai.length}):`);
  for (const t of oai) {
    const argList = t.function.parameters
      ? Object.keys(t.function.parameters.properties ?? {}).join(",") || "(none)"
      : "(omitted — zero args)";
    console.error(`  ${t.function.name}  args=[${argList}]`);
  }
  console.error(`[probe-mcp] Gemini functionDeclarations (${gem.length}):`);
  for (const t of gem) {
    const argList = t.parameters
      ? Object.keys(t.parameters.properties ?? {}).join(",") || "(none)"
      : "(omitted — zero args)";
    console.error(`  ${t.name}  args=[${argList}]`);
  }
  console.error(`[probe-mcp] Anthropic tools (${ant.length}):`);
  for (const t of ant) {
    console.error(`  ${t.name}  input_schema.type=${t.input_schema.type}`);
  }

  // Sanity assertions for G1.2.
  const assertions = [
    ["namespacing", oai[0].function.name === namespacedToolName("cc_screenshot")],
    ["denamespace round-trip", denamespaceToolName(namespacedToolName("fm_list_directory")) === "fm_list_directory"],
    ["zero-arg OpenAI omits parameters", !("parameters" in oai.find((t) => t.function.name.endsWith("cc_screenshot")).function)],
    ["zero-arg Gemini omits parameters", !("parameters" in gem.find((t) => t.name.endsWith("cc_screenshot")))],
    ["zero-arg Anthropic still has input_schema", "input_schema" in ant.find((t) => t.name.endsWith("cc_screenshot"))],
    ["Gemini stripped non-OpenAPI keys (additionalProperties absent)", !JSON.stringify(gem).includes("additionalProperties")],
    ["Gemini stripped non-OpenAPI keys ($schema absent)", !JSON.stringify(gem).includes("$schema")],
    ["disallowed filter works", toOpenAITools(samples, new Set([namespacedToolName("cc_screenshot")])).length === 2],
    // Regression: ensure Gemini preserves user-defined property names (early bug — sanitizer
    // was filtering map KEYS through the schema-keyword allow-list and stripping them).
    ["Gemini preserves fm_list_directory.properties.path", (() => {
      const t = gem.find((x) => x.name.endsWith("fm_list_directory"));
      return !!t?.parameters?.properties?.path;
    })()],
    ["Gemini preserves cc_screenshot_region.properties.x/y/width/height", (() => {
      const t = gem.find((x) => x.name.endsWith("cc_screenshot_region"));
      const p = t?.parameters?.properties ?? {};
      return ["x", "y", "width", "height"].every((k) => k in p);
    })()],
    ["OpenAI preserves fm_list_directory.properties.path", (() => {
      const t = oai.find((x) => x.function.name.endsWith("fm_list_directory"));
      return !!t?.function?.parameters?.properties?.path;
    })()],
  ];
  let translatorFailed = 0;
  for (const [name, pass] of assertions) {
    console.error(`  ${pass ? "✓" : "✗"} ${name}`);
    if (!pass) translatorFailed++;
  }
  if (translatorFailed > 0) {
    console.error(`[probe-mcp] FAIL: ${translatorFailed} translator assertion(s) failed`);
    client.stop();
    process.exit(1);
  }

  console.error(`\n[probe-mcp] PASS`);
  client.stop();
  // Give the subprocess a moment to die cleanly before we exit (avoids dangling pipe noise).
  setTimeout(() => process.exit(0), 200);
} catch (e) {
  console.error(`[probe-mcp] FAIL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  client.stop();
  process.exit(1);
}
