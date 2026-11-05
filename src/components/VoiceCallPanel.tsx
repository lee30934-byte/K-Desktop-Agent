import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { VoiceSession, type VoiceEvent, type VoiceTransport, type VoiceView } from '../voiceSession';
import type { VoiceHandlers } from '../voiceControl';
import './VoiceCallPanel.css';

const transport: VoiceTransport = {
  listen: handler => listen<VoiceEvent & { type: string }>('sidecar-event', e => {
    if (e.payload.type === 'voice_event') handler(e.payload);
  }),
  start: (sessionId, conversationId, sdp) => invoke('voice_control', { action: 'start', sessionId, conversationId, sdp }),
  stop: sessionId => invoke('voice_control', { action: 'stop', sessionId }),
  reply: (sessionId, token, result) => invoke('voice_control', { action: 'reply', sessionId, token, result }),
  speak: (sessionId, text) => invoke('voice_control', { action: 'speak', sessionId, text }),
};

export default function VoiceCallPanel({ conversationId, title, handlers, onClose }: {
  conversationId: string; title: string; handlers: VoiceHandlers; onClose(): void;
}) {
  const ref = useRef<VoiceSession>();
  const handlersRef = useRef(handlers); handlersRef.current = handlers;
  const target = useRef({ conversationId, title });
  const [view, setView] = useState<VoiceView>({ phase: 'idle', message: '', muted: false, speaking: false, conversationId, lines: [] });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const busy = view.phase === 'connected' || view.phase === 'connecting';
  function start() {
    ref.current?.end();
    const bound: VoiceHandlers = {
      status: id => handlersRef.current.status(id),
      send: (id, text, mode) => handlersRef.current.send(id, text, mode),
      stop: id => handlersRef.current.stop(id),
      stopAll: () => { const fn = handlersRef.current.stopAll; return fn ? fn() : Promise.reject(Error('전체 정지 사용 불가')); },
      canSend: r => handlersRef.current.canSend?.(r) !== false,
    };
    const session = new VoiceSession(target.current.conversationId, bound, transport, setView);
    ref.current = session;
    void session.start(input, output).then(async () => {
      try { setDevices(await navigator.mediaDevices.enumerateDevices()); } catch { /* Default devices still work. */ }
    });
  }
  useEffect(() => {
    start();
    const unload = () => ref.current?.end();
    window.addEventListener('pagehide', unload);
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('pagehide', unload); window.removeEventListener('beforeunload', unload); ref.current?.end(); };
    // A conversation change never restarts/retargets the call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <section className="voice-call" aria-label="AI 비서 음성통화">
    <div className="voice-call-title"><strong>AI 비서 음성통화</strong><button type="button" aria-label="음성통화 닫기" onClick={() => { ref.current?.end(); onClose(); }}>×</button></div>
    <small>대상: {target.current.title || target.current.conversationId}</small>
    <p role={view.phase === 'error' ? 'alert' : 'status'}>{view.message || '음성 연결 준비 중…'}</p>
    <small>Codex 로그인 사용 · 별도 API 키 없음 · 원음 파일 저장 안 함 · 최대 5분</small>
    <div className="voice-call-devices">
      <label>마이크<select aria-label="통화 마이크" value={input} disabled={busy} onChange={e => setInput(e.target.value)}><option value="">시스템 기본</option>{devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default').map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || '마이크'}</option>)}</select></label>
      <label>스피커<select aria-label="통화 스피커" value={output} disabled={busy} onChange={e => setOutput(e.target.value)}><option value="">시스템 기본</option>{devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default').map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || '스피커'}</option>)}</select></label>
    </div>
    <div className="voice-call-actions">
      {busy ? <><button type="button" onClick={() => ref.current?.setMuted(!view.muted)}>{view.muted ? '마이크 켜기' : '음소거'}</button><button type="button" onClick={() => ref.current?.silence()} disabled={view.phase !== 'connected'}>말하기 중지</button><button type="button" onClick={() => ref.current?.end()}>통화 종료</button></> : <button type="button" onClick={start}>다시 연결</button>}
      <button type="button" disabled={view.phase !== 'connected'} onClick={() => void ref.current?.control('status')}>작업 상태</button>
      <button type="button" disabled={view.phase !== 'connected'} onClick={() => void ref.current?.control('stop')}>현재 작업 정지</button>
      <button type="button" disabled={view.phase !== 'connected'} onClick={() => void ref.current?.control('stop_all')}>전체 작업 정지</button>
    </div>
    <div className="voice-call-transcript" role="log" aria-label="통화 자막">{view.lines.map((l, i) => <p key={i}><b>{l.role === 'user' ? 'K' : l.role === 'assistant' ? '비서' : 'KDA'}:</b> {l.text}</p>)}</div>
    <small>헤드셋 사용 권장. 통화 종료 후에도 진행 중인 작업은 작업 패널에서 확인하세요.</small>
  </section>;
}
