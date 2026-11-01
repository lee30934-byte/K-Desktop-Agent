/**
 * v0.7.53 — 텔레그램 브리지 견고화 (2026-10-29 장애 대응).
 *
 * 배경(실측): 2026-10-27 08:51 텔레그램 메시지가 `resume_session_missing` 으로 2초 만에 실패했고,
 * 세션 id 만 클리어된 채 원 메시지는 재처리되지 않아 요청이 유실됐다. 같은 점검에서 다음 약점도 확인:
 *   (1) 세션 유실 시 메시지 버림           → 새 세션으로 1회 자동 재시도
 *   (2) done/error 가 안 오면 영구 "처리 중" → 무이벤트 STALE_MS 경과 시 잠금 강제 해제
 *   (3) 처리 중 도착 메시지 버림           → 최대 QUEUE_MAX 개 대기열
 *   (4) 회신 실패가 콘솔에만 남음          → 1회 재시도 + ~/.kda/telegram-bridge.log 기록(Rust)
 *
 * 이 파일은 React/Tauri 에 의존하지 않는 순수 로직만 담는다(scripts/telegram-bridge.test.ts 로 검증).
 */

/** 마지막 sidecar 이벤트 이후 이 시간 동안 아무 이벤트도 없으면 멈춘 turn 으로 본다.
 *  sidecar 는 살아 있는 turn 에 30초마다 turn_heartbeat 를 보내므로, 정상 장기 작업은 걸리지 않는다. */
export const TELEGRAM_TURN_STALE_MS = 20 * 60 * 1000;
/** 처리 중 도착 메시지 대기열 상한. 넘치면 거절 안내(무한 적체 방지). */
export const TELEGRAM_QUEUE_MAX = 8; // v0.7.54 — 대화별 동시 처리로 대기열이 대화 수만큼 필요
/** 텔레그램 단일 메시지 4096자 제한 — 헤드룸 두고 4000자. */
export const TELEGRAM_CHUNK = 4000;

export interface TelegramTurnEntry {
  chatId: string;
  /** assistant_delta 누적 텍스트 (회신 본문). */
  text: string;
  /** K 가 보낸 원문 — 재시도 시 다시 보낸다. */
  userText: string;
  /** 이 turn 이 속한 대화 id — stale 해제 시 대화 잠금 해제용. */
  convId: string;
  startedAt: number;
  lastActivityAt: number;
  /** 새 세션 재시도를 이미 한 번 했는지 (무한 재시도 방지). */
  retried: boolean;
}

export interface QueuedTelegramMessage {
  text: string;
  chatId: string;
  receivedAt: number;
  /** v0.7.54 — 분배된 대상 대화 (없으면 📱 텔레그램 대화). */
  convId?: string;
}

export interface StaleTelegramTurn extends TelegramTurnEntry {
  turnId: string;
}

/**
 * 진행 중 텔레그램 turn + 대기열. 기존 `Map<string,{chatId,text}>` 자리를 그대로 대체하도록
 * get/set/delete/size 를 같은 의미로 제공한다.
 */
export class TelegramTurnTracker {
  private readonly turns = new Map<string, TelegramTurnEntry>();
  private readonly queue: QueuedTelegramMessage[] = [];

  constructor(
    private readonly staleMs: number = TELEGRAM_TURN_STALE_MS,
    private readonly queueMax: number = TELEGRAM_QUEUE_MAX,
  ) {}

  get size(): number {
    return this.turns.size;
  }
  get(turnId: string | undefined): TelegramTurnEntry | undefined {
    return turnId ? this.turns.get(turnId) : undefined;
  }
  set(turnId: string, entry: TelegramTurnEntry): void {
    this.turns.set(turnId, entry);
  }
  delete(turnId: string | undefined): boolean {
    return turnId ? this.turns.delete(turnId) : false;
  }

  /** v0.7.54 — 대화별 동시성: 이 대화에서 진행 중인 텔레그램 턴이 있는지. */
  hasConv(convId: string): boolean {
    for (const t of this.turns.values()) if (t.convId === convId) return true;
    return false;
  }
  /** 진행 중 턴 목록 (진행 메시지 틱용). */
  entries(): Array<[string, TelegramTurnEntry]> {
    return [...this.turns.entries()];
  }
  /** 대기열에서 지금 시작 가능한(대화가 비어 있는) 첫 메시지를 꺼낸다. 순서는 대화별로 보존. */
  dequeueReady(isBusy: (convId: string | undefined) => boolean): QueuedTelegramMessage | undefined {
    const blocked = new Set<string>();
    for (let i = 0; i < this.queue.length; i++) {
      const key = this.queue[i].convId ?? "";
      if (blocked.has(key)) continue;
      if (!isBusy(this.queue[i].convId)) return this.queue.splice(i, 1)[0];
      blocked.add(key); // 같은 대화의 뒤 메시지가 앞지르지 않게
    }
    return undefined;
  }

