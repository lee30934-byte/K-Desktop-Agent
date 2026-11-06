import { useEffect, useRef, useState } from 'react';
import './AssistantAvatar.css';

export const AVATARS = [
  { id: 'robot', name: '로봇', note: '반짝이는 안테나' },
  { id: 'cat', name: '고양이', note: '살랑이는 꼬리' },
  { id: 'sprout', name: '새싹', note: '바람에 흔들리는 잎' },
  { id: 'cloud', name: '구름', note: '둥실 떠다니는 별' },
] as const;
export type AvatarKind = typeof AVATARS[number]['id'];
export type AvatarMood = 'idle' | 'working' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'error';
export const AVATAR_MOODS: Record<AvatarMood, string> = {
  idle: '곁에서 기다리고 있어요', working: '차근차근 작업 중', connecting: '음성 연결 중',
  listening: '듣고 있어요', thinking: '생각을 정리하고 있어요', speaking: '이야기하는 중',
  muted: '마이크가 쉬고 있어요', error: '연결을 확인해 주세요',
};
const REACTIONS = ['wave', 'happy', 'curious', 'sleepy'] as const;
export function readAvatarPreference(): { kind: AvatarKind; motion: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem('kda_assistant_avatar_v1') || 'null');
    return { kind: AVATARS.some(a => a.id === saved?.kind) ? saved.kind : 'robot', motion: saved?.motion !== false };
  } catch { return { kind: 'robot', motion: true }; }
}

/** Original SVG artwork: each face and limb remains independently animatable. */
export default function AssistantAvatar({ kind, mood, motion, compact = false }: {
  kind: AvatarKind; mood: AvatarMood; motion: boolean; compact?: boolean;
}) {
  const [reaction, setReaction] = useState('');
  const [visible, setVisible] = useState(!document.hidden);
  const count = useRef(0);
  const reset = useRef<ReturnType<typeof setTimeout>>();
  function react() {
    clearTimeout(reset.current);
    setReaction(REACTIONS[count.current++ % REACTIONS.length]);
    reset.current = setTimeout(() => setReaction(''), 2600);
  }
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => { document.removeEventListener('visibilitychange', change); clearTimeout(reset.current); };
  }, []);
  useEffect(() => {
    if (!motion || !visible || mood !== 'idle') return;
    const timer = setInterval(react, 19_000);
    return () => { clearInterval(timer); clearTimeout(reset.current); setReaction(''); };
  }, [motion, visible, mood, kind]);
  return <button type="button" className={`assistant-avatar avatar-${kind}${compact ? ' is-compact' : ''}`}
    data-mood={mood} data-reaction={reaction} data-motion={motion && visible ? 'on' : 'off'}
    aria-label={`${AVATARS.find(a => a.id === kind)?.name} 아바타 · ${AVATAR_MOODS[mood]} · 눌러서 인사`}
    title="눌러서 인사해 보세요" onClick={react}>
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <ellipse className="avatar-shadow" cx="60" cy="106" rx="25" ry="4" />
      <g className="avatar-body">
        {kind === 'robot' && <>
          <g className="avatar-antenna"><path d="M60 31V19" /><circle cx="60" cy="16" r="5" /></g>
          <rect className="avatar-limb" x="24" y="47" width="9" height="24" rx="4" />
          <rect className="avatar-limb avatar-wave" x="87" y="47" width="9" height="24" rx="4" />
          <rect className="avatar-shell" x="32" y="31" width="56" height="52" rx="19" />
          <rect className="avatar-screen" x="38" y="39" width="44" height="33" rx="12" />
          <rect className="avatar-shell" x="44" y="86" width="32" height="14" rx="7" />
          <path className="avatar-detail" d="M55 92h10" />
        </>}
        {kind === 'cat' && <>
          <path className="avatar-tail" d="M82 93q23-6 16-25" />
          <ellipse className="avatar-shell" cx="60" cy="85" rx="23" ry="17" />
          <path className="avatar-shell" d="M31 50 32 23 50 35Q60 31 70 35L88 23 89 50Q98 82 60 84 22 82 31 50Z" />
          <path className="avatar-inner" d="m36 43 1-12 9 8m28 0 9-8 1 12" />
          <path className="avatar-detail" d="m32 61-12-3m12 10-12 2m68-9 12-3m-12 10 12 2" />
          <ellipse className="avatar-limb avatar-wave" cx="83" cy="85" rx="7" ry="10" />
          <path className="avatar-nose" d="m57 61 3 3 3-3Z" />
        </>}
        {kind === 'sprout' && <>
          <g className="avatar-leaves"><path className="avatar-stem" d="M60 57V31" />
            <path className="avatar-leaf" d="M60 40Q30 42 30 20q28-3 30 20Z" />
            <path className="avatar-leaf avatar-wave" d="M60 34Q62 8 87 14q1 26-27 20Z" />
            <path className="avatar-detail" d="m39 27 21 13 17-17" /></g>
          <path className="avatar-shell" d="M32 56h56l-8 39q-20 13-40 0Z" />
          <rect className="avatar-rim" x="28" y="49" width="64" height="13" rx="6" />
          <path className="avatar-detail" d="M44 95q16 6 32 0" />
        </>}
        {kind === 'cloud' && <>
          <path className="avatar-shell" d="M31 83Q9 82 18 61q4-8 14-9Q33 29 53 33q16-16 31 5 24-1 20 23 15 22-11 24Z" />
          <path className="avatar-detail" d="M23 70q-2-9 8-12m10-12q2-7 10-6" />
          <path className="avatar-star avatar-wave" d="m93 19 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z" />
          <path className="avatar-star avatar-star-small" d="m25 91 2 4 5 1-4 3 1 5-4-2-4 2 1-5-4-3 5-1Z" />
        </>}
        <g className={`avatar-face${kind === 'sprout' ? ' face-low' : ''}`}>
          <g className="avatar-eyes"><ellipse cx="47" cy="55" rx="3" ry="5" /><ellipse cx="73" cy="55" rx="3" ry="5" /></g>
          <path className="avatar-happy-eyes" d="M42 55q5-9 10 0m16 0q5-9 10 0" />
          <g className="avatar-cheeks"><ellipse cx="40" cy="64" rx="5" ry="2.5" /><ellipse cx="80" cy="64" rx="5" ry="2.5" /></g>
          <path className="avatar-smile" d="M54 66q6 6 12 0" />
          <ellipse className="avatar-mouth" cx="60" cy="68" rx="5" ry="5" />
          <path className="avatar-worry" d="M54 70q6-6 12 0" />
        </g>
      </g>
      <g className="avatar-thought"><circle cx="97" cy="52" r="2" /><circle cx="103" cy="44" r="3" /><circle cx="110" cy="34" r="4" /></g>
      <g className="avatar-notes"><path d="M100 64v-9l8-2v9m-8-5 8-2" /><ellipse cx="97" cy="65" rx="3" ry="2" /><ellipse cx="105" cy="63" rx="3" ry="2" /></g>
      <path className="avatar-heart" d="M89 23c-10-12-18 4 0 13 18-9 10-25 0-13Z" />
      <text className="avatar-zzz" x="87" y="37">z</text>
    </svg>
  </button>;
}
