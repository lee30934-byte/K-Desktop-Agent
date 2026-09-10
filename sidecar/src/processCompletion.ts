import type { ChildProcess } from "node:child_process";

/** Register immediately after spawn. Awaiting after stdout parsing must not miss close. */
export function observeProcessClose(proc: ChildProcess): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    let error: Error | undefined;
    proc.once("error", (failure) => { error = failure; });
    proc.once("close", (code) => resolve({ code, error }));
  });
}
