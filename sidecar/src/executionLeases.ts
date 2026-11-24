interface Lease {
  keys: string[];
  allowParallelWorkspace: boolean;
}

interface Request extends Lease {
  id: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

export function workspaceLeaseKey(input: string): string {
  return "workspace:" + input.replace(/^\\\\\?\\/, "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}
function conflicts(a: string, b: string, bothAllowParallel: boolean): boolean {
  if (a === b) return !(bothAllowParallel && a.startsWith("workspace:"));
  return a.startsWith("workspace:") && b.startsWith("workspace:") && (a.startsWith(b + "/") || b.startsWith(a + "/"));
}
/** Shared workspace / engine sessions are leased until execution has really ended. */
export class ExecutionLeases {
  private active = new Map<string, Lease>();
  private waiting: Request[] = [];
  acquire(id: string, keys: string[], allowParallelWorkspace = false): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiting.push({ id, keys, allowParallelWorkspace, resolve, reject });
      this.pump();
    });
  }
  cancel(id: string): void {
    const waiting = this.waiting.filter((r) => r.id === id);
    this.waiting = this.waiting.filter((r) => r.id !== id);
    for (const request of waiting) request.reject(new Error("사용자가 대기 중인 작업을 정지했습니다."));
    this.pump();
  }
  isWaiting(id: string): boolean { return this.waiting.some((r) => r.id === id); }
  release(id: string): void { this.active.delete(id); this.pump(); }
  private pump(): void {
    const pending: Request[] = [];
    for (const request of this.waiting) {
      const occupied = [...this.active.values(), ...pending];
      const blocked = occupied.some((lease) => {
        const bothAllowParallel = request.allowParallelWorkspace && lease.allowParallelWorkspace;
        return request.keys.some((key) => lease.keys.some((held) => conflicts(key, held, bothAllowParallel)));
      });
      if (blocked) {
        pending.push(request);
        continue;
      }
      this.active.set(request.id, { keys: request.keys, allowParallelWorkspace: request.allowParallelWorkspace });
      request.resolve();
    }
    this.waiting = pending;
  }
}
