export interface DotRequest {
  id: string; session: string; conversationId: string;
  action: "status" | "send" | "stop"; createdAt: number;
  text?: string; mode?: "steer" | "queue";
}
export interface DotHandlers {
  canSend?(request: DotRequest): boolean;
  status(id: string): Promise<unknown>;
  send(id: string, text: string, mode: "steer" | "queue"): Promise<void>;
  stop(id: string): Promise<void>;
}
/** Request receipt is distinct from execution completion. Status never waits on mutations. */
export class DotDispatcher {
  private stoppedAt = 0;
  private serial: Promise<unknown> = Promise.resolve();
  private stopBarrier: Promise<unknown> = Promise.resolve();
  private seen = new Set<string>();
  constructor(private handlers: DotHandlers, private valid: (r: DotRequest) => Promise<boolean>) {}
  dispatch(r: DotRequest): Promise<unknown> {
    if (this.seen.has(r.id)) return Promise.resolve({ state: "unknown", detail: "Already claimed; inspect status. Do not repeat." });
    this.seen.add(r.id);
    if (r.action === "stop") this.stoppedAt = Math.max(this.stoppedAt, r.createdAt);
    const run = async () => {
      if (!await this.valid(r)) throw new Error("DOT connection revoked or changed");
      if (!Number.isFinite(r.createdAt) || Date.now() - r.createdAt > 15_000 || r.createdAt > Date.now() + 2000) throw new Error("DOT request expired; inspect state without repeating work");
      if (r.action === "status") return this.handlers.status(r.conversationId);
      if (r.action === "send") {
        if (r.createdAt <= this.stoppedAt) return { state: "cancelled", detail: "A newer stop cancelled this request." };
        if (this.handlers.canSend?.(r) === false) return { state: "cancelled", detail: "A newer manual stop cancelled this request." };
        await this.handlers.send(r.conversationId, r.text!, r.mode!);
        return { state: "submitted", detail: "KDA send handler returned. Inspect status for running/queued/failed; work is not confirmed complete." };
      }
      await this.handlers.stop(r.conversationId);
      return { state: "stopped", detail: "KDA turn stop confirmed; detached background processes require separate verification." };
    };
    if (r.action === "status") return run();
    if (r.action === "stop") {
      // A preparing send may be waiting on the engine. The App stop path owns
      // cancellation of preparing/running turns; never queue stop behind send.
      const work = run();
      this.stopBarrier = work;
      void work.catch(() => {});
      return work;
    }
    const work = this.serial.then(async () => { await this.stopBarrier; return run(); });
    this.serial = work.catch(() => {});
    return work;
  }
}
