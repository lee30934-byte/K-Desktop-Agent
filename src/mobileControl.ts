import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface MobileState { enabled: boolean; port: number; origin: string; pairingCode: string; pairingExpires: number; clients: number }
export async function mobileControl<T = MobileState>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let off: (() => void) | undefined, settled = false;
    const timer = setTimeout(() => { settled = true; off?.(); reject(Error('휴대폰 연결 응답 시간 초과')); }, 8000);
    void listen<any>('sidecar-event', event => {
      if (event.payload.type !== 'mobile_control_result' || event.payload.id !== id) return;
      if (settled) return; settled = true;
      clearTimeout(timer); off?.();
      if (event.payload.error) reject(Error(event.payload.error)); else resolve(event.payload.result);
    }).then(unlisten => {
      off = unlisten;
      if (settled) { off(); return; }
      void invoke('mobile_control', { action, id, ...params }).catch(error => { clearTimeout(timer); off?.(); reject(error); });
    }).catch(error => { clearTimeout(timer); reject(error); });
  });
}
