/** Durable at-most-once guard for Telegram updates.
 * A persisted `processing` row from a prior app instance is uncertain and must
 * never dispatch again automatically. The caller reports it and asks the user
 * to resend after checking the target conversation.
 */
export type TelegramUpdateState = "processing" | "completed" | "uncertain";

export interface TelegramUpdateRecord {
  updateId: number;
  state: TelegramUpdateState;
  chatId: string;
  text: string;
  updatedAt: number;
  noticeSent?: boolean;
}

export type TelegramUpdateClaim = "new" | "completed" | "inflight" | "uncertain";

const MAX_RECORDS = 256;

export class TelegramUpdateLedger {
  private records = new Map<number, TelegramUpdateRecord>();
  private active = new Set<number>();
  blocked = false;

  static fromStorage(read: () => string | null): TelegramUpdateLedger {
    try {
      const raw = read();
      const rows = raw === null ? [] : JSON.parse(raw);
      if (!Array.isArray(rows)) throw new Error("invalid_telegram_ledger");
      return new TelegramUpdateLedger(rows);
    } catch {
      const ledger = new TelegramUpdateLedger([]);
      ledger.blocked = true;
      return ledger;
    }
  }

  constructor(rows: unknown, private readonly maxRecords = MAX_RECORDS) {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || !Number.isSafeInteger(row.updateId) || row.updateId < 0 ||
          !["processing", "completed", "uncertain"].includes(row.state) ||
          typeof row.chatId !== "string" || typeof row.text !== "string" ||
          !Number.isFinite(row.updatedAt)) continue;
      const r = row as TelegramUpdateRecord;
      this.records.set(r.updateId, r.state === "processing"
        ? { ...r, state: "uncertain", noticeSent: false } : { ...r });
    }
    this.trim();
  }

  claim(record: Omit<TelegramUpdateRecord, "state" | "noticeSent">): TelegramUpdateClaim {
    if (this.blocked) throw new Error("telegram_ledger_unavailable");
    if (!Number.isSafeInteger(record.updateId) || record.updateId < 0) throw new Error("invalid_telegram_update_id");
    const old = this.records.get(record.updateId);
    if (old?.state === "completed") return "completed";
    if (old?.state === "uncertain") return "uncertain";
    if (old?.state === "processing") {
      if (this.active.has(record.updateId)) return "inflight";
      // A prior app instance stopped after durable claim. Do not risk replay.
      old.state = "uncertain";
      old.updatedAt = record.updatedAt;
      old.noticeSent = false;
      return "uncertain";
    }
    this.trim(this.maxRecords - 1);
    if (this.records.size >= this.maxRecords) throw new Error("telegram_ledger_full_unresolved");
    this.records.set(record.updateId, { ...record, state: "processing" });
    this.active.add(record.updateId);
    this.trim();
    return "new";
  }

  cancelUnpersistedClaim(updateId: number): void {
    const row = this.records.get(updateId);
    if (row?.state === "processing" && this.active.has(updateId)) this.records.delete(updateId);
    this.active.delete(updateId);
  }

  complete(updateId: number, now: number): void {
    const row = this.records.get(updateId);
    if (!row) return;
    row.state = "completed";
    row.updatedAt = now;
    delete row.noticeSent;
    this.active.delete(updateId);
    this.trim();
  }

  markUncertain(updateId: number, now: number): void {
    const row = this.records.get(updateId);
    if (!row) return;
    row.state = "uncertain";
    row.updatedAt = now;
    row.noticeSent = false;
    this.active.delete(updateId);
  }

  markNoticeSent(updateId: number): void {
    const row = this.records.get(updateId);
    if (row?.state === "uncertain") row.noticeSent = true;
  }

  needsNotice(updateId: number): boolean {
    const row = this.records.get(updateId);
    return row?.state === "uncertain" && !row.noticeSent;
  }

  toJSON(): TelegramUpdateRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  get uncertainCount(): number {
    let count = 0;
    for (const row of this.records.values()) if (row.state === "uncertain") count++;
    return count;
  }

  get processingCount(): number {
    let count = 0;
    for (const row of this.records.values()) if (row.state === "processing") count++;
    return count;
  }

  private trim(limit = this.maxRecords): void {
    while (this.records.size > limit) {
      const first = [...this.records.keys()].find((id) => this.records.get(id)?.state === "completed" && !this.active.has(id));
      if (first === undefined) break;
      this.records.delete(first);
    }
  }
}

export interface ProcessTelegramUpdateArgs {
  ledger: TelegramUpdateLedger;
  updateId: number;
  chatId: string;
  text: string;
  now: number;
  persist(): void;
  dispatch(): Promise<void>;
  notifyUncertain(): Promise<boolean>;
  acknowledge(): void;
  onDispatchError?(error: unknown): void;
}

/** Process one update with durable claim-before-dispatch and ack-after-state.
 * Failures after claim are treated as uncertain and are never auto-dispatched
 * again. `acknowledge` advances Telegram's offset only after a durable state.
 */
export async function processTelegramUpdate(args: ProcessTelegramUpdateArgs): Promise<TelegramUpdateClaim> {
  const { ledger, updateId, chatId, text, now } = args;
  const claim = ledger.claim({ updateId, chatId, text: text.slice(0, 500), updatedAt: now });
  if (claim === "inflight") return claim;
  if (claim === "completed") {
    args.persist();
    args.acknowledge();
    return claim;
  }
  if (claim === "uncertain") {
    args.persist();
    if (ledger.needsNotice(updateId)) {
      if (!await args.notifyUncertain()) throw new Error(`telegram_uncertain_notice_failed:${updateId}`);
      ledger.markNoticeSent(updateId);
      args.persist();
    }
    args.acknowledge();
    return claim;
  }

  try {
    // If durable claim cannot be saved, cancel it and do not execute.
    args.persist();
  } catch (e) {
    ledger.cancelUnpersistedClaim(updateId);
    throw e;
  }

  try {
    await args.dispatch();
  } catch (e) {
    args.onDispatchError?.(e);
    ledger.markUncertain(updateId, now);
    args.persist();
    if (!await args.notifyUncertain()) throw new Error(`telegram_uncertain_notice_failed:${updateId}`);
    ledger.markNoticeSent(updateId);
    args.persist();
    args.acknowledge();
    return "uncertain";
  }

  ledger.complete(updateId, now);
  try { args.persist(); }
  catch (e) {
    // Completion may have happened remotely. Retain the uncertainty in memory;
    // the durable processing claim also becomes uncertain after a restart.
    ledger.markUncertain(updateId, now);
    throw e;
  }
  args.acknowledge();
  return "new";
}
