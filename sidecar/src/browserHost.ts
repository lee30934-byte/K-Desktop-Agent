import { randomUUID } from "node:crypto";

export type BrowserAction = "open" | "status" | "send" | "stop" | "close" | "show" | "hide" | "diagnostics";
export type BrowserStatus = { phase?: string; text?: string; error?: string | null; authenticated?: boolean | null; authState?: "unverified"; site?: string; composer?: boolean; temporary?: boolean; cleanupConfirmed?: boolean; visible?: boolean | null };
export type BrowserDiagnostics = {
  events: Array<{ atMs: number; window: string; event: string; site: string | null; destination: null | { scheme: string; knownHost: string; policyReason: string } }>;
  windows: Array<{ window: string; site: string | null; visible: boolean | null }>;
};
type BrowserReply = BrowserStatus | BrowserDiagnostics;
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
function validReply(action: BrowserAction, value: unknown): value is BrowserReply {
  if (!object(value)) return false;
  if (action === "diagnostics") {
    return Array.isArray(value.events) && value.events.length <= 256 && value.events.every(e => object(e) &&
      typeof e.atMs === "number" && Number.isFinite(e.atMs) && typeof e.window === "string" && typeof e.event === "string" &&
      (e.site === null || typeof e.site === "string") && (e.destination === null || (object(e.destination) &&
        [e.destination.scheme, e.destination.knownHost, e.destination.policyReason].every(v => typeof v === "string")))) &&
      Array.isArray(value.windows) && value.windows.every(w => object(w) && typeof w.window === "string" &&
        (w.site === null || typeof w.site === "string") && (w.visible === null || typeof w.visible === "boolean"));
  }
  if (action === "hide" || action === "show") return typeof value.visible === "boolean";
  if (!['login-required', 'ready', 'submitting', 'streaming', 'stopping', 'completed', 'cancelled', 'failed', 'closed'].includes(String(value.phase))) return false;
  for (const key of ['composer', 'temporary', 'cleanupConfirmed']) if (key in value && typeof value[key] !== 'boolean') return false;
  if ('authenticated' in value && value.authenticated !== null && typeof value.authenticated !== 'boolean') return false;
  if ('authState' in value && value.authState !== 'unverified') return false;
  if ('text' in value && typeof value.text !== 'string') return false;
  if ('error' in value && value.error !== null && typeof value.error !== 'string') return false;
  return true;
}
type Pending = {
  owner: string;
  action: BrowserAction;
  resolve: (status: BrowserReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Private sidecar stdout/stdin transport. No TCP listener, Codex config, or credentials. */
export class BrowserHostClient {
  private readonly pending = new Map<string, Pending>();
  private disposed = false;
  constructor(private readonly write: (message: Record<string, unknown>) => void, private readonly timeoutMs = 30_000) {}

  request(owner: string, action: "diagnostics"): Promise<BrowserDiagnostics>;
  request(owner: string, action: Exclude<BrowserAction, "diagnostics">, prompt?: string): Promise<BrowserStatus>;
  request(owner: string, action: BrowserAction, prompt?: string): Promise<BrowserReply> {
    if (this.disposed) return Promise.reject(new Error("browser-control-disconnected"));
    if (!/^[A-Za-z0-9_:-]{1,128}$/.test(owner)) return Promise.reject(new Error("invalid-browser-owner"));
    if (this.pending.size >= 64) return Promise.reject(new Error("browser-control-backpressure"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("browser-control-timeout-no-retry"));
      }, this.timeoutMs);
      this.pending.set(requestId, { owner, action, resolve, reject, timer });
      try {
        this.write({ type: "browser_host_request", request: { requestId, owner, action, prompt: prompt ?? null } });
      } catch {
        clearTimeout(timer); this.pending.delete(requestId); reject(new Error("browser-control-write-failed"));
      }
    });
  }

  receive(message: unknown): boolean {
    if (!message || typeof message !== "object") return false;
    const reply = message as Record<string, unknown>;
    if (reply.type !== "browser_host_reply") return false;
    if (typeof reply.requestId !== "string") return true;
    const pending = this.pending.get(reply.requestId);
    if (!pending || pending.owner !== reply.owner) return true;
    clearTimeout(pending.timer); this.pending.delete(reply.requestId);
    if (typeof reply.error === "string") pending.reject(new Error(reply.error));
    else if (validReply(pending.action, reply.status)) pending.resolve(reply.status);
    else pending.reject(new Error("invalid-browser-reply"));
    return true;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer); entry.reject(new Error("browser-control-disconnected"));
    }
    this.pending.clear();
  }
}
