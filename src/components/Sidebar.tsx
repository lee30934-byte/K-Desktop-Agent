import { save, open } from "@tauri-apps/plugin-dialog";
import CornerBrackets from "./CornerBrackets";
import type { Conversation } from "../types";
import {
  exportConversation,
  exportAllConversations,
  importConversation,
  importAllConversations,
  type ExportedConversation,
  type ExportedBackup,
} from "../db";

interface SidebarProps {
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation?: (id: string) => void;
  onRefreshConversations?: () => void;
  mcpConnected?: boolean;
  onOpenSettings?: () => void;
}

export default function Sidebar({
  conversations,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onRefreshConversations,
  mcpConnected = false,
  onOpenSettings,
}: SidebarProps) {
  // 현재 대화 내보내기
  const handleExportCurrent = async () => {
    if (!activeConversationId) {
      alert("내보낼 대화를 선택하세요.");
      return;
    }

    const data = await exportConversation(activeConversationId);
    if (!data) {
      alert("대화를 찾을 수 없습니다.");
      return;
    }

    const filePath = await save({
      defaultPath: `conversation_${data.conversation.title.replace(/[^a-zA-Z0-9가-힣]/g, "_")}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (filePath) {
      const fs = await import("@tauri-apps/plugin-fs");
      await fs.writeTextFile(filePath, JSON.stringify(data, null, 2));
      alert(`내보내기 완료: ${filePath}`);
    }
  };

  // 전체 백업 내보내기
  const handleExportAll = async () => {
    const data = await exportAllConversations();

    const filePath = await save({
      defaultPath: `k_agent_backup_${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (filePath) {
      const fs = await import("@tauri-apps/plugin-fs");
      await fs.writeTextFile(filePath, JSON.stringify(data, null, 2));
      alert(`전체 백업 완료: ${data.conversations.length}개 대화`);
    }
  };

  // 대화 가져오기
  const handleImport = async () => {
    const filePath = await open({
      filters: [{ name: "JSON", extensions: ["json"] }],
      multiple: false,
    });

    if (!filePath) return;

    try {
      const fs = await import("@tauri-apps/plugin-fs");
      const content = await fs.readTextFile(filePath as string);
      const data = JSON.parse(content);

      // 전체 백업인지 단일 대화인지 판별
      if (data.conversations && Array.isArray(data.conversations)) {
        // 전체 백업
        const backup = data as ExportedBackup;
        const imported = await importAllConversations(backup);
        alert(`${imported}개 대화 가져오기 완료!`);
      } else if (data.conversation && data.messages) {
        // 단일 대화
        const conv = data as ExportedConversation;
        await importConversation(conv, true);
        alert(`"${conv.conversation.title}" 가져오기 완료!`);
      } else {
        alert("유효하지 않은 백업 파일입니다.");
        return;
      }

      // 대화 목록 새로고침
      onRefreshConversations?.();
    } catch (e) {
      console.error("Import error:", e);
      alert("가져오기 실패: " + (e as Error).message);
    }
  };

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

      {/* 백업/복구 섹션 */}
      <div className="sidebar-section">
        <div className="eyebrow section-label">Backup</div>
        <button className="tool-item" onClick={handleExportCurrent} title="현재 대화 내보내기">
          <span className="tool-icon">📤</span>
          <span>Export Chat</span>
        </button>
        <button className="tool-item" onClick={handleExportAll} title="전체 백업">
          <span className="tool-icon">💾</span>
          <span>Backup All</span>
        </button>
        <button className="tool-item" onClick={handleImport} title="가져오기">
          <span className="tool-icon">📥</span>
          <span>Import</span>
        </button>
      </div>

      {/* 툴 섹션 */}
      <div className="sidebar-section sidebar-bottom">
        <div className="eyebrow section-label">Tools</div>
        <button className="tool-item" onClick={onOpenSettings}>
          <span className="tool-icon">⚙</span>
          <span>Settings</span>
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
