import { useEffect, useRef, useLayoutEffect, useState } from "react";
import CornerBrackets from "./CornerBrackets";
import Message from "./Message";
import Composer from "./Composer";
import type { ChatMessage, ConnectionStatus, FileAttachment } from "../types";

interface MainChatProps {
  messages: ChatMessage[];
  status: ConnectionStatus;
  isStreaming: boolean;
  onSendMessage: (text: string, files?: FileAttachment[]) => void;
  onInterrupt: () => void;
}

export default function MainChat({
  messages,
  status,
  isStreaming,
  onSendMessage,
  onInterrupt,
}: MainChatProps) {
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const lastMessageCountRef = useRef(0);
  const [toolPanelOpen, setToolPanelOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");

  // 대화 내용 복사 함수
  const handleCopyChat = async () => {
    const visibleMessages = messages.filter((msg) => msg.role !== "tool");

    if (visibleMessages.length === 0) return;

    const chatText = visibleMessages
      .map((msg) => {
        const role = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "System";
        const time = new Date(msg.timestamp).toLocaleString("ko-KR");
        return `[${role}] (${time})\n${msg.content}`;
      })
      .join("\n\n---\n\n");

    try {
      await navigator.clipboard.writeText(chatText);
      setCopyStatus("copied");
      setTimeout(() => setCopyStatus("idle"), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  // 스크롤 함수
  const scrollToBottom = () => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  };

  // 메시지가 추가되거나 스트리밍 중일 때 스크롤
  useLayoutEffect(() => {
    scrollToBottom();
  }, [messages]);

  // 스트리밍 중에는 주기적으로 스크롤 (메시지 내용 업데이트 감지)
  useEffect(() => {
    if (!isStreaming) return;

    const interval = setInterval(scrollToBottom, 100);
    return () => clearInterval(interval);
  }, [isStreaming]);

  // 메시지 개수가 바뀔 때 스크롤
  useEffect(() => {
    if (messages.length !== lastMessageCountRef.current) {
      lastMessageCountRef.current = messages.length;
      scrollToBottom();
    }
  }, [messages.length]);

  return (
    <section className="main-chat">
      {/* 탑 헤더 */}
      <div className="main-header">
        <CornerBrackets corners={["tl", "tr"]} size={14} />
        <div>
          <div className="eyebrow">Active Session</div>
          <div className="main-title display">SIGNAL ROUTING HUB</div>
        </div>
        <div className="main-header-right">
          <button
            className={`copy-chat-btn ${copyStatus === "copied" ? "copied" : ""}`}
            onClick={handleCopyChat}
            title="대화 내용 복사"
          >
            {copyStatus === "copied" ? "✓ 복사됨" : "📋 복사"}
          </button>
          <StatusBadge status={status} />
        </div>
      </div>

      {/* 메시지 영역 */}
      <div className="main-body">
        <div className="messages" ref={messagesContainerRef}>
          {(() => {
            // Tool 메시지 필터링 - user/assistant/system만 표시
            const visibleMessages = messages.filter(
              (msg) => msg.role !== "tool"
            );

            if (visibleMessages.length === 0) {
              return <EmptyState />;
            }

            return (
              <>
                {/* 메시지가 적을 때 위쪽 빈 공간 채우기 */}
                <div className="messages-spacer" />
                {visibleMessages.map((msg) => (
                  <Message key={msg.id} message={msg} />
                ))}
              </>
            );
          })()}
        </div>

        {/* Tool 로그 패널 */}
        <ToolLogPanel
          messages={messages}
          isOpen={toolPanelOpen}
          onToggle={() => setToolPanelOpen(!toolPanelOpen)}
        />

        {/* 입력창 */}
        <Composer
          disabled={status !== "connected"}
          isStreaming={isStreaming}
          onSubmit={onSendMessage}
          onInterrupt={onInterrupt}
        />
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: ConnectionStatus }) {
  const label: Record<ConnectionStatus, string> = {
    connecting: "CONNECTING",
    connected: "LIVE",
    disconnected: "OFFLINE",
    error: "ERROR",
  };

  return (
    <div className={`status-badge status-badge-${status}`}>
      <div className="status-dot" />
      <span className="mono">{label[status]}</span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-grid" />
      <div className="empty-content">
        <div className="eyebrow">Ready</div>
        <div className="empty-title display">무엇을 도와드릴까요?</div>
        <div className="empty-hint">
          예시: "내 화면 캡처해서 뭐 하고 있는지 설명해줘"
        </div>
        <div className="empty-hint">
          예시: "다운로드 폴더 정리해줘 (먼저 미리보기)"
        </div>
        <div className="empty-hint" style={{ marginTop: "12px", opacity: 0.7 }}>
          💡 파일을 드래그하거나 📎 버튼으로 첨부 가능
        </div>
      </div>
    </div>
  );
}

// Tool 로그 패널 컴포넌트
function ToolLogPanel({
  messages,
  isOpen,
  onToggle,
}: {
  messages: ChatMessage[];
  isOpen: boolean;
  onToggle: () => void;
}) {
  const toolMessages = messages.filter(
    (msg): msg is Extract<ChatMessage, { role: "tool" }> => msg.role === "tool"
  );

  const pendingCount = toolMessages.filter((m) => m.status === "pending").length;
  const recentTools = toolMessages.slice(-10); // 최근 10개만

  if (toolMessages.length === 0) return null;

  return (
    <div className={`tool-log-panel ${isOpen ? "open" : ""}`}>
      <button className="tool-log-header" onClick={onToggle}>
        {pendingCount > 0 ? (
          <span className="tool-log-spinner" />
        ) : (
          <span className="tool-log-icon">{isOpen ? "▼" : "▶"}</span>
        )}
        <span className="mono">
          Tool 로그 ({toolMessages.length})
          {pendingCount > 0 && (
            <span className="tool-log-pending"> • {pendingCount}개 실행중</span>
          )}
        </span>
      </button>
      {isOpen && (
        <div className="tool-log-content">
          {recentTools.map((tool) => (
            <div
              key={tool.id}
              className={`tool-log-item tool-log-${tool.status}`}
            >
              <span className={`tool-log-status tool-log-status-${tool.status}`}>
                {tool.status === "pending" ? "⏳" : tool.status === "success" ? "✓" : "✗"}
              </span>
              <span className="tool-log-name mono">{tool.toolName}</span>
              <span className="tool-log-time mono">
                {new Date(tool.timestamp).toLocaleTimeString("ko-KR", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: false,
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
