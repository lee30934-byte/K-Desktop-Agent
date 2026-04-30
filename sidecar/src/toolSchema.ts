/**
 * MCP → provider tool-schema translator (Phase 11 G1.2).
 *
 * Pure functional code: takes MCPTool[] and produces tool/function schemas in the shapes
 * OpenAI / Gemini / Anthropic expect. Also handles the inverse mapping (model-emitted
 * tool name → MCP tool name) and dispatches calls back through MCPClient.
 *
 * Why namespaced names ("mcp__k-personal__fm_list_directory" vs raw "fm_list_directory"):
 *   The Claude CLI path already uses the namespaced form, and our existing permission
 *   policy (PERM_TOOL_MAP, lockedTools, ALWAYS_BLOCKED_BYPASS in index.ts) keys on it.
 *   Reusing the namespaced form means K's existing per-tool locks apply to every provider
 *   without a parallel permission table. The cost is ~20 extra tokens per tool name in
 *   the system prompt — well worth the consistency.
 *
 * Provider-specific quirks intentionally handled:
 *   - Gemini rejects JSON Schema keys outside OpenAPI 3.0 (additionalProperties, $schema,
 *     $ref, oneOf at top-level). We strip them.
 *   - Both OpenAI and Gemini misbehave on `parameters: {type:"object", properties:{}}`
 *     for zero-arg tools. We omit the parameters field entirely in that case.
 *   - Tool names with `__` are valid for OpenAI (max 64 chars) and Anthropic, but Gemini
 *     restricts function names to `[A-Za-z0-9_-]{1,63}`. Our prefixed names fit comfortably
 *     under 63 chars (mcp__k-personal__ = 17 chars + tool name ≤ 30 chars).
 */

import type { MCPClient, MCPCallResult, MCPContent, MCPTool } from "./mcpClient.js";

/** Stable prefix attached to every K-Personal tool name we expose to non-Claude providers. */
export const MCP_NAMESPACE = "mcp__k-personal__";

// ─── Provider tool-schema shapes ───────────────────────────────────────────

