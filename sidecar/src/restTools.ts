/**
 * REST tool-calling helpers (Phase 11 G1.3 + G1.4).
 *
 * Provider-specific "one round" runners that:
 *   1. POST to the chat-completions / generateContent endpoint with tools attached
 *   2. Stream the SSE response, accumulating delta text + tool calls
 *   3. Return the accumulated state — the caller (index.ts handleViaRestAPI) is the
 *      multi-round driver that dispatches tools through MCP and feeds results back.
 *
 * Why split this out: the OpenAI and Gemini streaming protocols are noisy enough that
 * keeping their parsers next to handleViaRestAPI's orchestration code would balloon
 * index.ts past readability. The two runners share the same return shape so the loop
 * driver doesn't care which provider emitted them.
 *
 * Shape contract — every runner returns:
 *   text:        accumulated assistant text emitted in this round (may be empty if
 *                model only requested tools)
 *   toolCalls:   tool calls the model wants the loop driver to execute. id is whatever
 *                the provider generates (OpenAI: "call_xxx", Gemini: synthesised by us
 *                so the loop has a stable handle)
 *   finishReason: protocol-specific termination signal — "tool_calls" / "stop" / "length"
 *                 for OpenAI; "TOOL_CALL" / "STOP" / etc for Gemini. Loop driver uses it
 *                 to decide whether to spin another round.
 *   usage:       token counters reported by the provider. Loop sums across rounds.
 */

export interface AccumulatedToolCall {
  /** Stable id within this round; for OpenAI it's the provider's call_xxx, for Gemini we synthesise. */
  id: string;
  /** Provider-emitted function name. We DON'T strip the namespace prefix here — the loop driver does. */
  name: string;
  /** Parsed argument object. May be {} when model omitted args. */
  args: Record<string, unknown>;
}

export interface RoundResult {
  text: string;
  toolCalls: AccumulatedToolCall[];
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
}

export interface OnRoundDelta {
  /** Streamed text delta (caller forwards as assistant_delta event). */
  onText?: (delta: string) => void;
}

// ─── OpenAI / OpenRouter / Anthropic-via-OpenAI-shape (any chat-completions API) ───

/**
 * Run one round against an OpenAI-compatible chat-completions endpoint that streams SSE.
 * Handles tool_calls deltas: OpenAI sends them in fragments split by index; we accumulate
 * `id` + `function.name` (sent on the first delta of each call) plus `function.arguments`
 * (concatenated as a JSON string across many deltas, then JSON.parse'd at end).
 */
