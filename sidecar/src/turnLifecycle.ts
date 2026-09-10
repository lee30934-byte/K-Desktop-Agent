/** Root execution ownership outlives terminal model events and cancellation requests. */
export class TurnLifecycle {
  private turns = new Map<string, { conversationId: string; stopping: boolean; terminal?: Record<string, unknown> }>();
  private owners = new Map<string, string>();
  private finished = new Set<string>();

  claim(id: string, conversationId: string): boolean {
    if (!id || !conversationId || this.turns.has(id) || this.finished.has(id) || this.owners.has(conversationId)) return false;
    this.turns.set(id, { conversationId, stopping: false });
    this.owners.set(conversationId, id);
    return true;
  }
  get(id: string) { return this.turns.get(id); }
  rootId(id: string): string { return id.split("#")[0]; }
  isStopping(id: string): boolean { return this.turns.get(this.rootId(id))?.stopping ?? false; }
  assertRunning(id: string): void {
    if (this.isStopping(id)) throw new Error("사용자가 작업을 정지했습니다.");
  }
  stop(id: string): boolean {
    const turn = this.turns.get(id);
    if (!turn) return false;
    turn.stopping = true;
    return true;
  }
  terminal(id: string, event: Record<string, unknown>): boolean {
    const turn = this.turns.get(id);
    if (!turn) return false;
    // An error remains an error even if a provider subsequently emits done.
    turn.terminal = turn.terminal?.type === "error" && event.type !== "error"
      ? { ...event, ...turn.terminal } : { ...turn.terminal, ...event };
    return true;
  }
  finish(id: string): Record<string, unknown> | undefined {
    const turn = this.turns.get(id);
    if (!turn) return;
    this.turns.delete(id);
    if (this.owners.get(turn.conversationId) === id) this.owners.delete(turn.conversationId);
    this.finished.add(id);
    if (this.finished.size > 512) this.finished.delete(this.finished.values().next().value!);
    return {
      ...turn.terminal, id, conversationId: turn.conversationId,
      type: turn.stopping ? "turn_stopped" : (turn.terminal?.type ?? "done"),
      outcome: turn.stopping ? "stopped" : turn.terminal?.type === "error" ? "failed" : "completed",
    };
  }
}
