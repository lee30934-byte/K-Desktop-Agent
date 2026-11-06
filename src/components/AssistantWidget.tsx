import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import VoiceCallPanel from "./VoiceCallPanel";
import DotBridgePanel from "./DotBridgePanel";
import { AVATAR_MOODS, type AvatarMood } from "./AssistantAvatar";
import CompanionAvatar, { readCompanionPreference } from "./CompanionAvatar";
import CompanionVoice, { type CompanionVoiceHandle } from "./CompanionVoice";
import CompanionIcon from "./CompanionIcon";
import type { VoiceView } from "../voiceSession";
import type { VoiceHandlers } from "../voiceControl";
import type { ChatMessage, Conversation } from "../types";
import "./CompanionWidget.css";

const STORAGE = "kda_assistant_widget_v1";
type Position = { x: number; y: number };
type Layout = { position: Position | null; minimized: boolean };
function readLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) || "null");
    const p = saved?.position;
    return { minimized: saved?.minimized === true, position: Number.isFinite(p?.x) && Number.isFinite(p?.y) ? p : null };
  } catch { return { position: null, minimized: false }; }
}
function readSetting(key: string, fallback = "") {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
interface Props {
  conversationId: string | null;
  handlers: VoiceHandlers;
  conversations: Conversation[];
  messages: ChatMessage[];
  runningIds: Set<string>;
  computerConnected: boolean;
  onSelect: (id: string) => void;
  onSettings: () => void;
}

/** View-only layout state; minimizing never unmounts the DOT dispatcher. */
export default function AssistantWidget(props: Props) {
  const [layout, setLayout] = useState<Layout>(readLayout);
  const [avatar, setAvatar] = useState(readCompanionPreference);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'home' | 'appearance' | 'connections'>('home');
  const [reactionRequest, setReactionRequest] = useState<{ frame: number; key: number }>();
  const suppressClick = useRef(false);
  const voiceAppearance = useRef<CompanionVoiceHandle>(null);
  const [voiceView, setVoiceView] = useState<VoiceView | null>(null);
  const [previewView, setPreviewView] = useState<VoiceView | null>(null);
  const [voiceTarget, setVoiceTarget] = useState<{ id: string; title: string; following?: boolean } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; origin: Position } | null>(null);
  const recent = [...props.conversations].sort((a, b) => b.lastActive - a.lastActive).slice(0, 3);
  const answers = props.messages.filter(m => m.role === "assistant" && !m.streaming && m.content.trim());
  const answer = answers[answers.length - 1];
  const running = props.runningIds.size;
  const selectedTitle = props.conversations.find(c => c.id === props.conversationId)?.title ?? "대화를 선택하세요";
  const targetChanged = !!voiceTarget && !voiceTarget.following && props.conversationId !== voiceTarget.id;
  const voiceTitle = voiceTarget?.following ? selectedTitle : voiceTarget?.title;
  const previewActive = previewView?.phase === 'connecting' || previewView?.phase === 'connected';
  const mood: AvatarMood = !voiceTarget && previewActive ? previewView.phase === 'connecting' ? 'connecting' : previewView.speaking ? 'speaking' : 'idle' : voiceTarget && voiceView
    ? voiceView.phase === 'error' ? 'error' : voiceView.phase === 'connecting' ? 'connecting'
    : voiceView.phase === 'connected' ? voiceView.speaking ? 'speaking' : voiceView.muted ? 'muted'
    : voiceView.listening ? 'listening' : voiceView.commandPending ? 'thinking' : 'listening'
    : running ? 'working' : 'idle' : running ? 'working' : 'idle';
  useEffect(() => {
    try { localStorage.setItem('kda_companion_v2', JSON.stringify(avatar)); } catch { /* Session selection still works. */ }
  }, [avatar]);
  function bounded(p: Position): Position {
    const box = panel.current?.getBoundingClientRect();
    return { x: Math.max(8, Math.min(p.x, window.innerWidth - (box?.width ?? 300) - 8)),
      y: Math.max(8, Math.min(p.y, window.innerHeight - (box?.height ?? 48) - 8)) };
  }
  useLayoutEffect(() => {
    const fit = () => setLayout(previous => {
      if (!previous.position) return previous;
      const p = bounded(previous.position);
      return p.x === previous.position.x && p.y === previous.position.y ? previous : { ...previous, position: p };
    });
    const observer = new ResizeObserver(fit);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", fit);
    fit();
    return () => { observer.disconnect(); window.removeEventListener("resize", fit); };
  }, []);
  useLayoutEffect(() => {
    try { localStorage.setItem(STORAGE, JSON.stringify(layout)); } catch { /* Layout still works with storage disabled. */ }
  }, [layout]);
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || ((event.target as HTMLElement).closest("button") && !(event.target as HTMLElement).closest(".companion-avatar"))) return;
    suppressClick.current = false;
    const box = panel.current!.getBoundingClientRect();
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: { x: box.x, y: box.y } };

  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    if (!suppressClick.current && Math.hypot(event.clientX - d.x, event.clientY - d.y) < 6) return;
    suppressClick.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    const position = bounded({ x: d.origin.x + event.clientX - d.x, y: d.origin.y + event.clientY - d.y });
    setLayout(previous => ({ ...previous, position }));
  }
  function keyMove(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Home") { event.preventDefault(); setLayout(previous => ({ ...previous, position: null })); return; }
    const delta = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[event.key];
    if (!delta) return;
    event.preventDefault();
    const box = panel.current!.getBoundingClientRect(), step = event.shiftKey ? 40 : 12;
    setLayout(previous => ({ ...previous, position: bounded({ x: box.x + delta[0] * step, y: box.y + delta[1] * step }) }));
  }
  function call() {
    voiceAppearance.current?.stop();
    setOpen(true); setTab('home');
    if (!props.conversationId || voiceTarget) return;
    setVoiceTarget({ id: props.conversationId, title: props.conversations.find(c => c.id === props.conversationId)?.title ?? "현재 대화", following: true });
  }
  function telegram() {
    const id = readSetting("kda_telegram_conv_id");
    if (id && props.conversations.some(c => c.id === id)) props.onSelect(id);
    else props.onSettings();
  }
  const positionStyle = layout.position ? { left: layout.position.x, top: layout.position.y, right: "auto" } : undefined;
  const callStatus = voiceTarget
    ? voiceView?.phase === 'connected' ? '통화 중' : voiceView?.phase === 'error' ? '연결 오류'
    : voiceView?.phase === 'ended' ? '통화 종료' : '연결 중'
    : running ? '작업 중' : '곁에 있어요';
  const bubble = voiceTarget && voiceView
    ? voiceView.phase === 'error' ? voiceView.message : voiceView.speaking ? voiceView.lines.filter(l => l.role === 'assistant').slice(-1)[0]?.text || AVATAR_MOODS[mood] : AVATAR_MOODS[mood]
    : running ? `${running}개 작업을 진행하고 있어요.` : answer?.content.replace(/[#*`]/g, '').slice(0, 70) || '무엇을 도와드릴까요?';
  return createPortal(<aside ref={panel} aria-label="K 비서" className={`assistant-widget companion-widget${layout.minimized ? ' is-minimized' : ''}${open ? ' is-open' : ''}`} style={positionStyle}>
    <div className="companion-stage" tabIndex={0} role="group" aria-label="비서 창 이동 · 방향키 이동 · Home 기본 위치"
      onPointerDown={startDrag} onPointerMove={moveDrag}
      onPointerUp={() => { drag.current = null; setTimeout(() => { suppressClick.current = false; }, 0); }}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={keyMove}>
      {!layout.minimized && <div className="companion-bubble" role="status"><small><i data-state={mood} />K 비서<span>{callStatus}</span></small><p title={bubble}>{bubble}</p></div>}
      <div className="companion-figure">
        <CompanionAvatar mood={mood} motion={avatar.motion} style={avatar.style} compact={layout.minimized} expanded={open} request={reactionRequest}
        onActivate={() => { if (!suppressClick.current) setOpen(p => !p); }} />
        <div className="companion-controls" role="group" aria-label="아바타 빠른 조작">
          <button type="button" className={voiceTarget ? 'is-in-call' : undefined} title={voiceTarget ? '통화 조작 열기' : '통화하기'} aria-label={voiceTarget ? '통화 조작 열기' : '통화하기'} disabled={!props.conversationId && !voiceTarget} onClick={call}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H5a1 1 0 0 0-1 1c0 8 7 15 15 15a1 1 0 0 0 1-1v-3l-5-2-2 2c-3-1-5-3-6-6l2-2-1-4Z" /></svg></button>
          <button type="button" title="비서 메뉴" aria-label="비서 메뉴" aria-expanded={open} onClick={() => setOpen(p => !p)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" /></svg></button>
          <button type="button" title={layout.minimized ? '비서 창 펼치기' : '비서 창 최소화'} aria-label={layout.minimized ? '비서 창 펼치기' : '비서 창 최소화'} onClick={() => { setOpen(false); setLayout(p => ({ ...p, minimized: !p.minimized })); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true">{layout.minimized ? <path d="M7 17 17 7M7 7h10v10" /> : <path d="M6 12h12" />}</svg></button>
        </div>
      </div>
      <span className="companion-name">{AVATAR_MOODS[mood]}</span>
    </div>
    <div className="companion-popover" hidden={!open}>
      <header className="companion-menu-header"><span className="companion-brand-mark" aria-hidden="true"><CompanionIcon name="style" /></span><div><strong>K 비서 <span>나의 작은 동반자</span></strong><small>{voiceTitle ?? selectedTitle}</small></div><button type="button" aria-label="비서 기능 접기" onClick={() => setOpen(false)}><CompanionIcon name="close" /></button></header>
      <nav aria-label="비서 기능" className="companion-tabs">
        <button type="button" aria-pressed={tab === 'home'} onClick={() => setTab('home')}><CompanionIcon name="chat" />대화·작업</button>
        <button type="button" aria-pressed={tab === 'appearance'} onClick={() => setTab('appearance')}><CompanionIcon name="style" />꾸미기</button>
        <button type="button" aria-pressed={tab === 'connections'} onClick={() => setTab('connections')}><CompanionIcon name="link" />연결</button>
      </nav>
      <div hidden={tab !== 'home'} className="companion-home">
        {targetChanged && <button type="button" className="companion-link" onClick={() => props.onSelect(voiceTarget!.id)}>통화 대화로 이동 →</button>}
        {!voiceTarget && <div className="companion-primary-actions"><button type="button" disabled={!props.conversationId} onClick={call}><CompanionIcon name="wave" />음성으로 이야기하기<CompanionIcon name="arrow" /></button><button type="button" onClick={telegram}>Telegram</button></div>}
        {voiceTarget && <VoiceCallPanel voice={avatar.voice} effect={avatar.effect} conversationId={voiceTarget.id} title={voiceTarget.title} selectedId={props.conversationId} conversations={props.conversations} handlers={props.handlers}
          onView={setVoiceView} onTarget={(target, following) => setVoiceTarget(previous => previous ? { id: target?.id ?? '', title: target?.title ?? '대화 선택 필요', following } : null)}
          onClose={() => { setVoiceTarget(null); setVoiceView(null); }} />}
        <section className="companion-recent"><h3>최근 답변</h3>{answer && props.conversationId ? <button type="button" aria-label="최근 답변 열기" onClick={() => props.onSelect(props.conversationId!)}>{answer.content.replace(/[#*`]/g, '').slice(0, 140)}</button> : <p>대화를 시작하면 여기서 이어볼 수 있어요.</p>}</section>
        <section className="companion-recent"><h3>대화 이동</h3>{recent.map(c => <button type="button" key={c.id} onClick={() => props.onSelect(c.id)}><i className={props.runningIds.has(c.id) ? 'is-working' : ''} />{c.title}<span>→</span></button>)}</section>
      </div>
      <section className="companion-appearance" hidden={tab !== 'appearance'}>
        <div className="companion-section-heading"><div><h3>나에게 맞는 비서</h3><p>색과 목소리로, 더 가깝게.</p></div><span className="companion-saved"><i />자동 저장</span></div>
        <div className="companion-field-heading"><strong>컬러</strong><span>세라믹 컬렉션</span></div>
        <div className="companion-swatches" role="group" aria-label="비서 색상">{([{ id: 'mint', name: '민트 세라믹' }, { id: 'pearl', name: '펄 세라믹' }, { id: 'rose', name: '로즈 세라믹' }] as const).map(a => <button type="button" key={a.id} className={`swatch-${a.id}`} aria-pressed={avatar.style === a.id} onClick={() => setAvatar(p => ({ ...p, style: a.id }))}><i />{a.name}</button>)}</div>
        <CompanionVoice ref={voiceAppearance} voice={avatar.voice} effect={avatar.effect} onEffectChange={effect => setAvatar(p => ({ ...p, effect }))} callEffectWarning={voiceView?.effectWarning} onChange={voice => setAvatar(p => ({ ...p, voice }))} onView={setPreviewView} enabled={open && tab === 'appearance' && !layout.minimized} callActive={!!voiceTarget && (!voiceView || voiceView.phase === 'connecting' || voiceView.phase === 'connected')} />
        <div className="companion-motion-card"><label className="companion-motion-toggle"><span><strong>움직임과 리액션</strong><small>작은 움직임으로 마음을 전해요</small></span><input type="checkbox" aria-label="대기모션·리액션 움직임" checked={avatar.motion} onChange={e => setAvatar(p => ({ ...p, motion: e.target.checked }))} /><i className="companion-switch" aria-hidden="true" /></label>
        <div className="companion-reactions" role="group" aria-label="비서 리액션">{([{ frame: 4, name: '인사', icon: 'wave' }, { frame: 5, name: '기쁨', icon: 'smile' }, { frame: 2, name: '갸웃', icon: 'tilt' }, { frame: 6, name: '졸기', icon: 'moon' }] as const).map(r => <button type="button" key={r.frame} disabled={mood !== 'idle' || !avatar.motion} onClick={() => setReactionRequest(p => ({ frame: r.frame, key: (p?.key ?? 0) + 1 }))}><CompanionIcon name={r.icon} />{r.name}</button>)}</div></div>
        <footer className="companion-appearance-footer"><small>캐릭터를 끌어 원하는 곳으로</small><button type="button" className="companion-link" onClick={() => { setLayout(p => ({ ...p, position: null })); }}>기본 위치로</button></footer>
      </section>
      <section className="companion-connections" hidden={tab !== 'connections'}>
        <button type="button" className="companion-device" onClick={props.onSettings}><i className={props.computerConnected ? 'is-online' : ''} /><span><strong>{readSetting('kda_telegram_pc_name', '이 컴퓨터')}</strong><small>{props.computerConnected ? '컴퓨터 도구 연결됨' : '컴퓨터 도구 연결 안 됨'}</small></span><span>설정 →</span></button>
        <button type="button" className="companion-link" onClick={telegram}>Telegram 대화 열기 →</button>
        <DotBridgePanel conversationId={props.conversationId} handlers={props.handlers} />
      </section>
    </div>
  </aside>, document.body);
}
