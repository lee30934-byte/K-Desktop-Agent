import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import VoiceCallPanel from "./VoiceCallPanel";
import DotBridgePanel from "./DotBridgePanel";
import AssistantAvatar, { AVATARS, AVATAR_MOODS, readAvatarPreference, type AvatarMood } from "./AssistantAvatar";
import type { VoiceView } from "../voiceSession";
import type { VoiceHandlers } from "../voiceControl";
import type { ChatMessage, Conversation } from "../types";
import "./AssistantWidget.css";

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
  const [avatar, setAvatar] = useState(readAvatarPreference);
  const [voiceView, setVoiceView] = useState<VoiceView | null>(null);
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
  const mood: AvatarMood = voiceTarget && voiceView
    ? voiceView.phase === 'error' ? 'error' : voiceView.phase === 'connecting' ? 'connecting'
    : voiceView.phase === 'connected' ? voiceView.speaking ? 'speaking' : voiceView.muted ? 'muted'
    : voiceView.listening ? 'listening' : voiceView.commandPending ? 'thinking' : 'listening'
    : running ? 'working' : 'idle' : running ? 'working' : 'idle';
  useEffect(() => {
    try { localStorage.setItem('kda_assistant_avatar_v1', JSON.stringify(avatar)); } catch { /* Session selection still works. */ }
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
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const box = panel.current!.getBoundingClientRect();
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: { x: box.x, y: box.y } };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
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
    if (!props.conversationId || voiceTarget) return;
    setVoiceTarget({ id: props.conversationId, title: props.conversations.find(c => c.id === props.conversationId)?.title ?? "현재 대화", following: true });
  }
  function telegram() {
    const id = readSetting("kda_telegram_conv_id");
    if (id && props.conversations.some(c => c.id === id)) props.onSelect(id);
    else props.onSettings();
  }
  const positionStyle = layout.position ? { left: layout.position.x, top: layout.position.y, right: "auto" } : undefined;
  return createPortal(<aside ref={panel} aria-label="K 비서" className={`assistant-widget${layout.minimized ? " is-minimized" : ""}${!layout.position && !layout.minimized ? " is-docked" : ""}`} style={positionStyle}>
    <div className="assistant-widget-handle" tabIndex={0} role="group" aria-label="비서 창 이동 · 방향키 이동 · Home 기본 위치"
      onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={keyMove}>
      <AssistantAvatar kind={avatar.kind} mood={mood} motion={avatar.motion} compact={layout.minimized} />
      <div className="assistant-widget-identity"><strong>K 비서</strong><span title={voiceTitle}><i className={running ? "working" : ""} />{voiceTarget ? `음성 · ${voiceTitle}` : running ? `${running}개 작업 진행 중` : "무엇을 도와드릴까요?"}</span>{!layout.minimized && <small className="assistant-widget-mood">{AVATAR_MOODS[mood]}</small>}</div>
      <button type="button" className="assistant-widget-icon" aria-label={layout.minimized ? "비서 창 펼치기" : "비서 창 최소화"}
        title={layout.minimized ? "펼치기" : "최소화"} onClick={() => setLayout(previous => ({ ...previous, minimized: !previous.minimized }))}>{layout.minimized ? "↗" : "−"}</button>
    </div>
    <div className="assistant-widget-body" hidden={layout.minimized}>
      <div className="assistant-widget-target">
        <span>{voiceTarget ? "통화 대상 대화" : "선택한 대화"}</span>
        <strong>{voiceTitle ?? selectedTitle}</strong>
        {targetChanged && <><small>다른 대화를 보고 있어도 통화 대상은 유지됩니다.</small><button type="button" onClick={() => props.onSelect(voiceTarget!.id)}>통화 대화로 이동 →</button></>}
      </div>
      <div className="assistant-widget-actions">
        <button type="button" disabled={!props.conversationId || !!voiceTarget} onClick={call}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3 2 6c0 8 8 16 16 16l3-3-5-4-3 2c-3-1-5-3-6-6l2-3Z" /></svg>{voiceTarget ? "음성통화 열림" : "통화하기"}</button>
        <button type="button" onClick={telegram}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 18-7-5 18-5-7-8-4Zm8 4 10-11" /></svg>Telegram</button>
      </div>
      <p className="assistant-widget-hint">말로 작업을 요청하고 진행 상황을 확인하세요.</p>
      <details className="assistant-avatar-options">
        <summary>아바타 꾸미기</summary>
        <div role="group" aria-label="아바타 선택" className="assistant-avatar-choices">{AVATARS.map(a =>
          <button type="button" key={a.id} aria-pressed={avatar.kind === a.id} onClick={() => setAvatar(p => ({ ...p, kind: a.id }))}>
            <strong>{a.name}</strong><small>{a.note}</small>
          </button>)}</div>
        <label><input type="checkbox" checked={avatar.motion} onChange={e => setAvatar(p => ({ ...p, motion: e.target.checked }))} />대기모션·리액션 움직임</label>
        <small>아바타를 누르면 인사·하트·갸웃·졸기 리액션을 보여줘요.</small>
      </details>
      {voiceTarget && <VoiceCallPanel conversationId={voiceTarget.id} title={voiceTarget.title} selectedId={props.conversationId} conversations={props.conversations} handlers={props.handlers}
        onView={setVoiceView}
        onTarget={(target, following) => setVoiceTarget(previous => previous ? { id: target?.id ?? '', title: target?.title ?? '대화 선택 필요', following } : null)}
        onClose={() => { setVoiceTarget(null); setVoiceView(null); }} />}
      <section className="assistant-widget-section">
        <h3>최근 답변 <span>현재 보고 있는 대화</span></h3>
        {answer && props.conversationId ? <button type="button" aria-label="최근 답변 열기" className="assistant-widget-result" onClick={() => props.onSelect(props.conversationId!)}>
          <span>{answer.content.replace(/[#*`]/g, "").slice(0, 110)}</span>
        </button> : <p className="assistant-widget-empty">아직 결과물이 없습니다.</p>}
      </section>
      <details className="assistant-widget-more">
        <summary>활동·연결 관리 <span>{running ? `${running}개 진행 중` : "더 보기"}</span></summary>
        <section className="assistant-widget-section">
        <h3>연결 컴퓨터</h3>
        <button type="button" className="assistant-widget-computer" onClick={props.onSettings}>
          <span className="assistant-widget-device" aria-hidden="true">▣</span>
          <span><strong>{readSetting("kda_telegram_pc_name", "이 컴퓨터")}</strong><small>{props.computerConnected ? "컴퓨터 도구 연결됨" : "컴퓨터 도구 연결 안 됨"}</small></span>
          <i className={`assistant-widget-dot${props.computerConnected ? " online" : ""}`} />
        </button>
      </section>
      <section className="assistant-widget-section">
        <h3>최근 활동</h3>
        {recent.length ? recent.map(c => <button type="button" key={c.id} className="assistant-widget-activity" onClick={() => props.onSelect(c.id)}>
          <i className={`assistant-widget-dot${props.runningIds.has(c.id) ? " online" : ""}`} /><span>{c.title}</span><small>{props.runningIds.has(c.id) ? "진행 중" : "대화"}</small>
        </button>) : <p className="assistant-widget-empty">아직 활동이 없습니다.</p>}
      </section>
      <div className="assistant-widget-connection"><DotBridgePanel conversationId={props.conversationId} handlers={props.handlers} /></div>
      <button type="button" className="assistant-widget-reset" onClick={() => setLayout(previous => ({ ...previous, position: null }))}>오른쪽 위로 되돌리기</button>
      </details>
    </div>
  </aside>, document.body);
}
