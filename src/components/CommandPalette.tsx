import { useEffect, useState, useRef, useCallback } from "react";

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
    // Quick prompts
    {
      id: "screenshot",
      label: "현재 화면 스크린샷 분석",
      icon: "📷",
      action: () => { onSendMessage("현재 화면을 스크린샷으로 캡처해서 분석해줘"); onClose(); },
      category: "quick",
    },
    {
      id: "todo-list",
      label: "할 일 목록 보기",
      icon: "✅",
      action: () => { onSendMessage("할 일 목록 보여줘"); onClose(); },
      category: "quick",
    },
    {
      id: "notes",
      label: "메모 목록 보기",
      icon: "📝",
      action: () => { onSendMessage("메모 목록 보여줘"); onClose(); },
      category: "quick",
    },
    {
      id: "habits",
      label: "습관 체크 현황",
      icon: "📊",
      action: () => { onSendMessage("습관 현황 보여줘"); onClose(); },
      category: "quick",
    },
    {
      id: "disk-usage",
      label: "디스크 사용량 확인",
      icon: "💾",
      action: () => { onSendMessage("C 드라이브 용량 확인해줘"); onClose(); },
      category: "quick",
    },
    {
      id: "recent-files",
      label: "최근 수정된 파일",
      icon: "📁",
      action: () => { onSendMessage("다운로드 폴더에서 최근 수정된 파일 보여줘"); onClose(); },
      category: "quick",
    },
    {
      id: "running-apps",
      label: "실행 중인 앱 목록",
      icon: "🖥️",
      action: () => { onSendMessage("실행 중인 프로세스 목록 보여줘"); onClose(); },
      category: "quick",
    },
    {
      id: "clipboard",
      label: "클립보드 내용 확인",
      icon: "📋",
      action: () => { onSendMessage("현재 클립보드에 뭐가 있어?"); onClose(); },
      category: "quick",
    },
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
