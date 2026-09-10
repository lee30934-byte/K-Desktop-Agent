// A message's conversation is immutable, including during an upsert.
export const MESSAGE_UPSERT_SQL = `INSERT INTO messages
  (id, conversation_id, role, content, timestamp, streaming, level,
   tool_id, tool_name, tool_input, tool_output, tool_status, tool_risk)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    role=excluded.role, content=excluded.content, timestamp=excluded.timestamp,
    streaming=excluded.streaming, level=excluded.level, tool_id=excluded.tool_id,
    tool_name=excluded.tool_name, tool_input=excluded.tool_input,
    tool_output=excluded.tool_output, tool_status=excluded.tool_status, tool_risk=excluded.tool_risk
  WHERE messages.conversation_id=excluded.conversation_id`;

/** Serialize writes per conversation; unrelated conversations can still save concurrently. */
export class ConversationMessageWriter<T> {
  private tails = new Map<string, Promise<void>>();
  constructor(private save: (conversationId: string, message: T) => Promise<void>) {}
  write(conversationId: string, message: T): Promise<void> {
    const previous = this.tails.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.save(conversationId, message));
    this.tails.set(conversationId, next);
    return next;
  }
  async drain(conversationId: string): Promise<void> { await this.tails.get(conversationId); }
}
