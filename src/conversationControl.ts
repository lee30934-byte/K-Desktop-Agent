import { ConversationTurnGate } from "./conversationTurnGate";
import type { FileAttachment } from "./types";

export type SendMode = "steer" | "queue";
export interface PendingSend {
  id: string;
  conversationId: string;
  text: string;
  files?: FileAttachment[];
  queuedAt: number;
  mode: SendMode;
}
export interface RunView {
  conversationId: string;
  turnId: string;
  state: "running" | "stopping" | "stopped" | "completed" | "failed";
  startedAt: number;
  updatedAt: number;
  detail: string;
}

/** All queue / pause decisions use the originating conversation, never the visible tab. */
export class ConversationControl extends ConversationTurnGate {
  readonly runs = new Map<string, RunView>();
  readonly queues = new Map<string, PendingSend[]>();
  readonly paused = new Set<string>();
  allPaused = false;

  override claim(conversationId: string, turnId: string): boolean {
    if (!super.claim(conversationId, turnId)) return false;
    this.runs.set(conversationId, { conversationId, turnId, state: "running", startedAt: Date.now(), updatedAt: Date.now(), detail: "작업 시작" });
    return true;
  }
  owner(conversationId: string): string | undefined {
    return this.isActive(conversationId) ? this.runs.get(conversationId)?.turnId : undefined;
  }
  accepts(conversationId: string, turnId: string): boolean { return this.owner(conversationId) === turnId; }
  touch(conversationId: string, turnId: string, detail: string): void {
    const run = this.runs.get(conversationId);
    if (!run || !this.accepts(conversationId, turnId) || run.state === "stopping") return;
    this.runs.set(conversationId, { ...run, detail, updatedAt: Date.now() });
  }
  stopping(conversationId: string): string | undefined {
    const id = this.owner(conversationId);
    const run = this.runs.get(conversationId);
    if (id && run) this.runs.set(conversationId, { ...run, state: "stopping", detail: "실제 종료를 확인하고 있습니다", updatedAt: Date.now() });
    return id;
  }
  finish(conversationId: string, turnId: string, state: "stopped" | "completed" | "failed"): boolean {
    if (!super.release(conversationId, turnId)) return false;
    const run = this.runs.get(conversationId)!;
    this.runs.set(conversationId, { ...run, state, detail: state === "stopped" ? "정지 확인됨" : state === "failed" ? "작업 실패 · 확인 필요" : "작업 완료", updatedAt: Date.now() });
    if (state === "failed") this.paused.add(conversationId);
    return true;
  }
  override release(conversationId: string, turnId: string): boolean { return this.finish(conversationId, turnId, "completed"); }
  enqueue(item: PendingSend): void {
    const queue = this.queues.get(item.conversationId) ?? [];
    if (!queue.some((q) => q.id === item.id)) this.queues.set(item.conversationId, [...queue, item]);
  }
  peek(conversationId: string): PendingSend | undefined { return this.queues.get(conversationId)?.[0]; }
  remove(conversationId: string, id: string): void {
    const next = this.queues.get(conversationId)?.filter((q) => q.id !== id) ?? [];
    if (next.length) this.queues.set(conversationId, next); else this.queues.delete(conversationId);
  }
  canAutoRun(conversationId: string): boolean { return !this.allPaused && !this.paused.has(conversationId) && !this.isActive(conversationId); }
  pause(conversationId: string): void { this.paused.add(conversationId); }
  resume(conversationId: string): void { this.paused.delete(conversationId); }
}

export function buildSteeringMessage(text: string): string {
  return `[작업 중 추가 지시]\n기존 작업은 정지 확인 후 이어받았습니다. 이전 목표와 완료한 결과를 유지하며 아래 지시를 반영하세요. 이미 실행한 도구의 결과와 분리된 백그라운드 작업 상태를 먼저 확인해 중복 실행을 피하세요. 질문이면 먼저 답하고 기존 작업을 이어가고, 방향 변경이면 적용할 변경을 짧게 알린 뒤 진행하세요.\n\n${text}`;
}
