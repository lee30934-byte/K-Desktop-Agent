import { useEffect, useState, useRef, useCallback } from "react";
import { QUICK_PROMPTS } from "../utils/quickPrompts";

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  icon?: string;
  action: () => void;
  category: "action" | "quick" | "settings";
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onSendMessage: (msg: string) => void;
  onOpenSettings: () => void;
  onNewChat: () => void;
}

export default function CommandPalette({
  open,
  onClose,
  onSendMessage,
  onOpenSettings,
  onNewChat,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 빠른 명령 목록
  const commands: Command[] = [
    // Actions
    {
      id: "new-chat",
      label: "새 대화 시작",
      icon: "💬",
      shortcut: "Ctrl+N",
      action: () => { onNewChat(); onClose(); },
      category: "action",
    },
    {
      id: "settings",
      label: "설정 열기",
      icon: "⚙️",
      shortcut: "Ctrl+,",
      action: () => { onOpenSettings(); onClose(); },
      category: "settings",
    },
    // Quick prompts — 빈 화면 제안 카드와 같은 목록 (src/utils/quickPrompts.ts)
    ...QUICK_PROMPTS.map((p): Command => ({
      id: p.id,
      label: p.label,
      icon: p.icon,
      action: () => { onSendMessage(p.prompt); onClose(); },
      category: "quick",
    })),
  ];

  // 필터링된 명령
  const filteredCommands = commands.filter((cmd) =>
    cmd.label.toLowerCase().includes(query.toLowerCase())
  );

  // 선택 인덱스 보정
  useEffect(() => {
    if (selectedIndex >= filteredCommands.length) {
      setSelectedIndex(Math.max(0, filteredCommands.length - 1));
    }
  }, [filteredCommands.length, selectedIndex]);

  // 열릴 때 포커스 및 리셋
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // 키보드 네비게이션
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (filteredCommands[selectedIndex]) {
            filteredCommands[selectedIndex].action();
          } else if (query.trim()) {
            // 검색어를 바로 메시지로 전송
            onSendMessage(query.trim());
            onClose();
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filteredCommands, selectedIndex, query, onSendMessage, onClose]
  );

  if (!open) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <div className="command-palette-header">
          <span className="command-palette-icon">⌘</span>
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder="명령 또는 빠른 프롬프트 검색..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span className="command-palette-hint mono">ESC</span>
        </div>

        <div className="command-palette-list">
          {filteredCommands.length === 0 ? (
            <div className="command-palette-empty">
              <span>"{query}" 로 바로 메시지 전송 (Enter)</span>
            </div>
          ) : (
            filteredCommands.map((cmd, idx) => (
              <div
                key={cmd.id}
                className={`command-palette-item ${
                  idx === selectedIndex ? "selected" : ""
                }`}
                onClick={() => cmd.action()}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <span className="command-item-icon">{cmd.icon}</span>
                <span className="command-item-label">{cmd.label}</span>
                {cmd.shortcut && (
                  <span className="command-item-shortcut mono">{cmd.shortcut}</span>
                )}
              </div>
            ))
          )}
        </div>

        <div className="command-palette-footer">
          <span className="mono">↑↓ 이동</span>
          <span className="mono">Enter 실행</span>
          <span className="mono">Esc 닫기</span>
        </div>
      </div>
    </div>
  );
}
