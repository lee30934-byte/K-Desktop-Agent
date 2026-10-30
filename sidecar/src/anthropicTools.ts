import type { RoundResult, OnRoundDelta } from './restTools.js';

export interface AnthropicMessage { role: 'user' | 'assistant'; content: string | Record<string, unknown>[] }
export async function runAnthropicRound(opts: {
  endpoint: string; headers: Record<string, string>; body: Record<string, unknown>;
  signal: AbortSignal; onDelta?: OnRoundDelta;
}): Promise<RoundResult & { content: Record<string, unknown>[] }> {
  // Keep complete content blocks (including signed thinking blocks) for the next turn.
  const response = await fetch(opts.endpoint, {
    method: 'POST', headers: opts.headers,
    body: JSON.stringify({ ...opts.body, stream: false }), signal: opts.signal,
  });
  if (!response.ok) throw new Error(`Anthropic HTTP ${response.status}`);
  const result = await response.json() as any;
  if (!Array.isArray(result.content)) throw new Error('Anthropic content missing');
  const text = result.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  const calls = result.content.filter((b: any) => b.type === 'tool_use');
  if (calls.length && result.stop_reason !== 'tool_use') throw new Error('Incomplete Anthropic tool response');
  for (const b of calls) {
    if (!b.id || !b.name || !b.input || typeof b.input !== 'object' || Array.isArray(b.input)) {
      throw new Error('Invalid Anthropic tool call');
    }
  }
  opts.onDelta?.onText?.(text);
  return {
    text, content: result.content,
    toolCalls: calls.map((b: any) => ({ id: b.id, name: b.name, args: b.input })),
    finishReason: result.stop_reason ?? null,
    inputTokens: (result.usage?.input_tokens ?? 0) + (result.usage?.cache_read_input_tokens ?? 0) + (result.usage?.cache_creation_input_tokens ?? 0),
    outputTokens: result.usage?.output_tokens ?? 0,
  };
}
