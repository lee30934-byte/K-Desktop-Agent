import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import CompanionAvatar, { COMPANION_MOTION_LABELS, readCompanionPreference, type CompanionMotionState } from '../components/CompanionAvatar';
import type { AvatarMood } from '../components/AssistantAvatar';
import { VoiceSession, type VoiceView } from '../voiceSession';
import { MobileApi } from './api';
import { VOICE_EFFECT_PRESETS, voiceEffect, type VoiceEffectPreference } from '../voiceEffects';
import './mobile.css';

type Target = { id: string; title: string; provider?: string; model?: string };
const api = new MobileApi();
function MobileApp() {
  const [paired, setPaired] = useState(api.paired), [code, setCode] = useState('');
  const [targets, setTargets] = useState<Target[]>([]), [selected, setSelected] = useState('');
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [notice, setNotice] = useState(''), [status, setStatus] = useState<any>(null), [online, setOnline] = useState(false);
  const [voice, setVoice] = useState<VoiceView | null>(null), [pref, setPref] = useState(readCompanionPreference);
  const [motionState, setMotionState] = useState<CompanionMotionState>('playing');
  const call = useRef<VoiceSession | null>(null), current = useRef({ targets, selected }); current.current = { targets, selected };
  const target = targets.find(t => t.id === selected);
  const live = voice?.phase === 'connected' || voice?.phase === 'connecting';
  const secure = window.isSecureContext;
  const voiceError = voice?.phase === 'error' ? voice.message : '';
  const message = (e: unknown) => e instanceof Error ? e.message : String(e);
  useEffect(() => {
    api.onExpired = () => { call.current?.end(); setPaired(false); setOnline(false); setTargets([]); setStatus(null); setNotice('PC에서 새 연결 코드를 발급하세요.'); };
    return () => { call.current?.end(); api.onExpired = () => {}; };
  }, []);
  useEffect(() => {
    if (!paired) return;
    let closed = false;
    void api.rpc('conversations').then(list => { if (!closed) { setTargets(list); setOnline(true); } }).catch(e => { if (!closed) { setOnline(false); setError(message(e)); } });
    return () => { closed = true; };
  }, [paired]);
  useEffect(() => {
    if (!paired) return;
    let closed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api.rpc(selected ? 'status' : 'conversations', selected ? { conversationId: selected } : {});
        if (closed) return;
        setOnline(true);
        if (selected) setStatus(value); else setTargets(value);
      } catch (e) { if (!closed) { setOnline(false); setError(message(e)); } }
      if (!closed) timer = setTimeout(() => void poll(), 2500);
    };
    setStatus(null); void poll();
    return () => { closed = true; clearTimeout(timer); };
  }, [paired, selected]);
  useEffect(() => {
    const stop = () => { call.current?.end(); };
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); };
  }, []);
  const act = async (work: () => Promise<void>) => {
    setError(''); setBusy(true);
    try { await work(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const startCall = async () => {
    if (!selected || live) return;
    setError('');
    const session = new VoiceSession(selected, {
      status: id => api.rpc('status', { conversationId: id }),
      send: async (id, value, mode) => { await api.rpc('send', { conversationId: id, text: value, mode }); },
      stop: async id => { await api.rpc('stop', { conversationId: id }); },
    }, api.transport, setVoice, {
      conversations: () => current.current.targets,
      selected: () => current.current.selected,
      changed: value => { if (value) setSelected(value.id); },
    });
    call.current = session; session.setOutputEffect(pref.effect);
    await session.start('', '', pref.voice);
  };
  const changeEffect = (value: string) => {
    const effect: VoiceEffectPreference = voiceEffect({ preset: value, strength: pref.effect.strength });
    const next = { ...pref, effect }; setPref(next); localStorage.setItem('kda_companion_v2', JSON.stringify(next)); call.current?.setOutputEffect(effect);
  };
  const mood: AvatarMood = voice?.phase === 'error' ? 'error' : voice?.phase === 'connecting' ? 'connecting'
    : live ? voice?.speaking ? 'speaking' : voice?.muted ? 'muted' : voice?.commandPending ? 'thinking' : 'listening'
    : status?.run ? 'working' : 'idle';
  return <main className="mobile-shell">
    <header><div className="brand"><span className="brand-mark">K</span><div><strong>함께, 어디서나</strong><small>DESKTOP COMPANION</small></div></div>
      <span className={`connection ${paired && online ? 'online' : ''}`}>{paired && online ? 'PC 연결됨' : paired ? '연결 확인 중' : '기기 연결'}</span></header>
    <section className="companion-stage" aria-label="움직이는 O2 비서">
      <div className="stage-glow" /><CompanionAvatar mood={mood} motion={pref.motion} style={pref.style} compact={false} expanded={false} onMotionState={setMotionState} onActivate={() => setNotice('듣고 있어요. 아래에서 대화를 선택하고 이야기해 주세요.')} />
      <p>{live ? voice?.message : paired ? target ? `${target.title} · 무엇을 도와드릴까요?` : '명령할 대화를 골라 주세요' : 'PC의 O2를 휴대폰으로'}</p>
    </section>
    {!secure && <p className="alert" role="alert">음성 연결에는 HTTPS가 필요합니다. PC 설정의 개인 HTTPS 주소로 접속하세요.</p>}
    {!paired ? <section className="surface pairing"><h1>내 PC와 연결</h1><p>PC의 KDA 설정 → 휴대폰 아바타에서 연결을 켜고 일회용 코드를 입력하세요.</p>
      <form onSubmit={e => { e.preventDefault(); void act(async () => { await api.pair(code.trim()); setCode(''); setPaired(true); setNotice('연결했습니다. 명령할 대화를 선택하세요.'); }); }}>
        <label htmlFor="pair-code">연결 코드</label><input id="pair-code" type="password" autoComplete="off" spellCheck={false} value={code} onChange={e => setCode(e.target.value)} placeholder="PC에 표시된 일회용 코드" />
        <button className="primary" disabled={busy || !code.trim() || !secure}>PC 연결하기</button>
      </form><small>PC를 켜 둔 상태로 사용하세요. 연결 코드는 10분 안에 한 번만 사용할 수 있습니다.</small>
    </section> : <>
      <section className="surface command"><label htmlFor="conversation">명령할 대화</label>
        <div className="target-row"><select id="conversation" value={selected} disabled={busy} onChange={e => { setSelected(e.target.value); setStatus(null); call.current?.selectTarget(e.target.value); }}>
          <option value="">대화 선택</option>{targets.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select><button className="icon-button" aria-label="대화 목록 새로고침" disabled={busy} onClick={() => void act(async () => { const list = await api.rpc('conversations'); setTargets(list); if (!list.some((t: Target) => t.id === selected)) { call.current?.end(); setSelected(''); } })}>↻</button></div>
        <small className="model-hint">{target ? [target.provider || 'PC 선택 모델', target.model].filter(Boolean).join(' · ') : '선택한 대화의 모델·프로젝트 설정으로 실행합니다.'}</small>
        <div className="call-actions">{!live ? <button className="call primary" disabled={!selected || !secure || !online} onClick={() => void act(startCall)}>음성으로 대화</button> : <>
          <button onClick={() => call.current?.setMuted(!voice?.muted)}>{voice?.muted ? '마이크 켜기' : '마이크 끄기'}</button>
          <button className="danger" onClick={() => call.current?.end()}>통화 종료</button>
          <button disabled={voice?.phase !== 'connected' || voice?.extending} onClick={() => void call.current?.extend()}>통화 연장</button>
        </>}</div>
        <form onSubmit={e => { e.preventDefault(); const value = text; void act(async () => { const result = await api.rpc('send', { conversationId: selected, text: value, mode: 'queue' }); setText(''); setNotice(result.detail); }); }}>
          <label htmlFor="command">텍스트로 명령</label><textarea id="command" rows={3} maxLength={12000} value={text} onChange={e => setText(e.target.value)} placeholder="PC에서 할 일을 적어 주세요" />
          <div className="send-row"><button className="quiet" type="button" disabled={!selected || busy || !online} onClick={() => void act(async () => { await api.rpc('stop', { conversationId: selected }); setNotice('현재 대화 작업 정지를 확인했습니다. 분리 실행은 별도 확인이 필요합니다.'); })}>현재 작업 정지</button>
          <button className="primary" disabled={!selected || !text.trim() || busy || !online}>명령 보내기</button></div>
        </form>
      </section>
      <section className="surface result" aria-label="PC 작업 결과"><div className="result-heading"><h2>작업 결과</h2><span>{status?.run ? '진행 중' : status?.queued ? `대기 ${status.queued}건` : status?.paused ? '일시 정지' : '준비됨'}</span></div>
        {status?.approvalPending && <p className="alert">PC에서 확인이 필요한 요청이 있습니다. PC에서 검토하거나 같은 대화에 답변하세요.</p>}
        <p className="answer">{status?.latestAssistant?.text || (selected ? '이 대화의 결과가 여기에 표시됩니다.' : '대화를 선택하면 최근 답변을 확인할 수 있습니다.')}</p>
        {voice?.lines.length ? <details><summary>음성 대화 기록</summary>{voice.lines.map((line, i) => <p key={i}><small>{line.role === 'user' ? '나' : 'K'}</small> {line.text}</p>)}</details> : null}
      </section>
      <details className="surface preferences"><summary>목소리와 움직임</summary>
        <label htmlFor="effect">음성 변조</label><select id="effect" value={pref.effect.preset} onChange={e => changeEffect(e.target.value)}>{VOICE_EFFECT_PRESETS.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
        <label className="motion-check"><input type="checkbox" checked={pref.motion} onChange={e => { const next = { ...pref, motion: e.target.checked }; setPref(next); localStorage.setItem('kda_companion_v2', JSON.stringify(next)); }} />아바타 움직임</label>
        <small role="status" aria-live="polite">{COMPANION_MOTION_LABELS[motionState]}</small>
        <p>음성 연결은 Codex 음성 엔진, 작업은 PC에서 선택한 모델이 처리합니다.</p>
      </details><button className="disconnect" onClick={() => void act(async () => { call.current?.end(); await api.disconnect(); setPaired(false); setTargets([]); setStatus(null); setSelected(''); setNotice('휴대폰 연결을 해제했습니다.'); })}>이 휴대폰 연결 해제</button>
    </>}
    {notice && <p className="notice" role="status">{notice}</p>}{(error || voiceError || voice?.effectWarning) && <p className="alert" role="alert">{error || voiceError || voice?.effectWarning}</p>}
    <footer>명령 접수와 작업 완료는 구분됩니다.<br />화면을 닫아도 접수된 PC 작업은 이어집니다.</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><MobileApp /></React.StrictMode>);
