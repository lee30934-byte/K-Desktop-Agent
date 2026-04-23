import { useState, useEffect, useRef, FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";

interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  // tool 관련 메타
  toolName?: string;
  toolInput?: unknown;
}

// Sidecar → Frontend 이벤트 타입 (Rust가 중계)
type SidecarEvent =
  | { type: "ready"; version: string }
  | { type: "assistant_delta"; id: string; text: string }
  | {
      type: "tool_use";
      id: string;
      tool_id: string;
      name: string;
      input: unknown;
    }
  | { type: "tool_result"; id: string; tool_id: string; output: string }
  | { type: "done"; id: string; usage?: unknown }
  | { type: "error"; id?: string; message: string }
  | { type: "log"; level: string; message: string }
  | { type: "pong" };

function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "system",
      content:
        "K Desktop Agent v0.1.0 (Phase 1). Claude에 연결되어 있습니다. 무엇을 도와드릴까요?",
      timestamp: Date.now(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null);
  const [sidecarReady, setSidecarReady] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // sidecar-event 수신 설정
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    (async () => {
      unlisten = await listen<SidecarEvent>("sidecar-event", (ev) => {
        const data = ev.payload;
        handleSidecarEvent(data);
      });
    })();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // 자동 스크롤
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSidecarEvent(ev: SidecarEvent) {
    switch (ev.type) {
      case "ready":
        setSidecarReady(true);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: `Sidecar 준비 완료 (v${ev.version})`,
            timestamp: Date.now(),
          },
        ]);
        break;

      case "assistant_delta":
        // 같은 id의 assistant 메시지가 있으면 이어붙이고, 없으면 새로 추가
        setMessages((prev) => {
          const existing = prev.find(
            (m) => m.id === ev.id && m.role === "assistant"
          );
          if (existing) {
            return prev.map((m) =>
              m.id === ev.id && m.role === "assistant"
                ? { ...m, content: m.content + ev.text }
                : m
            );
          }
          return [
            ...prev,
            {
              id: ev.id,
              role: "assistant",
              content: ev.text,
              timestamp: Date.now(),
            },
          ];
        });
        break;

      case "tool_use":
        setMessages((prev) => [
          ...prev,
          {
            id: `${ev.id}-tool-${ev.tool_id}`,
            role: "tool",
            content: `🔧 도구 호출: ${ev.name}`,
            toolName: ev.name,
            toolInput: ev.input,
            timestamp: Date.now(),
          },
        ]);
        break;

      case "tool_result":
        setMessages((prev) =>
          prev.map((m) =>
            m.id === `${ev.id}-tool-${ev.tool_id}`
              ? { ...m, content: `✅ ${m.content}\n\n${ev.output}` }
              : m
          )
        );
        break;

      case "done":
        setIsStreaming(false);
        setCurrentTurnId(null);
        break;

      case "error":
        setIsStreaming(false);
        setCurrentTurnId(null);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: `❌ 오류: ${ev.message}`,
            timestamp: Date.now(),
          },
        ]);
        break;

      case "log":
        // 개발 중에만 콘솔로
        console.log(`[sidecar:${ev.level}]`, ev.message);
        break;

      case "pong":
        break;
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!input.trim() || isStreaming || !sidecarReady) return;

    const turnId = crypto.randomUUID();
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: input.trim(),
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setCurrentTurnId(turnId);
    setInput("");
    setIsStreaming(true);

    try {
      await invoke("send_message", {
        message: userMsg.content,
        id: turnId,
      });
    } catch (err) {
      setIsStreaming(false);
      setCurrentTurnId(null);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `❌ 전송 실패: ${String(err)}`,
          timestamp: Date.now(),
        },
      ]);
    }
  }

  async function handleInterrupt() {
    if (!currentTurnId) return;
    try {
      await invoke("interrupt", { id: currentTurnId });
    } catch (err) {
      console.error("interrupt failed:", err);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>K Desktop Agent</h1>
        <span className="subtitle">
          v0.1.0 · {sidecarReady ? "연결됨" : "연결 중..."}
        </span>
      </header>

      <main className="chat">
        <div className="messages">
          {messages.map((msg) => (
            <div key={msg.id} className={`message message-${msg.role}`}>
              <div className="message-role">{roleLabel(msg.role)}</div>
              <div className="message-content">{msg.content}</div>
            </div>
          ))}
          {isStreaming && (
            <div className="message message-assistant">
              <div className="message-role">Assistant</div>
              <div className="message-content typing">응답 중...</div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e as unknown as FormEvent);
              }
            }}
            placeholder={
              sidecarReady
                ? "메시지를 입력하세요. Enter로 전송, Shift+Enter로 줄바꿈."
                : "Sidecar 연결 대기 중..."
            }
            rows={3}
            disabled={isStreaming || !sidecarReady}
          />
          {isStreaming ? (
            <button type="button" onClick={handleInterrupt} className="stop-btn">
              중단
            </button>
          ) : (
            <button type="submit" disabled={!input.trim() || !sidecarReady}>
              전송
            </button>
          )}
        </form>
      </main>
    </div>
  );
}

function roleLabel(role: Message["role"]): string {
  switch (role) {
    case "user":
      return "You";
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    case "tool":
      return "Tool";
  }
}

export default App;
