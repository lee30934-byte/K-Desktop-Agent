import { automaticResponse, approvalDetail, type ApprovalRequest, type ApprovalReply } from './approvalAutomation.mjs';
import type { TelegramHub } from './telegramHub';

/** One owner per RPC. A resolved/expired/stopped RPC must never be accepted. */
export class RemoteApprovalDispatcher {
  private pending = new Map<string, { cancelled: boolean; cancel: () => void }>();

  startConfirmation(req: { id: string; token: string; convId: string; detail: string }, chatId: string,
      hub: TelegramHub, live: () => boolean, respond: (confirmed: boolean) => Promise<void>, failed: () => void): boolean {
    if (!live()) return false;
    const key = `${req.id}:${req.token}`;
    if (this.pending.has(key)) return true;
    const remote = hub.requestApproval({ convId: req.convId, chatId, detail: req.detail, timeoutMs: 30000 });
    const entry = { cancelled: false, cancel: () => hub.cancelApproval(remote.token, false) };
    this.pending.set(key, entry);
    void remote.result.then(async confirmed => {
      if (!entry.cancelled) await respond(confirmed && live());
    }).catch(failed).finally(() => this.pending.delete(key));
    return true;
  }

  start(request: ApprovalRequest, chatId: string, hub: TelegramHub,
      live: () => boolean, respond: (reply: ApprovalReply) => Promise<void>, failed: () => void): boolean {
    if (!live() || Date.now() >= request.expiresAt) return false;
    const key = `${request.id}:${request.token}`;
    if (this.pending.has(key)) return true;
    const auto = automaticResponse(request);
    const remote = auto
      ? hub.requestApproval({ convId: request.conversation_id, chatId,
          timeoutMs: request.expiresAt - Date.now(),
          detail: request.type === 'codex_elicitation_request' ? `${request.serverName}: ${request.message}` : approvalDetail(request) })
      : request.type === 'codex_elicitation_request'
        ? hub.requestInput({ convId: request.conversation_id, chatId, detail: request.message, schema: request.schema,
            timeoutMs: request.expiresAt - Date.now() }) : null;
    if (!remote) return false;
    const entry = { cancelled: false, cancel: () => hub.cancelApproval(remote.token, false) };
    this.pending.set(key, entry);
    void remote.result.then(async value => {
      if (entry.cancelled) return;
      const valid = live() && Date.now() < request.expiresAt;
      const reply: ApprovalReply = typeof value === 'boolean'
        ? { action: value && valid ? 'accept' : 'decline', content: value && valid ? auto?.content ?? null : null }
        : { action: value && valid ? 'accept' : 'decline', content: value && valid ? value : null };
      await respond(reply);
    }).catch(failed).finally(() => this.pending.delete(key));
    return true;
  }

  resolvedTurn(id: string): void {
    for (const key of [...this.pending.keys()]) if (key.startsWith(`${id}:`)) this.resolved(id, key.slice(id.length + 1));
  }

  resolved(id: string, token: string): void {
    const entry = this.pending.get(`${id}:${token}`);
    if (!entry) return;
    entry.cancelled = true;
    entry.cancel();
    this.pending.delete(`${id}:${token}`);
  }
}
