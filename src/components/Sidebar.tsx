import CornerBrackets from "./CornerBrackets";
import type { Conversation } from "../types";

interface SidebarProps {
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation?: (id: string) => void;
  mcpConnected?: boolean;
  onOpenSettings?: () => void;
}

export default function Sidebar({
  conversations,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  mcpConnected = false,
  onOpenSettings,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      {/* 브랜드 헤더 */}
      <div className="sidebar-brand">
        <div className="brand-logo">
          <svg
            width="28"
            height="28"
            viewBox="0 0 32 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M16 2 L29 9 L29 23 L16 30 L3 23 L3 9 Z"
              stroke="var(--accent)"
              strokeWidth="1.5"
              fill="rgba(79, 232, 225, 0.08)"
            />
            <path
              d="M11 10 L11 22 M11 16 L19 10 M11 16 L19 22"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="square"
              fill="none"
            />
          </svg>
        </div>
        <div className="brand-text">
          <div className="brand-name">K.AGENT</div>
          <div className="brand-sub">PERSONAL CONSOLE // V0.1.0</div>
        </div>
      </div>

      {/* 새 대화 버튼 */}
      <button className="new-chat-btn" onClick={onNewConversation}>
        <span className="plus">+</span>
        <span>New Chat</span>
      </button>

      {/* 대화 목록 */}
      <div className="sidebar-section">
        <div className="eyebrow section-label">Conversations</div>
        <div className="conv-list">
          {conversations.length === 0 ? (
            <div className="conv-empty">대화 없음</div>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                className={`conv-item ${c.id === activeConversationId ? "active" : ""}`}
              >
                <button
                  className="conv-item-main"
                  onClick={() => onSelectConversation(c.id)}
                >
                  <div className="conv-dot" />
                  <div className="conv-content">
                    <div className="conv-title">{c.title}</div>
                    <div className="conv-meta mono">
                      {c.messageCount} msg · {formatRelative(c.lastActive)}
                    </div>
                  </div>
                </button>
                {onDeleteConversation && (
                  <button
                    className="conv-delete-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteConversation(c.id);
                    }}
                    title="대화 삭제"
                  >
                    ×
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* 툴 섹션 */}
      <div className="sidebar-section sidebar-bottom">
        <div className="eyebrow section-label">Tools</div>
        <button className="tool-item" onClick={onOpenSettings}>
          <span className="tool-icon">⚙</span>
          <span>Settings</span>
        </button>
        <button className="tool-item" title="Coming soon">
          <span className="tool-icon">⌘</span>
          <span>Shortcuts</span>
        </button>
      </div>

      {/* 하단 MCP 상태 */}
      <div className="sidebar-footer">
        <div className={`status-dot ${mcpConnected ? "status-dot-live" : "status-dot-off"}`} />
        <span className="mono">
          K-PERSONAL · {mcpConnected ? "connected" : "offline"}
        </span>
      </div>

      <CornerBrackets corners={["tl", "bl"]} size={12} />
    </aside>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
