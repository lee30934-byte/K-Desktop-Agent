import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { VoiceHandlers } from '../voiceControl';
import type { Conversation } from '../types';
import { mobileControl } from '../mobileControl';

/** No engine shortcut: remote commands enter the same handlers as the desktop avatar. */
export default function MobileDesktopBridge({ handlers, conversations }: { handlers: VoiceHandlers; conversations: Conversation[] }) {
  const current = useRef({ handlers, conversations }); current.current = { handlers, conversations };
  useEffect(() => {
    let cancelled = false, off: (() => void) | undefined;
    void listen<any>('sidecar-event', event => {
      const e = event.payload;
      if (cancelled || e.type !== 'mobile_request') return;
      void (async () => {
        try {
          if (!Number.isFinite(e.createdAt) || Date.now() - e.createdAt > 15_000 || e.createdAt > Date.now() + 2000) throw Error('만료된 요청입니다. 실행 상태를 확인하세요.');
          const claim = await mobileControl<{ valid: boolean }>('claim', { requestId: e.requestId });
          if (!claim.valid || cancelled) throw Error('연결 해제 또는 이미 접수된 요청입니다.');
          const { handlers: h, conversations: all } = current.current;
          const p = e.params; let result: unknown;
          if (e.method === 'conversations') result = all.map(c => ({ id: c.id, title: c.title, provider: c.provider, model: c.model }));
          else {
            if (e.method !== 'voice' || p.action === 'start') {
              if (!all.some(c => c.id === p.conversationId)) throw Error('대화가 없어졌습니다. 다시 선택하세요.');
            }
            if (e.method === 'status') result = await h.status(p.conversationId);
            else if (e.method === 'send') {
              if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > 12000 || !['queue', 'steer'].includes(p.mode)) throw Error('명령 내용 오류');
              if (h.canSend?.({ id: e.requestId, session: 'mobile', conversationId: p.conversationId, createdAt: e.createdAt, action: 'send' }) === false) throw Error('이후 정지된 요청입니다.');
              await h.send(p.conversationId, p.text, p.mode);
              result = { state: 'submitted', detail: 'PC에 전달했습니다. 실행 결과는 아래에서 확인하세요.' };
            } else if (e.method === 'stop') { await h.stop(p.conversationId); result = { state: 'stopped' }; }
            else if (e.method === 'voice') {
              await invoke('voice_control', p); result = { accepted: true };
            } else throw Error('지원하지 않는 명령');
          }
          await invoke('mobile_control', { action: 'reply', requestId: e.requestId, result });
        } catch (error) {
          await invoke('mobile_control', { action: 'reply', requestId: e.requestId, error: error instanceof Error ? error.message : 'PC 요청 처리 실패' }).catch(() => {});
        }
      })();
    }).then(unlisten => { if (cancelled) unlisten(); else off = unlisten; }).catch(() => {});
    return () => { cancelled = true; off?.(); };
  }, []);
  return null;
}