  /**
   * v0.7.70 — 대기열 꺼내기. 텔레그램 턴뿐 아니라 데스크톱·후속 턴이 잡은 대화(isClaimed)도 바쁜 것으로 본다.
   * 텔레그램 턴만 보면 맨 앞 메시지가 claim 실패 → 맨 앞 복귀를 반복해, 뒤에 있는 다른 대화 메시지가
   * 영영 시작되지 않는다(2026-11-01 실사용: CAE GUI 가 바쁜 동안 음악공유방 #2·#4 정체).
   */
  dequeueStartable(isClaimed: (convId: string) => boolean, defaultConv: string): QueuedTelegramMessage | undefined {
    return this.dequeueReady((c) => {
      const conv = c || defaultConv;
      return this.hasConv(conv) || isClaimed(conv);
    });
  }

  /** 해당 turn 의 이벤트를 받았음을 기록 (heartbeat 포함). */
  touch(turnId: string | undefined, now: number): void {
    const t = turnId ? this.turns.get(turnId) : undefined;
    if (t) t.lastActivityAt = now;
  }

  /** 무이벤트 staleMs 초과 turn 을 꺼내 제거하고 반환한다. */
  reapStale(now: number): StaleTelegramTurn[] {
    const out: StaleTelegramTurn[] = [];
    for (const [turnId, t] of this.turns) {
      if (now - t.lastActivityAt >= this.staleMs) out.push({ ...t, turnId });
    }
    for (const s of out) this.turns.delete(s.turnId);
    return out;
  }

  /** 대기열 추가. 넘치면 accepted=false. position 은 1부터. */
  enqueue(msg: QueuedTelegramMessage): { accepted: boolean; position: number } {
    if (this.queue.length >= this.queueMax) return { accepted: false, position: this.queue.length };
    this.queue.push(msg);
    return { accepted: true, position: this.queue.length };
  }
  /** 꺼냈는데 다시 막힌 메시지를 맨 앞에 되돌린다 (순서 보존, 상한 무시 — 원래 들어 있던 항목이므로). */
  requeueFront(msg: QueuedTelegramMessage): void {
    this.queue.unshift(msg);
  }
  dequeue(): QueuedTelegramMessage | undefined {
    return this.queue.shift();
  }
  get queueLength(): number {
    return this.queue.length;
  }
}

/** sidecar error 이벤트가 "새 세션으로 1회 재시도" 대상인지. */
export function shouldRetryWithFreshSession(
  entry: Pick<TelegramTurnEntry, "retried"> | undefined,
  errorCode: unknown,
): boolean {
  return !!entry && !entry.retried && errorCode === "resume_session_missing";
}

/**
 * 재시도 turn 의 history 정리 — 원 메시지는 첫 시도 때 이미 DB 에 저장돼 history 끝에 들어 있다.
 * send_message 의 message 로 다시 보내므로 history 끝의 같은 user 메시지는 뺀다(중복 방지).
 */
export function stripTrailingUserEcho<T extends { role: string; content: string }>(history: T[], text: string): T[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user") {
      if (m.content === text) return [...history.slice(0, i), ...history.slice(i + 1)];
      return history;
    }
  }
  return history;
}

/** [PC이름] 라벨 + 빈 응답 처리 + 4000자 분할. */
export function buildTelegramReplyChunks(text: string, pcName: string, chunk: number = TELEGRAM_CHUNK): string[] {
  const label = pcName.trim() ? `[${pcName.trim()}] ` : "";
  const body = label + (text && text.trim().length > 0 ? text : "(빈 응답)");
  const parts: string[] = [];
  for (let i = 0; i < body.length; i += chunk) parts.push(body.slice(i, i + chunk));
  return parts;
}

export interface RetryResult {
  ok: boolean;
  attempts: number;
  error?: string;
}

/** 실패 시 delayMs 후 재시도 (총 attempts 회). 예외는 삼키고 결과로 돌려준다. */
export async function sendWithRetry(
  send: () => Promise<unknown>,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RetryResult> {
  const attempts = Math.max(1, opts.attempts ?? 2);
  const delayMs = opts.delayMs ?? 2000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      await send();
      return { ok: true, attempts: i };
    } catch (e) {
      lastErr = String(e);
      if (i < attempts) await sleep(delayMs);
    }
  }
  return { ok: false, attempts, error: lastErr };
}
