import { useEffect, useRef, useState } from 'react';
import { VoiceSession, type VoiceView } from '../voiceSession';
import { voiceTransport as transport } from '../voiceTransport';
import type { VoiceHandlers } from '../voiceControl';
import type { VoiceTarget } from '../voiceRouting';
import { readVoiceGain, voiceGain, VOICE_OUTPUT_KEY, MAX_VOICE_GAIN } from '../voiceOutput';
import './VoiceCallPanel.css';
import { DEFAULT_VOICE_EFFECT, type VoiceEffectPreference } from '../voiceEffects';

export default function VoiceCallPanel({ conversationId, title, handlers, onClose, selectedId, conversations, onTarget, onView, voice = '', effect = DEFAULT_VOICE_EFFECT }: {
  conversationId: string; title: string; handlers: VoiceHandlers; onClose(): void;
  selectedId?: string | null; conversations?: VoiceTarget[];
  onTarget?(target: VoiceTarget | null, following: boolean): void;
  onView?(view: VoiceView): void;
  voice?: string;
  effect?: VoiceEffectPreference;
}) {
  const ref = useRef<VoiceSession>();
  const handlersRef = useRef(handlers); handlersRef.current = handlers;
  const target = useRef({ conversationId, title });
  const live = useRef({ selectedId, conversations, onTarget }); live.current = { selectedId, conversations, onTarget };
  const [following, setFollowing] = useState(true);
  const [routeError, setRouteError] = useState('');
  const [view, setView] = useState<VoiceView>({ phase: 'idle', message: '', muted: false, speaking: false, conversationId, lines: [] });
  const [now, setNow] = useState(Date.now);
  const [confirmStopAll, setConfirmStopAll] = useState(false);
  useEffect(() => {
    if (!confirmStopAll) return;
    const t = setTimeout(() => setConfirmStopAll(false), 4000);
    return () => clearTimeout(t);
  }, [confirmStopAll]);
  useEffect(() => { if (view.phase !== 'connected') setConfirmStopAll(false); }, [view.phase]);
  useEffect(() => { onView?.(view); }, [view, onView]);
  useEffect(() => { ref.current?.setOutputEffect(effect); }, [effect.preset, effect.strength]);
  useEffect(() => {
    if (view.phase !== 'connected') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [view.phase, view.expiresAt]);
  const remaining = Math.max(0, Math.ceil(((view.expiresAt ?? now) - now) / 1000));
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceMessage, setDeviceMessage] = useState('');
  const deviceRead = useRef(0);
  const mounted = useRef(false);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [gain, setGain] = useState(readVoiceGain);
  const busy = view.phase === 'connected' || view.phase === 'connecting';
  async function refreshDevices() {
    const read = ++deviceRead.current;
    try {
      if (!navigator.mediaDevices?.enumerateDevices) throw Error('device enumeration unavailable');
      const found = await navigator.mediaDevices.enumerateDevices();
      if (!mounted.current || read !== deviceRead.current) return;
      setDevices(found);
      setDeviceMessage(found.some(d => d.kind === 'audioinput') ? '' : '현재 앱에서 보이는 마이크가 없습니다. 마이크 연결·권한을 확인하세요. 원격 접속에서는 접속 PC의 마이크 전달 설정도 필요합니다.');
    } catch {
      if (mounted.current && read === deviceRead.current) setDeviceMessage('장치 목록을 읽지 못했습니다. 마이크 연결·권한을 확인한 뒤 장치를 새로고침하세요.');
    }
  }
  function start() {
    ref.current?.end();
    const bound: VoiceHandlers = {
      status: id => handlersRef.current.status(id),
      send: (id, text, mode) => handlersRef.current.send(id, text, mode),
      stop: id => handlersRef.current.stop(id),
      stopAll: () => { const fn = handlersRef.current.stopAll; return fn ? fn() : Promise.reject(Error('전체 정지 사용 불가')); },
      canSend: r => handlersRef.current.canSend?.(r) !== false,
    };
    const initial = live.current.conversations && following ? live.current.selectedId : target.current.conversationId;
    if (!initial) { setRouteError('먼저 명령할 대화를 선택하세요.'); return; }
    const session = new VoiceSession(initial, bound, transport, setView, live.current.conversations ? {
      conversations: () => live.current.conversations ?? [],
      selected: () => live.current.selectedId ?? null,
      changed: (next, follows) => {
        target.current = { conversationId: next?.id ?? '', title: next?.title ?? '대화 선택 필요' };
        setFollowing(follows); setRouteError('');
        live.current.onTarget?.(next, follows);
      },
    } : undefined);
    if (!following) session.selectTarget(initial);
    session.setOutputGain(gain);
    session.setOutputEffect(effect);
    ref.current = session;
    void session.start(input, output, voice).then(() => refreshDevices());
  }
  useEffect(() => {
    mounted.current = true;
    void refreshDevices();
    start();
    const devicesChanged = () => { void refreshDevices(); };
    navigator.mediaDevices?.addEventListener('devicechange', devicesChanged);
    const unload = () => ref.current?.end();
    window.addEventListener('pagehide', unload);
    window.addEventListener('beforeunload', unload);
    return () => { mounted.current = false; deviceRead.current++; navigator.mediaDevices?.removeEventListener('devicechange', devicesChanged); window.removeEventListener('pagehide', unload); window.removeEventListener('beforeunload', unload); ref.current?.end(); };
    // Browsing never restarts media. The router samples selection at speech onset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <section className="voice-call" aria-label="AI 비서 음성통화">
    <div className="voice-call-title"><strong>AI 비서 음성통화</strong><button type="button" aria-label="음성통화 닫기" onClick={() => { ref.current?.end(); onClose(); }}>×</button></div>
    <small className="voice-call-target" aria-live="polite">명령 대상: {following && !view.commandPending && conversations ? conversations.find(c => c.id === selectedId)?.title ?? '대화 선택 필요' : target.current.title}{following ? ' · 현재 대화 따라가기' : ' · 고정'}</small>
    {conversations && <label className="voice-call-route">대상 변경<select aria-label="음성 명령 대상" disabled={!!view.commandPending || view.speaking} value={following ? '' : target.current.conversationId} onChange={e => {
      try { ref.current?.selectTarget(e.target.value || null); setRouteError(''); } catch (error) { setRouteError(String(error)); }
    }}><option value="">현재 보고 있는 대화 따라가기</option>{conversations.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>}
    {routeError && <small role="alert">{routeError}</small>}
    <p role={view.phase === 'error' ? 'alert' : 'status'}>{view.message || '음성 연결 준비 중…'}</p>
    {view.phase === 'connected' && <div className="voice-call-lease"><span>남은 시간 {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span>
      <button type="button" disabled={view.extending || remaining > 5 * 60} onClick={() => void ref.current?.extend()} title="남은 시간이 5분 이하일 때 5분 더 이어갈 수 있어요">{view.extending ? '연장 확인 중…' : '5분 연장'}</button></div>}
    {view.extensionMessage && <small role="status">{view.extensionMessage}</small>}
    {view.effectWarning && <small role="status">{view.effectWarning}</small>}
    <div className="voice-call-actions voice-call-primary">
      {busy ? <><button type="button" onClick={() => ref.current?.setMuted(!view.muted)}>{view.muted ? '마이크 켜기' : '음소거'}</button><button type="button" onClick={() => ref.current?.silence()} disabled={view.phase !== 'connected'}>말하기 중지</button><button type="button" className="voice-call-end" onClick={() => ref.current?.end()}>통화 종료</button></> : <button type="button" onClick={start}>다시 연결</button>}
    </div>
    <details className="voice-call-options">
      <summary>음성·장치 설정</summary>
    <div className="voice-call-devices">
      <label>마이크<select aria-label="통화 마이크" value={input} disabled={busy} onChange={e => setInput(e.target.value)}><option value="">시스템 기본</option>{input && !devices.some(d => d.kind === 'audioinput' && d.deviceId === input) && <option value={input} disabled>선택한 마이크 · 연결 확인 필요</option>}{devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default').map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || '마이크'}</option>)}</select></label>
      <label>스피커<select aria-label="통화 스피커" value={output} disabled={busy} onChange={e => setOutput(e.target.value)}><option value="">시스템 기본</option>{output && !devices.some(d => d.kind === 'audiooutput' && d.deviceId === output) && <option value={output} disabled>선택한 스피커 · 연결 확인 필요</option>}{devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default').map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || '스피커'}</option>)}</select></label>
    </div>
    <label className="voice-call-volume">KDA 음성 크기 <output>{Math.round(gain * 100)}%</output>
      <input aria-label="KDA 음성 크기" type="range" min="0" max={MAX_VOICE_GAIN * 100} step="10" value={Math.round(gain * 100)} onChange={e => {
        const value = voiceGain(Number(e.target.value) / 100);
        setGain(value); ref.current?.setOutputGain(value);
        try { localStorage.setItem(VOICE_OUTPUT_KEY, String(value)); } catch { /* Current-call control still works. */ }
      }} />
    </label>
    {deviceMessage && <small role="status">{deviceMessage}</small>}
    <button type="button" onClick={() => void refreshDevices()}>장치 새로고침</button>
    <small>Codex 로그인 사용 · 원음 파일 저장 안 함 · 기본 5분, 연결 중 연장 가능</small>
    </details>
    {deviceMessage && view.phase === 'error' && <small role="status">{deviceMessage}</small>}
    <section className="voice-call-work" aria-label="작업 제어">
      <div className="voice-call-work-heading"><strong>작업 제어</strong><button type="button" disabled={view.phase !== 'connected'} onClick={() => void ref.current?.control('status')}>상태 묻기</button></div>
      <div className="voice-call-actions">
        <button type="button" className="voice-call-stop" disabled={view.phase !== 'connected'} onClick={() => void ref.current?.control('stop')}>현재 작업 정지</button>
        <button type="button" className={`voice-call-stop-all${confirmStopAll ? ' is-confirming' : ''}`} disabled={view.phase !== 'connected'}
          aria-describedby="voice-call-stop-all-note"
          onClick={() => {
            if (!confirmStopAll) { setConfirmStopAll(true); return; }
            setConfirmStopAll(false); void ref.current?.control('stop_all');
          }}>{confirmStopAll ? '한 번 더 눌러 전체 정지' : '전체 작업 정지'}</button>
      </div>
      <small id="voice-call-stop-all-note">{confirmStopAll ? '모든 대화의 실행이 멈춥니다. 4초 안에 다시 누르면 실행돼요.' : '전체 정지는 확인을 한 번 더 받아요.'}</small>
    </section>
    <details className="voice-call-options"><summary>통화 자막</summary><div className="voice-call-transcript" role="log" aria-label="통화 자막">{view.lines.map((l, i) => <p key={i}><b>{l.role === 'user' ? 'K' : l.role === 'assistant' ? '비서' : 'KDA'}:</b> {l.text}</p>)}</div></details>
    <small>“○○ 대화에 수정 요청해줘”처럼 대상을 말해보세요. 지시받은 대화의 맥락으로 작업하며, 통화를 끝내도 작업은 계속됩니다.</small>
  </section>;
}
