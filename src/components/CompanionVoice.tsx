import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { listVoiceChoices, voiceTransport } from '../voiceTransport';
import { VoiceSession, isVoiceCallActive, type VoiceView } from '../voiceSession';
import { readVoiceGain } from '../voiceOutput';
import CompanionIcon from './CompanionIcon';
import { VOICE_EFFECT_PRESETS, voiceEffect, type VoiceEffectPreference } from '../voiceEffects';

export interface CompanionVoiceHandle { stop(): void }
export default forwardRef<CompanionVoiceHandle, {
  voice: string; onChange(voice: string): void; enabled: boolean; callActive: boolean; onView?(view: VoiceView | null): void;
  effect: VoiceEffectPreference; onEffectChange(effect: VoiceEffectPreference): void; callEffectWarning?: string;
}>(function CompanionVoice({ voice, onChange, enabled, callActive, onView, effect, onEffectChange, callEffectWarning }, ref) {
  const [voices, setVoices] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<VoiceView | null>(null);
  const preview = useRef<VoiceSession>();
  const mounted = useRef(false);
  const stop = () => { preview.current?.end(); preview.current = undefined; };
  useImperativeHandle(ref, () => ({ stop }));
  useEffect(() => { onView?.(view); }, [view, onView]);
  useEffect(() => { preview.current?.setOutputEffect(effect); }, [effect.preset, effect.strength]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stop(); }; }, []);
  useEffect(() => {
    if (!enabled || callActive) { stop(); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    void listVoiceChoices(controller.signal).then(found => {
      if (!controller.signal.aborted) setVoices(found);
    }).catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled, callActive, reload]);
  const busy = view?.phase === 'connecting' || view?.phase === 'connected';
  const unavailable = !!voice && !voices.includes(voice);
  function sample() {
    if (callActive || isVoiceCallActive()) return;
    stop();
    const denied = async () => { throw Error('미리듣기에서는 작업을 실행할 수 없습니다.'); };
    const session = new VoiceSession(crypto.randomUUID(), { status: denied, send: denied, stop: denied, stopAll: denied },
      voiceTransport, next => { if (mounted.current) setView(next); });
    preview.current = session;
    session.setOutputGain(readVoiceGain());
    session.setOutputEffect(effect);
    void session.start('', '', voice, true);
  }
  return <section className="companion-voice" aria-label="비서 목소리 설정">
    <div className="companion-field-heading"><strong>목소리</strong><span>나와 어울리는 한 가지</span></div>
    <div className="companion-voice-card"><div className="companion-voice-identity"><span className={`companion-sound-mark${busy ? ' is-playing' : ''}`} aria-hidden="true"><i /><i /><i /><i /><i /></span><div><strong>{voice ? voice.charAt(0).toUpperCase() + voice.slice(1) : '기본 목소리'}</strong><small>{busy ? '미리듣는 중' : 'VOICE COMPANION'}</small></div><button className="companion-voice-refresh" type="button" aria-label="목록 새로고침" title={loading ? '목소리 불러오는 중…' : '목록 새로고침'} disabled={loading || callActive || busy} onClick={() => setReload(n => n + 1)}><CompanionIcon name="refresh" /></button></div>
    <label><span className="companion-sr-only">비서 목소리</span><select aria-label="비서 목소리" value={voice} disabled={loading} onChange={e => { stop(); onChange(e.target.value); setView(null); }}>
      <option value="">엔진 기본 목소리</option>
      {unavailable && <option value={voice} disabled>{voice} · 사용 가능 여부 확인 필요</option>}
      {voices.map(name => <option key={name} value={name}>{name.charAt(0).toUpperCase() + name.slice(1)}</option>)}
    </select></label>
    <div className="companion-effect-heading"><strong>캐릭터 음색</strong><span>실시간 변조</span></div>
    <div className="companion-effect-presets" role="group" aria-label="음성 변조 프리셋">
      {VOICE_EFFECT_PRESETS.map(p => <button type="button" key={p.id} aria-pressed={effect.preset === p.id} title={p.description}
        onClick={() => onEffectChange(voiceEffect({ ...effect, preset: p.id }))}>{p.name}</button>)}
    </div>
    <p className="companion-effect-description">{VOICE_EFFECT_PRESETS.find(p => p.id === effect.preset)?.description}</p>
    <label className="companion-effect-strength"><span>변조 강도<output>{effect.preset === 'natural' ? '원음' : `${Math.round(effect.strength * 100)}%`}</output></span><input type="range" aria-label="음성 변조 강도" min="0" max="100" step="5" disabled={effect.preset === 'natural'} value={Math.round(effect.strength * 100)} onChange={e => onEffectChange(voiceEffect({ ...effect, strength: Number(e.target.value) / 100 }))} /></label>
    <div className="companion-voice-actions">
      <button type="button" disabled={callActive || loading || unavailable} onClick={() => busy ? stop() : sample()}><CompanionIcon name={busy ? 'stop' : 'play'} />{busy ? '미리듣기 중지' : '목소리 미리듣기'}</button>
    </div>
    </div>
    {loading && <small role="status">목소리 불러오는 중…</small>}
    {error && <small role="alert">{error}</small>}
    {view && <small role="status">{view.phase === 'ended' ? '미리듣기 종료' : view.message}</small>}
    {(callActive ? callEffectWarning : view?.effectWarning) && <small role="status">{callActive ? callEffectWarning : view?.effectWarning}</small>}
    {callActive && <small className="companion-effect-live">음색·강도는 지금 통화에 바로 적용돼요.</small>}
    <small className="companion-voice-note">{callActive ? '변경한 목소리는 다음 통화부터 적용돼요. 통화 중에는 미리듣기를 쉬어요.' : '한국어로 미리 들어보세요. 마이크는 켜지지 않아요.'}</small>
  </section>;
});
