import { useEffect, useRef, useState } from 'react';
import atlas from '../assets/k-assistant-ceramic-v2.png';
import type { AvatarMood } from './AssistantAvatar';
import './CompanionAvatar.css';
import { voiceEffect, type VoiceEffectPreference } from '../voiceEffects';

export type CompanionStyle = 'mint' | 'pearl' | 'rose';
export interface CompanionPreference { style: CompanionStyle; motion: boolean; voice: string; effect: VoiceEffectPreference }
export function readCompanionPreference(): CompanionPreference {
  try {
    const p = JSON.parse(localStorage.getItem('kda_companion_v2') || 'null');
    const legacy = JSON.parse(localStorage.getItem('kda_assistant_avatar_v1') || 'null');
    return { style: ['mint', 'pearl', 'rose'].includes(p?.style) ? p.style : 'mint', motion: (p?.motion ?? legacy?.motion) !== false,
      voice: typeof p?.voice === 'string' && /^[a-z]{2,24}$/.test(p.voice) ? p.voice : '', effect: voiceEffect(p?.effect) };
  } catch { return { style: 'mint', motion: true, voice: '', effect: voiceEffect(null) }; }
}
const frames: Record<AvatarMood, number> = { idle: 0, listening: 1, thinking: 2, speaking: 3, working: 7, connecting: 2, muted: 6, error: 8 };
export default function CompanionAvatar({ mood, motion, style, compact, expanded, request, onActivate }: {
  mood: AvatarMood; motion: boolean; style: CompanionStyle; compact: boolean; expanded: boolean;
  request?: { frame: number; key: number }; onActivate(): void;
}) {
  const [visible, setVisible] = useState(!document.hidden);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [reaction, setReaction] = useState<number | null>(null);
  const reset = useRef<ReturnType<typeof setTimeout>>();
  const cycle = useRef(0);
  const moving = motion && visible && !reduced;
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reduce = () => setReduced(query.matches);
    document.addEventListener('visibilitychange', change); query.addEventListener('change', reduce);
    return () => { document.removeEventListener('visibilitychange', change); query.removeEventListener('change', reduce); clearTimeout(reset.current); };
  }, []);
  useEffect(() => {
    setReaction(null);
    if (!moving || mood !== 'idle') return;
    const timer = setInterval(() => {
      setReaction([2, 5, 6][cycle.current++ % 3]);
      clearTimeout(reset.current); reset.current = setTimeout(() => setReaction(null), 2200);
    }, 18_000);
    return () => { clearInterval(timer); clearTimeout(reset.current); };
  }, [moving, mood]);
  useEffect(() => {
    if (!request || mood !== 'idle' || !moving) return;
    setReaction(request.frame); clearTimeout(reset.current);
    reset.current = setTimeout(() => setReaction(null), 2600);
  }, [request, mood, moving]);
  const frame = mood === 'idle' && moving && reaction !== null ? reaction : frames[mood];
  return <button type="button" className={`companion-avatar tone-${style}${compact ? ' is-compact' : ''}`}
    data-mood={mood} data-frame={frame} data-motion={moving ? 'on' : 'off'} aria-expanded={expanded}
    aria-label="K 비서 아바타 · 기능 열기" title="누르면 기능 열기 · 끌어서 이동"
    onClick={() => {
      if (moving && mood === 'idle') { setReaction(4); clearTimeout(reset.current); reset.current = setTimeout(() => setReaction(null), 2200); }
      onActivate();
    }}>
    <span className="companion-ground" aria-hidden="true" />
    <span className="companion-sprite" aria-hidden="true" style={{ backgroundImage: `url(${atlas})`, backgroundPosition: `${(frame % 3) * 50}% ${Math.floor(frame / 3) * 50}%` }} />
    {mood === 'speaking' && <span className="companion-voice-waves" aria-hidden="true"><i /><i /><i /><i /><i /></span>}
  </button>;
}
