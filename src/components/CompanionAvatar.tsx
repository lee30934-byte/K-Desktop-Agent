import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { AvatarMood } from './AssistantAvatar';
import { COMPANION_SHEET_TIERS, type CompanionSheetTier } from './companionSheets';
import { COMPANION_RIG } from './companionRig';
import { readVoiceLevel } from '../voiceLevel';
import './CompanionAvatar.css';
import { voiceEffect, type VoiceEffectPreference } from '../voiceEffects';

export type CompanionStyle = 'mint' | 'pearl' | 'rose';
export type CompanionMotionState = 'playing' | 'disabled' | 'reduced' | 'hidden';
export const COMPANION_MOTION_LABELS: Record<CompanionMotionState, string> = {
  playing: '고개·눈·몸 움직임 켜짐', disabled: '움직임 꺼짐',
  reduced: '기기의 동작 줄이기 설정으로 정지', hidden: '화면을 다시 열면 움직여요',
};
export interface CompanionPreference { style: CompanionStyle; motion: boolean; voice: string; effect: VoiceEffectPreference }
export function readCompanionPreference(): CompanionPreference {
  try {
    const p = JSON.parse(localStorage.getItem('kda_companion_v2') || 'null');
    const legacy = JSON.parse(localStorage.getItem('kda_assistant_avatar_v1') || 'null');
    return { style: ['mint', 'pearl', 'rose'].includes(p?.style) ? p.style : 'mint', motion: (p?.motion ?? legacy?.motion) !== false,
      voice: typeof p?.voice === 'string' && /^[a-z]{2,24}$/.test(p.voice) ? p.voice : '', effect: voiceEffect(p?.effect) };
  } catch { return { style: 'mint', motion: true, voice: '', effect: voiceEffect(null) }; }
}

/**
 * Pick the atlas resolution for the drawn size. A cell much larger than the drawn device pixels
 * shimmers while layers rotate (no mipmaps on animated layers); <=~1.5x stays stable.
 */
export function pickSheetTier(devicePx: number): CompanionSheetTier {
  const fit = [...COMPANION_SHEET_TIERS].reverse().find(t => t.cell >= devicePx * 0.95);
  return fit ?? COMPANION_SHEET_TIERS[0];
}
/** Pose per state. Muted keeps open eyes (+ badge) so it never reads as "asleep". */
export const COMPANION_FRAMES: Record<AvatarMood, number> = { idle: 0, listening: 1, thinking: 2, speaking: 3, working: 7, connecting: 1, muted: 0, error: 8 };
const DOZE_FRAME = 6;
/** Doze only after this long without any interaction, never on a fixed cycle. */
export const COMPANION_DROWSY_MS = 180_000;
const REACTIONS = [2, 5, 4];
const CROSSFADE_MS = 160;

function randomBetween(min: number, max: number) { return min + Math.random() * (max - min); }
function sheet(url: string, frame: number): CSSProperties {
  return { backgroundImage: `url(${url})`, backgroundPosition: `${(frame % 3) * 50}% ${Math.floor(frame / 3) * 50}%` };
}
function rigVars(frame: number): CSSProperties {
  const r = COMPANION_RIG.frames[frame];
  return {
    '--cp-pivot': `${r.pivot[0]}% ${r.pivot[1]}%`,
    '--cp-body-pivot': `${r.bodyPivot[0]}% ${r.bodyPivot[1]}%`,
    '--cp-eyes': `${r.eyes[0]}% ${r.eyes[1]}%`,
    '--cp-mouth': r.mouth ? `${r.mouth[0]}% ${r.mouth[1]}%` : '50% 50%',
    '--cp-antenna-x': `${r.antenna[0]}%`, '--cp-antenna-y': `${r.antenna[1]}%`,
    // Hands in front of the face stay with the body: turn the head less there.
    '--cp-amp': r.front ? '0.6' : '1',
  } as CSSProperties;
}

