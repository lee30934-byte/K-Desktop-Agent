import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { VoiceEvent, VoiceTransport } from './voiceSession';

export const voiceTransport: VoiceTransport = {
  listen: handler => listen<VoiceEvent & { type: string }>('sidecar-event', e => {
    if (e.payload.type === 'voice_event') handler(e.payload);
  }),
  start: (sessionId, conversationId, sdp, options) => invoke('voice_control', { action: 'start', sessionId, conversationId, sdp, ...options }),
  stop: sessionId => invoke('voice_control', { action: 'stop', sessionId }),
  reply: (sessionId, token, result) => invoke('voice_control', { action: 'reply', sessionId, token, result }),
  speak: (sessionId, text) => invoke('voice_control', { action: 'speak', sessionId, text }),
  extend: (sessionId, token) => invoke('voice_control', { action: 'extend', sessionId, token }),
};

export async function listVoiceChoices(signal?: AbortSignal): Promise<string[]> {
  const sessionId = crypto.randomUUID();
  if (signal?.aborted) throw Error('음성 목록 조회 취소');
  return new Promise((resolve, reject) => {
    let off: (() => void) | undefined, settled = false;
    const finish = (error?: unknown, voices?: string[]) => {
      if (settled) return;
      settled = true; clearTimeout(timer); off?.(); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(voices!);
    };
    const abort = () => finish(Error('음성 목록 조회 취소'));
    const timer = setTimeout(() => finish(Error('음성 목록 조회 시간이 초과됐습니다. 다시 불러오세요.')), 35_000);
    signal?.addEventListener('abort', abort, { once: true });
    void voiceTransport.listen(event => {
      if (event.sessionId !== sessionId || event.kind !== 'voices') return;
      if (event.message) { finish(Error(event.message)); return; }
      const voices = event.voices;
      if (!Array.isArray(voices) || !voices.length || voices.some(v => typeof v !== 'string' || !/^[a-z]{2,24}$/.test(v)))
        finish(Error('사용 가능한 음성 목록을 확인하지 못했습니다.'));
      else finish(undefined, [...new Set(voices)]);
    }).then(unlisten => {
      off = unlisten;
      if (settled) { off(); return; }
      void invoke('voice_control', { action: 'list', sessionId }).catch(finish);
    }).catch(finish);
  });
}
