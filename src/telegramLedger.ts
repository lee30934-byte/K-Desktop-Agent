/**
 * v0.7.69 — 텔레그램 명령 장부 (커맨드센터 2단계) + /현황 표시 (3단계). React/Tauri 무의존.
 *
 * 텔레그램에서 받은 명령 1건 = 장부 1줄(#번호). 한 명령이 여러 방으로 나뉘면 방마다 상태를 따로 둔다.
 * 상태는 그 방이 실제로 회신한 내용으로만 바뀐다(추측 금지):
 *   sent(전달) → running(시작됨) → decision(결정 대기) / done(완료) / error(오류)
 * 회신이 오면 그 방이 들어 있는 가장 최근 명령 줄을 갱신한다. 48시간 지난 줄은 정리한다.
 */
import type { DigestTier } from "./telegramDigest";

export type LegState = "sent" | "running" | "decision" | "done" | "error";

export interface LedgerLeg {
  convId: string;
  label: string;
  state: LegState;
  at: number;
  /** 마지막 회신 앞부분 (한 줄) */
  note?: string;
}

export interface LedgerEntry {
  id: number;
  at: number;
  chatId: string;
  text: string;
  legs: LedgerLeg[];
}

export const LEDGER_KEEP_MS = 48 * 60 * 60 * 1000;
export const LEDGER_MAX = 40;

const STATE_ICON: Record<LegState, string> = {
  sent: "📨 전달",
  running: "⏳ 진행",
  decision: "❓ 결정 대기",
  done: "✅ 완료",
  error: "⚠ 오류",
};

export function tierToState(tier: DigestTier): LegState {
  return tier === "decision" ? "decision" : tier === "error" ? "error" : tier === "progress" ? "running" : "done";
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

export class CommandLedger {
  private entries: LedgerEntry[] = [];
  private nextId = 1;

  open(chatId: string, text: string, targets: Array<{ convId: string; label: string }>, now: number): LedgerEntry {
    const seen = new Set<string>();
    const legs: LedgerLeg[] = [];
    for (const t of targets) {
      if (seen.has(t.convId)) continue;
      seen.add(t.convId);
      legs.push({ convId: t.convId, label: t.label, state: "sent", at: now });
    }
    const e: LedgerEntry = { id: this.nextId++, at: now, chatId, text: oneLine(text, 80), legs };
    this.entries.push(e);
    this.prune(now);
    return e;
  }

  /** 특정 명령의 특정 방 상태 지정 (턴 시작 성공/실패 등). */
  mark(id: number, convId: string, state: LegState, now: number, note?: string): void {
    const leg = this.entries.find((e) => e.id === id)?.legs.find((l) => l.convId === convId);
    if (!leg) return;
    leg.state = state;
    leg.at = now;
    if (note !== undefined) leg.note = oneLine(note, 70);
  }

  /** 방에서 회신이 왔을 때: 그 방이 들어 있는 가장 최근 명령 줄을 갱신. 없으면 false. */
  report(convId: string, state: LegState, now: number, text?: string): LedgerEntry | undefined {
    this.prune(now);
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const leg = this.entries[i].legs.find((l) => l.convId === convId);
      if (leg) {
        leg.state = state;
        leg.at = now;
        if (text !== undefined) leg.note = oneLine(text, 70);
        return this.entries[i];
      }
    }
    return undefined;
  }

  recent(now: number, n = 8): LedgerEntry[] {
    this.prune(now);
    return this.entries.slice(-n);
  }

  get size(): number {
    return this.entries.length;
  }

  private prune(now: number): void {
    this.entries = this.entries.filter((e) => now - e.at <= LEDGER_KEEP_MS).slice(-LEDGER_MAX);
  }

  toJSON(): { nextId: number; entries: LedgerEntry[] } {
    return { nextId: this.nextId, entries: this.entries };
  }

  static fromJSON(raw: unknown, now: number): CommandLedger {
    const l = new CommandLedger();
    const o = raw as { nextId?: unknown; entries?: unknown } | null;
    if (o && Array.isArray(o.entries)) {
      for (const e of o.entries as LedgerEntry[]) {
        if (!e || typeof e.id !== "number" || typeof e.at !== "number" || !Array.isArray(e.legs)) continue;
        const legs = e.legs.filter((x) => x && typeof x.convId === "string" && typeof x.label === "string" && x.state in STATE_ICON);
        if (legs.length) l.entries.push({ id: e.id, at: e.at, chatId: String(e.chatId ?? ""), text: String(e.text ?? ""), legs });
      }
      const maxId = l.entries.reduce((m, e) => Math.max(m, e.id), 0);
      l.nextId = Math.max(typeof o.nextId === "number" ? o.nextId : 1, maxId + 1);
    }
    l.prune(now);
    return l;
  }
}

/** /현황 메시지 본문. */
export function formatBoard(entries: LedgerEntry[], now: number): string {
  if (entries.length === 0) return "📋 현황 — 최근 48시간 동안 텔레그램으로 보낸 명령이 없어요.";
  const time = (t: number) => new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  const ago = (t: number) => {
    const m = Math.max(0, Math.round((now - t) / 60000));
    return m < 60 ? `${m}분 전` : `${Math.round(m / 60)}시간 전`;
  };
  const lines = ["📋 현황 (최근 명령, 위가 오래된 것)"];
  for (const e of entries) {
    lines.push("", `#${e.id} ${time(e.at)} "${e.text}"`);
    for (const l of e.legs) lines.push(`- [${l.label}] ${STATE_ICON[l.state]} · ${ago(l.at)}${l.note ? ` — ${l.note}` : ""}`);
  }
  const waiting = entries.flatMap((e) => e.legs).filter((l) => l.state === "decision").length;
  if (waiting) lines.push("", `❓ 결정 대기 ${waiting}건 — 해당 방 메시지에 답장하거나 버튼을 눌러 주세요.`);
  return lines.join("\n");
}

/** v0.7.69 — 텔레그램 방이 다른 방으로 넘긴 지시(task-watch 마커 id 접두어). ~/.kda/remote/cc-dispatch.ps1 이 만든다. */
export const CC_DISPATCH_PREFIX = "cc-dispatch-";
export function isCommandCenterDispatch(watchId: string | undefined | null): boolean {
  return typeof watchId === "string" && watchId.startsWith(CC_DISPATCH_PREFIX);
}