export async function runOpenAIChatRound(opts: {
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal;
  onDelta?: OnRoundDelta;
  logger: (level: "info" | "warn" | "error", msg: string) => void;
}): Promise<RoundResult> {
  const response = await fetch(opts.endpoint, {
    method: "POST",
    headers: opts.headers,
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${errText.slice(0, 800)}`);
  }
  if (!response.body) throw new Error("응답 body 가 비어있음 (스트리밍 미지원?)");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | null = null;

  // Per-index accumulator. OpenAI sends tool_calls deltas keyed by `index`, NOT id —
  // id only arrives on the first delta of each call. We key our map by index.
  interface ToolAcc {
    id: string;
    name: string;
    argsJSON: string;
  }
  const toolAccs = new Map<number, ToolAcc>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const eventBlock = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      // Concat multiline data: lines per spec.
      const dataLines: string[] = [];
      for (const line of eventBlock.split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (dataLines.length === 0) continue;
      const data = dataLines.join("\n").trim();
      if (!data || data === "[DONE]") continue;

      let parsed: any;
      try { parsed = JSON.parse(data); } catch {
        opts.logger("warn", `OpenAI SSE parse error: ${data.slice(0, 200)}`);
        continue;
      }

      // Two shapes: OpenAI (choices[0].delta) and Anthropic-as-fallback (we don't use
      // here — Anthropic gets its own runner if/when we add tool calls to that path).
      const choice = parsed?.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content && typeof delta.content === "string") {
        text += delta.content;
        opts.onDelta?.onText?.(delta.content);
      }
      const tcs = delta?.tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          let acc = toolAccs.get(idx);
          if (!acc) {
            acc = { id: "", name: "", argsJSON: "" };
            toolAccs.set(idx, acc);
          }
          if (typeof tc.id === "string" && tc.id) acc.id = tc.id;
          const fn = tc.function;
          if (fn) {
            if (typeof fn.name === "string" && fn.name) acc.name = fn.name;
            if (typeof fn.arguments === "string") acc.argsJSON += fn.arguments;
          }
        }
      }
      if (typeof choice?.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }

      const usage = parsed?.usage;
      if (usage) {
        if (typeof usage.prompt_tokens === "number") inputTokens = usage.prompt_tokens;
        if (typeof usage.completion_tokens === "number") outputTokens = usage.completion_tokens;
      }
    }
  }

  // Materialise tool calls in index order so the loop driver dispatches deterministically.
  const toolCalls: AccumulatedToolCall[] = Array.from(toolAccs.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([idx, acc]) => {
      let args: Record<string, unknown> = {};
      if (acc.argsJSON.trim()) {
        try {
          const parsed = JSON.parse(acc.argsJSON);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch (e) {
          opts.logger("warn", `OpenAI tool_call args JSON parse failed (index=${idx} name=${acc.name}): ${e instanceof Error ? e.message : String(e)} raw=${acc.argsJSON.slice(0, 200)}`);
        }
      }
      // Fallback id if provider somehow omitted it (shouldn't happen on real OpenAI but
      // some compatible endpoints are lax).
      const id = acc.id || `idx${idx}`;
      return { id, name: acc.name, args };
    })
    .filter((tc) => !!tc.name);

  return { text, toolCalls, finishReason, inputTokens, outputTokens };
}

// ─── Gemini (generateContent SSE) ──────────────────────────────────────────

/**
 * Run one round against Gemini's `:streamGenerateContent?alt=sse` endpoint.
 *
 * Gemini's streaming protocol is simpler than OpenAI's — each SSE chunk is a complete
 * GenerateContentResponse with a `candidates[0].content.parts` array. Parts can be
 * text or functionCall. Unlike OpenAI, function calls arrive complete (no fragment
 * accumulation needed) but multiple parts may share one chunk.
 */
export async function runGeminiRound(opts: {
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal;
  onDelta?: OnRoundDelta;
  logger: (level: "info" | "warn" | "error", msg: string) => void;
}): Promise<RoundResult> {
  const response = await fetch(opts.endpoint, {
    method: "POST",
    headers: opts.headers,
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${errText.slice(0, 800)}`);
  }
  if (!response.body) throw new Error("응답 body 가 비어있음 (스트리밍 미지원?)");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | null = null;
  const toolCalls: AccumulatedToolCall[] = [];
  let toolCallSeq = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const eventBlock = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      const dataLines: string[] = [];
      for (const line of eventBlock.split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (dataLines.length === 0) continue;
      const data = dataLines.join("\n").trim();
      if (!data) continue;

      let parsed: any;
      try { parsed = JSON.parse(data); } catch {
        opts.logger("warn", `Gemini SSE parse error: ${data.slice(0, 200)}`);
        continue;
      }

      const cand = parsed?.candidates?.[0];
      const parts = cand?.content?.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (typeof part?.text === "string" && part.text) {
            text += part.text;
            opts.onDelta?.onText?.(part.text);
          }
          if (part?.functionCall && typeof part.functionCall === "object") {
            const fc = part.functionCall as { name?: unknown; args?: unknown };
            const name = typeof fc.name === "string" ? fc.name : "";
            const args = (fc.args && typeof fc.args === "object" && !Array.isArray(fc.args))
              ? (fc.args as Record<string, unknown>)
              : {};
            if (name) {
              // Gemini doesn't give us a call id; we synthesise one so the loop driver
              // and `tool_use`/`tool_result` events have a stable handle.
              toolCalls.push({ id: `gem-${++toolCallSeq}`, name, args });
            }
          }
        }
      }
      if (typeof cand?.finishReason === "string") finishReason = cand.finishReason;

      const usage = parsed?.usageMetadata;
      if (usage) {
        if (typeof usage.promptTokenCount === "number") inputTokens = usage.promptTokenCount;
        if (typeof usage.candidatesTokenCount === "number") outputTokens = usage.candidatesTokenCount;
      }
    }
  }

  return { text, toolCalls, finishReason, inputTokens, outputTokens };
}

// ─── Provider-side message builders for the next round ─────────────────────
//
// After a round emits tool calls and we execute them, we must add (a) the assistant
// message that contained the tool calls, and (b) one tool/function result message per
// call to the conversation history before the next round. The shapes differ enough
// per provider that we expose two builder helpers.

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export function buildOpenAIAssistantToolMessage(text: string, toolCalls: AccumulatedToolCall[]): OpenAIMessage {
  return {
    role: "assistant",
    // OpenAI requires content to be either a string or null; explicit null when only tool_calls.
    content: text || null,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        // arguments must be a JSON string (not an object) per OpenAI spec.
        arguments: JSON.stringify(tc.args ?? {}),
      },
    })),
  };
}

export function buildOpenAIToolResultMessage(toolCallId: string, output: string): OpenAIMessage {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: output,
  };
}

// ─── Gemini message builders ───────────────────────────────────────────────

export interface GeminiContent {
  role: "user" | "model";
  parts: Array<
    | { text: string }
    | { functionCall: { name: string; args: Record<string, unknown> } }
    | { functionResponse: { name: string; response: { content?: string; result?: unknown } } }
  >;
}

export function buildGeminiModelToolCallContent(text: string, toolCalls: AccumulatedToolCall[]): GeminiContent {
  const parts: GeminiContent["parts"] = [];
  if (text) parts.push({ text });
  for (const tc of toolCalls) {
    parts.push({ functionCall: { name: tc.name, args: tc.args } });
  }
  return { role: "model", parts };
}

export function buildGeminiToolResponseContent(toolCalls: Array<{ name: string; output: string }>): GeminiContent {
  return {
    role: "user",
    parts: toolCalls.map((tc) => ({
      functionResponse: {
        name: tc.name,
        response: { content: tc.output },
      },
    })),
  };
}
