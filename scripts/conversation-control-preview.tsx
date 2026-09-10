// Static, isolated UI fixture. It imports production components and never contacts Tauri or an engine.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Composer from "../src/components/Composer";
import TaskActivityPanel from "../src/components/TaskActivityPanel";
import { ConversationControl, type SendMode } from "../src/conversationControl";
import "../src/index.css";
import "../src/App.css";
const control = new ConversationControl();
const conversations = [{ id: "a", title: "KDA 기능 구현" }, { id: "b", title: "회귀 테스트 검토" }, { id: "c", title: "릴리스 문서 정리" }];
for (const { id } of conversations) control.claim(id, id + "-turn");
const calls: { conversationId: string; text: string; mode?: SendMode }[] = [];
function Preview() {
  const [id, setId] = useState("a"); const [, update] = useState(0);
  const paint = () => update(n => n + 1);
  (window as any).preview = { calls, stop: () => { control.stopping(id); paint(); } };
  const queued = control.peek(id);
  return <div style={{ maxWidth: 1100, margin: "55px auto", padding: 24 }}>
    <h1 style={{ fontSize: 22, marginBottom: 16 }}>KDA · 대화별 작업 제어</h1>
    <nav style={{ display: "flex", gap: 12, marginBottom: 18 }}>{conversations.map(c => <button key={c.id} onClick={() => setId(c.id)} aria-pressed={id === c.id}>{c.title}</button>)}</nav>
    <TaskActivityPanel runs={[...control.runs.values()]} queues={control.queues} paused={control.paused} allPaused={control.allPaused} conversations={conversations}
      onSelect={setId} onStop={target => { control.stopping(target); paint(); }} onStopAll={() => { control.allPaused = true; for (const c of conversations) { control.pause(c.id); control.stopping(c.id); } paint(); }} onResume={() => { control.resume(id); paint(); }} onResumeAutomation={() => { control.allPaused = false; paint(); }} />
    <div className="message message-assistant" style={{ minHeight: 180, padding: 24 }}>
      대화별 실행 상태를 확인하고 있습니다. 추가 상황이나 방향 변경은 아래 입력창에서 전달할 수 있습니다.
    </div>
    <Composer key={id} conversationId={id} isStreaming={control.isActive(id)} isStopping={control.runs.get(id)?.state === "stopping"}
      queuedCount={control.queues.get(id)?.length ?? 0} queuePaused={control.paused.has(id)}
      queuedSend={queued ? { text: queued.text, fileCount: 0, queuedAt: queued.queuedAt } : null}
      onSubmit={async (text, files, mode) => { calls.push({ conversationId: id, text, mode }); control.enqueue({ id: crypto.randomUUID(), conversationId: id, text, files, mode: mode ?? "queue", queuedAt: Date.now() }); paint(); }}
      onInterrupt={() => { control.stopping(id); paint(); }} onHardStop={() => { control.allPaused = true; paint(); }}
      onCancelQueuedSend={() => { if (queued) control.remove(id, queued.id); paint(); }} onFlushQueueNow={() => { control.stopping(id); paint(); }} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