function Pose({ frame, style, tier, leaving }: { frame: number; style: CompanionStyle; tier: CompanionSheetTier; leaving?: boolean }) {
  const r = COMPANION_RIG.frames[frame];
  const s = { body: tier.body[style], head: tier.head[style], front: tier.front[style] };
  return <span className={`companion-pose${leaving ? ' is-leaving' : ''}`} data-pose={frame} style={rigVars(frame)}>
    <span className="companion-body-motion">
      <span className="companion-layer companion-body" style={sheet(s.body, frame)} />
      <span className="companion-head-look"><span className="companion-head-motion">
        <span className="companion-layer companion-head" style={sheet(s.head, frame)} />
        <span className="companion-eyes" data-blink={r.blink ? 'on' : 'off'}><span className="companion-gaze">
          <span className="companion-layer" style={sheet(tier.eyes, frame)} />
        </span></span>
        {r.mouth && <span className="companion-mouth"><span className="companion-layer" style={sheet(tier.mouth, frame)} /></span>}
        <span className="companion-antenna-glow" />
      </span></span>
      {r.front && <span className="companion-layer companion-front" style={sheet(s.front, frame)} />}
    </span>
  </span>;
}

export default function CompanionAvatar({ mood, motion, style, compact, expanded, request, onActivate, onMotionState }: {
  mood: AvatarMood; motion: boolean; style: CompanionStyle; compact: boolean; expanded: boolean;
  request?: { frame: number; key: number }; onActivate(): void;
  onMotionState?(state: CompanionMotionState): void;
}) {
  const [visible, setVisible] = useState(!document.hidden);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [reaction, setReaction] = useState<number | null>(null);
  const [drowsy, setDrowsy] = useState(false);
  const [leaving, setLeaving] = useState<{ frame: number; key: number } | null>(null);
  const root = useRef<HTMLButtonElement>(null);
  const rig = useRef<HTMLSpanElement>(null);
  // Initial guess from the CSS box (216px / 112px; rig = 112%), refined by ResizeObserver below.
  const [tier, setTier] = useState(() => pickSheetTier((compact ? 112 : 216) * 1.12 * (window.devicePixelRatio || 1)));
  const reset = useRef<ReturnType<typeof setTimeout>>();
  const lastReaction = useRef<number | null>(null);
  const shownFrame = useRef<number | null>(null);
  const motionState: CompanionMotionState = !motion ? 'disabled' : reduced ? 'reduced' : !visible ? 'hidden' : 'playing';
  const moving = motionState === 'playing';
  const dozing = moving && mood === 'idle' && drowsy;
  const frame = dozing ? DOZE_FRAME : mood === 'idle' && moving && reaction !== null ? reaction : COMPANION_FRAMES[mood];

  useEffect(() => { onMotionState?.(motionState); }, [motionState, onMotionState]);
  // First paint: measure synchronously so the figure never starts on a guessed (blurrier) tier.
  useLayoutEffect(() => {
    const w = rig.current?.getBoundingClientRect().width;
    if (w) setTier(pickSheetTier(w * (window.devicePixelRatio || 1)));
  }, []);
  useEffect(() => {
    const el = rig.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let alive = true, wanted = -1;
    const choose = (devicePx: number) => {
      const next = pickSheetTier(devicePx);
      if (!devicePx || next.cell === wanted) return;
      wanted = next.cell;
      // Swap only after the new sheets are decoded so the figure never blinks out.
      const urls = [next.body[style], next.head[style], next.front[style], next.eyes, next.mouth];
      Promise.all(urls.map(u => { const img = new Image(); img.src = u; return img.decode().catch(() => undefined); }))
        .then(() => { if (alive && wanted === next.cell) setTier(next); });
    };
    const ro = new ResizeObserver(([entry]) => {
      const dev = (entry as ResizeObserverEntry & { devicePixelContentBoxSize?: ReadonlyArray<ResizeObserverSize> }).devicePixelContentBoxSize?.[0]?.inlineSize;
      choose(dev ?? entry.contentRect.width * (window.devicePixelRatio || 1));
    });
    try { ro.observe(el, { box: 'device-pixel-content-box' as ResizeObserverBoxOptions }); } catch { ro.observe(el); }
    return () => { alive = false; ro.disconnect(); };
  }, [style]);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reduce = () => setReduced(query.matches);
    document.addEventListener('visibilitychange', change); query.addEventListener('change', reduce);
    return () => { document.removeEventListener('visibilitychange', change); query.removeEventListener('change', reduce); clearTimeout(reset.current); };
  }, []);

  // Drowsiness: any app interaction or state change wakes the companion.
  useEffect(() => {
    if (!moving || mood !== 'idle') { setDrowsy(false); return; }
    let timer = setTimeout(() => setDrowsy(true), COMPANION_DROWSY_MS);
    const wake = () => { setDrowsy(false); clearTimeout(timer); timer = setTimeout(() => setDrowsy(true), COMPANION_DROWSY_MS); };
    const events = ['pointerdown', 'keydown', 'wheel'] as const;
    events.forEach(e => window.addEventListener(e, wake, { passive: true }));
    return () => { clearTimeout(timer); events.forEach(e => window.removeEventListener(e, wake)); };
  }, [moving, mood]);

  // Idle reactions at irregular intervals, never the same twice in a row.
  useEffect(() => {
    setReaction(null);
    if (!moving || mood !== 'idle' || drowsy) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        const options = REACTIONS.filter(f => f !== lastReaction.current);
        const next = options[Math.floor(Math.random() * options.length)];
        lastReaction.current = next;
        setReaction(next);
        clearTimeout(reset.current); reset.current = setTimeout(() => setReaction(null), randomBetween(1800, 2600));
        schedule();
      }, randomBetween(7_000, 14_000));
    };
    schedule();
    return () => { clearTimeout(timer); clearTimeout(reset.current); };
  }, [moving, mood, drowsy]);

  useEffect(() => {
    if (!request || mood !== 'idle' || !moving) return;
    setDrowsy(request.frame === DOZE_FRAME);
    if (request.frame === DOZE_FRAME) return;
    setReaction(request.frame); clearTimeout(reset.current);
    reset.current = setTimeout(() => setReaction(null), 2600);
  }, [request, mood, moving]);

  // Crossfade: the new pose fades in over the previous one (no translucent dip).
  useEffect(() => {
    const previous = shownFrame.current;
    shownFrame.current = frame;
    if (previous === null || previous === frame || !moving) { setLeaving(null); return; }
    const entry = { frame: previous, key: Date.now() };
    setLeaving(entry);
    const t = setTimeout(() => setLeaving(current => current === entry ? null : current), CROSSFADE_MS + 40);
    return () => clearTimeout(t);
  }, [frame, moving]);

  // Blinks and small eye saccades, written straight to the DOM (no re-render).
  useEffect(() => {
    const el = root.current;
    if (!el || !moving) return;
    let blinkTimer: ReturnType<typeof setTimeout>, openTimer: ReturnType<typeof setTimeout>, gazeTimer: ReturnType<typeof setTimeout>;
    const blink = (double = false) => {
      el.dataset.blinking = 'true';
      openTimer = setTimeout(() => {
        delete el.dataset.blinking;
        if (double) blinkTimer = setTimeout(() => blink(false), 170);
        else blinkTimer = setTimeout(() => blink(Math.random() < 0.18), randomBetween(2600, 6200));
      }, 130);
    };
    const gaze = () => {
      const settle = Math.random() < 0.45;
      el.style.setProperty('--cp-gaze-x', settle ? '0' : randomBetween(-1, 1).toFixed(2));
      el.style.setProperty('--cp-gaze-y', settle ? '0' : randomBetween(-0.6, 0.6).toFixed(2));
      gazeTimer = setTimeout(gaze, randomBetween(1400, 4200));
    };
    blinkTimer = setTimeout(() => blink(), randomBetween(1200, 3000));
    gazeTimer = setTimeout(gaze, 1800);
    return () => {
      clearTimeout(blinkTimer); clearTimeout(openTimer); clearTimeout(gazeTimer);
      delete el.dataset.blinking; el.style.removeProperty('--cp-gaze-x'); el.style.removeProperty('--cp-gaze-y');
    };
  }, [moving]);

  // Lip-sync: follow the real output loudness; synthesize only if no output exists.
  useEffect(() => {
    const el = root.current;
    if (!el || mood !== 'speaking') return;
    if (!moving) { el.style.setProperty('--cp-level', '0.7'); return () => { el.style.removeProperty('--cp-level'); }; }
    let raf = 0, level = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const measured = readVoiceLevel();
      const target = measured ?? (0.45 + 0.35 * Math.abs(Math.sin((now - started) / 110)) * Math.abs(Math.sin((now - started) / 370)));
      level += (target - level) * (target > level ? 0.55 : 0.18);
      el.style.setProperty('--cp-level', level.toFixed(3));
      el.dataset.levelSource = measured === null ? 'synthetic' : 'output';
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); el.style.removeProperty('--cp-level'); delete el.dataset.levelSource; };
  }, [mood, moving]);

  const resetLook = (element: HTMLButtonElement) => {
    element.style.removeProperty('--companion-look-x');
    element.style.removeProperty('--companion-look-y');
  };
  return <button ref={root} type="button" className={`companion-avatar tone-${style}${compact ? ' is-compact' : ''}`}
    data-mood={mood} data-frame={frame} data-rig="layered" data-dozing={dozing ? 'true' : undefined}
    data-motion={moving ? 'on' : 'off'} data-motion-state={motionState} aria-expanded={expanded}
    aria-label="K 비서 아바타 · 기능 열기" title="누르면 기능 열기 · 끌어서 이동"
    onPointerMove={event => {
      if (!moving || event.buttons || event.pointerType === 'touch') return;
      if (drowsy) setDrowsy(false);
      const box = event.currentTarget.getBoundingClientRect();
      const x = Math.max(-1, Math.min(1, (event.clientX - box.x) / box.width * 2 - 1));
      const y = Math.max(-1, Math.min(1, (event.clientY - box.y) / box.height * 2 - 1));
      event.currentTarget.style.setProperty('--companion-look-x', String(x));
      event.currentTarget.style.setProperty('--companion-look-y', String(y));
    }}
    onPointerLeave={event => resetLook(event.currentTarget)}
    onPointerDown={event => resetLook(event.currentTarget)}
    onBlur={event => resetLook(event.currentTarget)}
    onClick={() => {
      if (moving && mood === 'idle') { setDrowsy(false); setReaction(4); clearTimeout(reset.current); reset.current = setTimeout(() => setReaction(null), 2200); }
      onActivate();
    }}>
    <span className="companion-ground" aria-hidden="true" />
    <span ref={rig} className="companion-rig" aria-hidden="true" data-sheet-cell={tier.cell}>
      {leaving && leaving.frame !== frame && <Pose key={`leave-${leaving.key}`} frame={leaving.frame} style={style} tier={tier} leaving />}
      <Pose key={`pose-${frame}`} frame={frame} style={style} tier={tier} />
    </span>
    {(mood === 'thinking' || mood === 'working') && <span className="companion-thought" aria-hidden="true"><i /><i /><i /></span>}
    {dozing && <span className="companion-sleep" aria-hidden="true"><i>z</i><i>z</i><i>Z</i></span>}
    {mood === 'muted' && <span className="companion-badge is-muted" aria-hidden="true" title="마이크 꺼짐">
      <svg viewBox="0 0 24 24"><path d="M9 5a3 3 0 0 1 6 0v6M15 13.5A3 3 0 0 1 9 11V9M5 11a7 7 0 0 0 11.5 5.3M19 11a7 7 0 0 1-.6 2.8M12 18v3M4 4l16 16" /></svg>
    </span>}
    {mood === 'speaking' && <span className="companion-voice-waves" aria-hidden="true"><i /><i /><i /><i /><i /></span>}
  </button>;
}
