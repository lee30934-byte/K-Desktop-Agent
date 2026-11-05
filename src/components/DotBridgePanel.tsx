import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DotDispatcher, type DotHandlers, type DotRequest } from "../dotBridge";

interface Info { enabled: boolean; session: string | null; conversationId: string | null; root: string; adapterPath: string | null }
export default function DotBridgePanel({ conversationId, handlers }: { conversationId: string | null; handlers: DotHandlers }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState("");
  const latest = useRef(handlers); latest.current = handlers;
  const dispatcher = useRef<DotDispatcher>();
  if (!dispatcher.current) dispatcher.current = new DotDispatcher({
    canSend: r => latest.current.canSend?.(r) ?? true,
    status: id => latest.current.status(id), send: (id, text, mode) => latest.current.send(id, text, mode), stop: id => latest.current.stop(id),
  }, async r => {
    const state = await invoke<Info>("dot_bridge_info");
    // Rust reply also checks the session. Poll claim carries the session into the closure.
    return state.enabled && state.session === r.session && state.conversationId === r.conversationId;
  });
  useEffect(() => {
    let closed = false, polling = false;
    void invoke<Info>("dot_bridge_info").then(v => { if (!closed) setInfo(v); }).catch(e => { if (!closed) setError(String(e)); });
    const timer = window.setInterval(() => {
      if (polling) return;
      polling = true;
      void invoke<DotRequest[]>("dot_bridge_poll").then(requests => {
        if (closed) return;
        for (const r of requests) {
          const reply = (result: unknown) => invoke("dot_bridge_reply", { session: r.session, id: r.id, result });
          let outcome = "상태 조회";
          const report = (result: unknown) => {
            const state = (result as { state?: string })?.state;
            outcome = ({ submitted: "전달됨", stopped: "정지 확인", failed: "실패", cancelled: "취소됨", unknown: "결과 미확인" } as Record<string, string>)[state ?? ""] ?? "상태 조회";
            return reply(result);
          };
          void dispatcher.current!.dispatch(r).then(report, e => {
            if (!closed) setError(String(e));
            return report({ state: "failed", error: String(e) });
          })
            .then(() => { if (!closed) setLast(`${outcome} · ${r.id.slice(0, 8)}`); })
            .catch(e => { if (!closed) setError(String(e)); });
        }
      }).catch(e => { if (!closed) setError(String(e)); }).finally(() => { polling = false; });
    }, 500);
    return () => { closed = true; window.clearInterval(timer); };
  }, []);
  async function pair(id: string | null) {
    setBusy(true); setError("");
    try { setInfo(await invoke<Info>("dot_bridge_pair", { conversationId: id })); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <details style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-subtle)", fontSize: 12 }}>
    <summary>DOT 연결 · {info?.enabled ? "켜짐" : "꺼짐"}</summary>
    <p>ChatGPT DOT이 지정한 대화에 지시를 보내고 결과를 조회합니다. 음성통화는 ChatGPT에서 사용합니다.</p>
    <button disabled={busy || !conversationId || info === null || info.enabled} onClick={() => void pair(conversationId)}>현재 대화 연결</button>{" "}
    <button disabled={busy || !info?.enabled} onClick={() => void pair(null)}>연결 끄기</button>
    {info?.enabled && <p>연결 대화: {info.conversationId} · 탭을 바꿔도 연결 대상은 유지됩니다. 앱 재시작 후 다시 연결하세요.</p>}
    {info?.enabled && <><p>DOT의 연결 PC 작업에 아래 상태 조회 명령을 전달하세요.</p>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{`node "${info.adapterPath}" status --root "${info.root}"`}</pre>
      <p>연결 끄기는 새 명령을 차단합니다. 실행 중인 작업은 별도로 정지하세요.</p></>}
    {info && <p>연결 경로: <code style={{ overflowWrap: "anywhere" }}>{info.root}</code></p>}
    {last && <p role="status">최근 요청: {last}</p>}
    {error && <p role="alert">DOT 연결 오류: {error}</p>}
  </details>;
}
