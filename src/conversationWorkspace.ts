import type { ConversationControl, PendingSend, RunView } from "./conversationControl";
import type { FileAttachment } from "./types";

export const WORKSPACE_KEY = "kda_conversation_workspace_v1";
export const ACTIVE_CONVERSATION_KEY = "kda_active_conversation_v1";
export const TASK_PANEL_OPEN_KEY = "kda_task_panel_open_v1";
type Store = Pick<Storage, "getItem" | "setItem">;

export function saveWorkspace(control: ConversationControl, storage: Store): void {
  storage.setItem(WORKSPACE_KEY, JSON.stringify({
    version: 1, tracked: [...control.tracked], runs: [...control.runs.values()],
    // Blob URLs are process-local. Base64 and file paths are durable.
    queues: [...control.queues.values()].flat().map(q => ({ ...q, files: q.files?.map(f => ({ ...f, preview: undefined })) })),
  }));
}

export function restoreWorkspace(control: ConversationControl, storage: Store, validIds: Set<string>): void {
  let value;
  try { value = JSON.parse(storage.getItem(WORKSPACE_KEY) || "null"); } catch { return; }
  if (!value || value.version !== 1) return;
  if (Array.isArray(value.tracked)) for (const id of value.tracked) if (validIds.has(id)) control.tracked.add(id);
  if (Array.isArray(value.runs)) for (const run of value.runs as RunView[]) {
    if (!run || !validIds.has(run.conversationId) || typeof run.turnId !== "string" ||
        !Number.isFinite(run.startedAt) || !Number.isFinite(run.updatedAt) ||
        !["running", "stopping", "stopped", "completed", "failed", "interrupted"].includes(run.state)) continue;
    const state = run.state === "running" || run.state === "stopping" ? "interrupted" : run.state;
    control.runs.set(run.conversationId, { ...run, state,
      detail: run.state === "stopping" ? "정지 요청 뒤 재시작 · 재개 보류" : state === "interrupted" ? "재시작으로 중단 · 저장된 기록 확인 중" : state === "stopped" ? "정지됨 · 자동 재개 보류" : run.detail });
    control.tracked.add(run.conversationId);
    if (state === "stopped" || run.state === "stopping") control.pause(run.conversationId);
    // Restoring a status never claims a live process owner.
  }
  if (Array.isArray(value.queues)) for (const q of value.queues as PendingSend[]) {
    if (!q || !validIds.has(q.conversationId) || typeof q.id !== "string" || typeof q.text !== "string" ||
        !Number.isFinite(q.queuedAt) || !["queue", "steer"].includes(q.mode) || (q.files && !Array.isArray(q.files))) continue;
    control.enqueue(q);
    control.tracked.add(q.conversationId);
  }
}

export interface RecoveryTask {
  id: string; kind: string; conversation_id: string | null; status: string; manifest_json: string | null;
}

export function recoveryAttachments(task: RecoveryTask): FileAttachment[] {
  const manifest = JSON.parse(task.manifest_json || "null");
  if (!manifest?.attachments) return [];
  if (!Array.isArray(manifest.attachments)) throw Error("저장된 첨부 정보를 복원할 수 없습니다.");
  return manifest.attachments.map((file: FileAttachment, index: number) => {
    if (typeof file?.name !== "string" || typeof file.type !== "string" || typeof file.base64 !== "string" || !Number.isFinite(file.size)) {
      throw Error("원래 첨부 파일을 복원할 수 없어 자동 재개를 보류합니다.");
    }
    return { ...file, id: `recovery-${task.id}-${index}` };
  });
}

export function startupRecoveryCandidates<T extends RecoveryTask>(tasks: T[], control: ConversationControl, validIds: Set<string>): T[] {
  const seen = new Set<string>();
  return tasks.filter(task => {
    const id = task.conversation_id;
    if (!id || seen.has(id) || !validIds.has(id) || control.allPaused || control.paused.has(id) || task.status !== "running" || task.kind !== "conversation_turn") return false;
    const run = control.runs.get(id);
    if (run && (run.turnId !== task.id || run.state !== "interrupted")) return false;
    let manifest;
    try { manifest = JSON.parse(task.manifest_json || "null"); } catch { return false; }
    if (manifest?.recoveryVersion !== 1 || typeof manifest.request !== "string") return false;
    seen.add(id);
    return true;
  });
}
