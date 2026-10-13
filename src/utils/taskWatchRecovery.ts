import type { ConversationControl } from "../conversationControl";

export interface WatchDelivery {
  state: string;
  reason?: string;
  attempts?: number;
  nextAttemptAt?: number;
  turnId?: string;
  conversationId?: string;
  result?: { text: string; savedAt: number };
}
export interface ReadyWatch {
  id: string; file?: string; conversationId?: string | null;
  title: string; prompt: string; status: string; note: string;
  delivery?: WatchDelivery;
}

export interface WaitingWatch { id: string; title: string; reason: string; conversationId?: string | null }

export function waitingWatchKey(watch: WaitingWatch): string {
  return `${watch.id}:${watch.reason}`;
}

export function visibleWaitingWatches(watches: WaitingWatch[], activeConversationId: string | null, dismissed: ReadonlySet<string>): WaitingWatch[] {
  if (!activeConversationId) return [];
  return watches.filter((watch) => watch.conversationId === activeConversationId && !dismissed.has(waitingWatchKey(watch)));
}

/** Hold the owner until the retry decision is durable. IPC failures are never retry permission. */
export async function settleWatchFailure(
  control: ConversationControl, conversationId: string, turnId: string,
  release: () => Promise<WatchDelivery>,
): Promise<WatchDelivery> {
  try {
    const decision = await release();
    control.finish(conversationId, turnId, "failed", decision.state === "retry_wait" || decision.state === "result_ready");
    return decision;
  } catch (error) {
    control.finish(conversationId, turnId, "failed");
    throw error;
  }
}

export function watchBlockReason(watch: ReadyWatch, control: ConversationControl, conversationId: string): string | undefined {
  if (watch.delivery?.state === "result_ready") return undefined; // local persistence only; never starts a model
  return control.autoRunBlockReason(conversationId)
    ?? (watch.status === "held" ? watch.delivery?.reason ?? "delivery-held" : undefined)
    ?? (watch.delivery?.state === "retry_wait" && (watch.delivery.nextAttemptAt ?? 0) > Date.now() ? "retry-backoff" : undefined);
}

export function watchRecoveryPrompt(watch: ReadyWatch): string {
  return `\n[KDA 작업 복구 확인]\n현재 관측: ${watch.note}\n` +
    "완료 파일의 내용·결과 경로와 관련 프로세스의 현재 상태를 먼저 확인하세요. 이 알림은 결과 확인 요청이며 작업 재실행 승인이 아닙니다. 이미 완료되거나 실행 중인 작업을 중복 시작하지 마세요. 타임아웃은 완료 증거가 아닙니다. 기존 사용자 정지·승인 조건을 유지하세요.\n";
}

/** A staged final result survives a crash between completion and database/ACK writes. */
export async function persistWatchResult(
  watch: ReadyWatch,
  save: (conversationId: string, turnId: string, text: string, at: number) => Promise<void>,
  ack: (file: string, turnId: string) => Promise<void>,
): Promise<boolean> {
  const d = watch.delivery;
  if (d?.state !== "result_ready") return false;
  if (!d.result?.text.trim() || !d.turnId || !d.conversationId || (watch.conversationId && watch.conversationId !== d.conversationId)) throw new Error("저장된 결과의 대화/실행 정보가 일치하지 않습니다");
  await save(d.conversationId, d.turnId, d.result.text, d.result.savedAt);
  await ack(watch.file || watch.id, d.turnId);
  return true;
}

export function watchBlockLabel(reason: string): string {
  return ({
    "all-paused": "전체 자동 실행 정지", "user-paused": "사용자 정지", "legacy-paused": "기존 정지 상태 · 사용자 확인 필요",
    "failure-paused": "이전 오류 확인 필요", "conversation-running": "대화 작업 진행 중", stopping: "정지 확인 중",
    "retry-backoff": "일시 오류 · 재시도 대기", "retry-exhausted": "자동 재시도 5회 소진 · 사용자 확인 필요",
    "requires-user": "오류 또는 승인 확인 필요", "interrupted-delivery-review": "이전 전달이 중단됨 · 실행 결과 확인 필요",
    "producer-still-running": "관련 프로세스 실행 중", "watch-condition-missing": "완료 조건 재확인 필요",
  } as Record<string, string>)[reason] ?? "결과 확인 보류";
}