export interface OpenAIToolSchema {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface AnthropicToolSchema {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Build the namespaced tool name shown to providers.
 *
 * Example: "fm_list_directory" → "mcp__k-personal__fm_list_directory"
 */
export function namespacedToolName(rawName: string): string {
  return MCP_NAMESPACE + rawName;
}

/**
 * Reverse the namespacing. Returns null if the name doesn't carry our prefix
 * (so the caller can detect "model invented a tool we never advertised").
 */
export function denamespaceToolName(namespaced: string): string | null {
  if (!namespaced.startsWith(MCP_NAMESPACE)) return null;
  return namespaced.slice(MCP_NAMESPACE.length);
}

/**
 * Convert MCP tools to OpenAI Chat Completions `tools` array (also accepted by
 * OpenRouter and any OpenAI-compatible endpoint).
 *
 * @param tools Raw tools from MCPClient.listTools()
 * @param disallowed Namespaced tool names to omit from the output (permission policy).
 */
export function toOpenAITools(tools: MCPTool[], disallowed: Set<string> = new Set()): OpenAIToolSchema[] {
  const out: OpenAIToolSchema[] = [];
  for (const t of tools) {
    const name = namespacedToolName(t.name);
    if (disallowed.has(name)) continue;
    const params = sanitizeForJsonSchema(t.inputSchema);
    const fn: OpenAIToolSchema["function"] = {
      name,
      ...(t.description ? { description: truncateDescription(t.description) } : {}),
    };
    if (params) fn.parameters = params;
    out.push({ type: "function", function: fn });
  }
  return out;
}

/**
 * Convert MCP tools to Gemini `tools[].functionDeclarations`. Gemini's parameter schema
 * accepts a strict OpenAPI 3.0 subset, so we sanitize harder than OpenAI's path.
 */
export function toGeminiFunctionDeclarations(
  tools: MCPTool[],
  disallowed: Set<string> = new Set(),
): GeminiFunctionDeclaration[] {
  const out: GeminiFunctionDeclaration[] = [];
  for (const t of tools) {
    const name = namespacedToolName(t.name);
    if (disallowed.has(name)) continue;
    const params = sanitizeForGemini(t.inputSchema);
    const decl: GeminiFunctionDeclaration = { name };
    if (t.description) decl.description = truncateDescription(t.description);
    if (params) decl.parameters = params;
    out.push(decl);
  }
  return out;
}

/**
 * Convert MCP tools to Anthropic Messages API `tools` array. Provided for symmetry —
 * REST-mode Anthropic (api_key, no Max OAuth) currently doesn't go through MCP, but a
 * future caller (e.g. Claude fallback for sub-agent isolation) will need this.
 */
export function toAnthropicTools(tools: MCPTool[], disallowed: Set<string> = new Set()): AnthropicToolSchema[] {
  const out: AnthropicToolSchema[] = [];
  for (const t of tools) {
    const name = namespacedToolName(t.name);
    if (disallowed.has(name)) continue;
    const params = sanitizeForJsonSchema(t.inputSchema) ?? { type: "object", properties: {} };
    out.push({
      name,
      ...(t.description ? { description: truncateDescription(t.description) } : {}),
      input_schema: params,
    });
  }
  return out;
}

/**
 * Dispatch a model-emitted tool call back through MCP. Handles the namespacing reversal,
 * permission re-check (defence in depth — model might call a tool we filtered, especially
 * after history rewinds), and content-block flattening for the LLM tool-result message.
 *
 * Returns:
 *   { ok: true, text: "...", isError } — text-flattened result ready to feed back.
 *   { ok: false, reason: "..." } — call rejected (unknown tool, blocked, etc).
 *
 * The `text` is what the LLM sees in the next turn. Image content blocks are summarised
 * inline ("[image: 25KB png]") for now — providers' multimodal tool-result formats
 * differ enough that piping raw images is a separate piece of work (G3 in the original
 * gap list).
 */
export async function dispatchModelToolCall(opts: {
  client: MCPClient;
  namespacedName: string;
  args: Record<string, unknown>;
  disallowed: Set<string>;
  knownTools: Set<string>; // namespaced names that survived filtering
  callTimeoutMs?: number;
}): Promise<{ ok: true; text: string; isError: boolean } | { ok: false; reason: string }> {
  const raw = denamespaceToolName(opts.namespacedName);
  if (!raw) {
    return { ok: false, reason: `Tool name "${opts.namespacedName}" is not in the K-Personal namespace.` };
  }
  if (opts.disallowed.has(opts.namespacedName)) {
    return { ok: false, reason: `Tool "${opts.namespacedName}" is blocked by current permission policy.` };
  }
  if (!opts.knownTools.has(opts.namespacedName)) {
    return { ok: false, reason: `Tool "${opts.namespacedName}" is not exposed in this turn (unknown to MCP server or filtered).` };
  }

  let result: MCPCallResult;
  try {
    result = await opts.client.callTool(raw, opts.args, opts.callTimeoutMs);
  } catch (e) {
    return {
      ok: true,
      text: `[MCP error] ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  }
  return { ok: true, text: flattenContent(result.content), isError: result.isError === true };
}

// ─── Internals ─────────────────────────────────────────────────────────────

/** Truncate descriptions so a 45-tool catalog doesn't blow the model's prompt budget. */
function truncateDescription(d: string, maxLen = 400): string {
  const trimmed = d.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1) + "…";
}

/**
 * Sanitize a JSON Schema for an OpenAI / Anthropic tool. OpenAI's strict mode is more
 * picky but their non-strict mode (which we use) accepts most JSON Schema. We only:
 *   - return undefined if schema has no properties (or isn't object) — both providers
 *     misbehave on `{type:"object", properties:{}}` with no `additionalProperties:false`
 *   - strip `$schema` (irrelevant here, only adds tokens)
 */
function sanitizeForJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const s = schema as Record<string, unknown>;
  const props = s.properties;
  const hasProps = props && typeof props === "object" && Object.keys(props as object).length > 0;
  if (!hasProps) return undefined;

  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "$schema") continue;
    cleaned[k] = v;
  }
  if (!cleaned.type) cleaned.type = "object";
  return cleaned;
}

/**
 * Strict sanitizer for Gemini. Recursively removes JSON Schema keys that aren't part of
 * Google's OpenAPI 3.0 subset, and rejects the schema entirely (returns undefined) when
 * properties is empty so we just send a no-parameters function declaration.
 *
 * Allowed keys per Gemini docs (as of 2025):
 *   type, format, description, nullable, enum, properties, required, items,
 *   anyOf  (Gemini accepts anyOf for unions but not oneOf/allOf)
 *   propertyOrdering  (Gemini-specific, optional)
 */
const GEMINI_ALLOWED_KEYS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "properties",
  "required",
  "items",
  "anyOf",
  "propertyOrdering",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "default",
]);

function sanitizeForGemini(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const s = schema as Record<string, unknown>;
  const props = s.properties;
  const hasProps = props && typeof props === "object" && Object.keys(props as object).length > 0;
  if (!hasProps) return undefined;

  return geminiSanitizeNode(s) as Record<string, unknown>;
}

function geminiSanitizeNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => geminiSanitizeNode(item));
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (!GEMINI_ALLOWED_KEYS.has(k)) continue;

      // `properties` is a map of arbitrary user-defined property names → sub-schemas.
      // The map's KEYS must NOT be filtered against the schema allow-list (they're not
      // schema keywords). Recurse into each value as a schema.
      if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
        const propsOut: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries(v as Record<string, unknown>)) {
          propsOut[propName] = geminiSanitizeNode(propSchema);
        }
        out[k] = propsOut;
        continue;
      }

      // Gemini wants `type` upper-case ("STRING", "OBJECT", "ARRAY") — but as of v1beta
      // it actually accepts lower-case too, so we pass through whatever MCP gave us.
      out[k] = geminiSanitizeNode(v);
    }
    // Ensure object types always declare type (required by Gemini even when properties is set).
    if (out.properties && !out.type) out.type = "object";
    return out;
  }
  return node;
}

/**
 * Flatten an MCP content array (text + image blocks) into a single string for the
 * provider's tool-result message. Image blocks become a short marker (we don't pipe
 * binaries through the text channel — that's the dedicated G3 multimodal work).
 *
 * Caps the total at 4 KB to match the existing summarizeToolItem cap in index.ts; the
 * model rarely benefits from longer raw outputs and large blobs poison resume history.
 */
function flattenContent(content: MCPContent[]): string {
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === "text" && typeof (c as { text?: unknown }).text === "string") {
      parts.push((c as { text: string }).text);
    } else if (c.type === "image") {
      const data = (c as { data?: string }).data ?? "";
      const mime = (c as { mimeType?: string }).mimeType ?? "image/?";
      const approxBytes = Math.floor((data.length * 3) / 4);
      parts.push(`[image: ${mime} ~${approxBytes}B (binary omitted)]`);
    } else {
      // Unknown content type — JSON-stringify defensively.
      try { parts.push(`[${c.type}: ${JSON.stringify(c)}]`); } catch { parts.push(`[${c.type}: unserializable]`); }
    }
  }
  const joined = parts.join("\n").trim();
  if (joined.length <= 4000) return joined;
  return joined.slice(0, 4000) + "…(truncated)";
}
