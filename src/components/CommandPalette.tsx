import { useEffect, useState, useRef, useCallback, useMemo, Fragment } from "react";
import { QUICK_PROMPTS } from "../utils/quickPrompts";
import { useApprovalMode } from "../utils/useApprovalMode";
import { useUiLayout } from "../utils/useUiLayout";
import {
  filterPaletteItems,
  PALETTE_GROUP_LABELS,
  SETTINGS_SECTION_ANCHORS,
  type PaletteItem,
} from "../utils/commandPalette";
import { SETTINGS_TABS } from "../utils/settingsTabs";
import type { Conversation } from "../types";
import { Icon, type IconName } from "../ui/icons";
import { emojiIconName } from "../ui/emojiIcon";
import { SETTINGS_GROUP_ICONS } from "./SettingsO2";

// v0.7.86 UI 9단계 — 그룹: 동작 / 빠른 요청 / 대화 이동 / 설정 (두 배치 공통).
// 옛 이름(세션 초기화, 자동 승인, 대화 압축 …)은 keywords 로 남겨 검색에 걸리게 한다.
// dzC (o2 만) — 목업 v2.1 팔레트: 라인 아이콘 · 범위 칩(전체/동작/대화/설정, Tab) · 검색어 강조 · 키캡 · 설정은 '그룹 › 섹션'.
type Command = PaletteItem & { o2Icon?: IconName; crumb?: string; meta?: string };

type PaletteScope = "all" | "action" | "conversation" | "settings";
const SCOPES: Array<[PaletteScope, string]> = [["all", "전체"], ["action", "동작"], ["conversation", "대화"], ["settings", "설정"]];
const inScope = (scope: PaletteScope, c: Command) =>
  scope === "all" || (scope === "action" ? c.group === "action" || c.group === "quick" : c.group === scope);
const O2_ACTION_ICONS: Record<string, IconName> = {
  "new-chat": "plus", "new-folder": "folderPlus", "toggle-approval": "shield", "session-refresh": "rotate",
  "compress-context": "layers", "panel-preview": "eye", "panel-tasks": "zap", "panel-session": "gauge",
  "panel-assistant": "assistant", library: "library", "toggle-tool-cards": "terminal", "export-conversation": "upload",
  "hard-stop": "square", "toggle-layout": "palette", settings: "settings",
  screenshot: "camera", "todo-list": "listChecks", "disk-usage": "hardDrive", "recent-files": "folder",
};
const fmtDay = (ts: number) => { try { return new Date(ts).toLocaleDateString("ko-KR", { month: "long", day: "numeric" }); } catch { return ""; } };
/** 검색어와 맞는 부분을 <mark> 로 (대소문자 무시, 첫 번째만) */
function highlight(text: string, query: string) {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</>;
}
const Keys = ({ combo }: { combo: string }) => (
  <span className="o2-keys">{combo.split("+").map((k) => <kbd key={k} className="o2-kbd">{k}</kbd>)}</span>
);

export type PalettePanel = "preview" | "tasks" | "session" | "assistant";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onSendMessage: (msg: string) => void;
  onOpenSettings: () => void;
  onNewChat: () => void;
  conversations?: Conversation[];
  activeConversationId?: string | null;
  onSelectConversation?: (id: string) => void;
  onSearchConversations?: (query: string) => Promise<Set<string>>;
  onOpenSettingsSection?: (id: string) => void;
  onSessionRefresh?: () => void;
  onCompressContext?: () => void;
  onExportConversation?: () => void;
  onHardStop?: () => void;
  onOpenLibrary?: () => void;
  onNewFolder?: () => void;
  // 패널 열기. o2 는 슬라이드오버 4탭, classic 은 'preview'(가장자리 SidePanel)만 넘긴다.
  onOpenPanel?: (panel: PalettePanel) => void;
  panels?: PalettePanel[];
}

const TOOL_CARDS_KEY = "kda_show_tool_cards";
export const TOOL_CARDS_EVENT = "kda-show-tool-cards-changed";

const PANEL_LABELS: Record<PalettePanel, [string, string, string[]]> = {
  preview: ["미리보기 패널 열기", "🖼️", ["사이드 패널", "미리보기"]],
  tasks: ["작업 패널 열기", "⚡", ["작업 현황", "작업"]],
  session: ["세션·사용량 보기", "📊", ["사용량", "한도", "컨텍스트", "메트릭"]],
  assistant: ["비서 패널 열기", "◐", ["비서", "음성", "아바타"]],
};

export default function CommandPalette({
  open,
  onClose,
  onSendMessage,
  onOpenSettings,
  onNewChat,
  conversations = [],
  activeConversationId = null,
  onSelectConversation,
  onSearchConversations,
  onOpenSettingsSection,
  onSessionRefresh,
  onCompressContext,
  onExportConversation,
  onHardStop,
  onOpenLibrary,
  onNewFolder,
  onOpenPanel,
  panels = [],
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [contentHits, setContentHits] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<PaletteScope>("all");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const approval = useApprovalMode();
  const { layout, setLayout } = useUiLayout();
  const isO2 = layout === "o2";

  // 메시지 내용 검색 (대화 이동) — 입력이 멈춘 뒤 한 번
  useEffect(() => {
    const q = query.trim();
    if (!open || !onSearchConversations || q.length < 2) { setContentHits(new Set()); return; }
    let alive = true;
    const t = window.setTimeout(() => {
      onSearchConversations(q).then((ids) => { if (alive) setContentHits(ids); }).catch(() => {});
    }, 200);
    return () => { alive = false; window.clearTimeout(t); };
  }, [open, query, onSearchConversations]);

  const commands: Command[] = useMemo(() => {
    const run = (fn: () => void) => () => { onClose(); fn(); };
    const showToolCards = (() => { try { return localStorage.getItem(TOOL_CARDS_KEY) === "1"; } catch { return false; } })();
    const list: Command[] = [
      // 동작
      { id: "new-chat", label: "새 대화", icon: "💬", group: "action", keywords: ["새 채팅", "new chat"], run: run(onNewChat) },
      ...(onNewFolder ? [{ id: "new-folder", label: "새 폴더", icon: "📁", group: "action" as const, keywords: ["폴더 만들기"], run: run(onNewFolder) }] : []),
      {
        id: "toggle-approval",
        label: approval.enabled ? "확인 없이 실행 끄기" : "확인 없이 실행 켜기",
        hint: approval.enabled ? "지금 켜짐" : "지금 꺼짐",
        icon: "🛡️",
        shortcut: "Ctrl+Alt+A",
        group: "action",
        keywords: ["자동 승인", "자동승인", "자동 승인 ON", "자동 승인 OFF", "승인", "안전"],
        run: run(approval.toggle),
      },
      ...(onSessionRefresh ? [{
        id: "session-refresh", label: "새 세션으로 이어가기", hint: "맥락 유지 · 같은 대화", icon: "↻", group: "action" as const,
        keywords: ["세션 초기화", "세션", "갱신", "리셋", "초기화", "컨텍스트 비우기"], run: run(onSessionRefresh),
      }] : []),
      ...(onCompressContext ? [{
        id: "compress-context", label: "요약해서 새 대화로 이어가기", hint: "현재 대화는 보존", icon: "📦", group: "action" as const,
        keywords: ["대화 압축", "압축", "이어하기", "요약"], run: run(onCompressContext),
      }] : []),
      ...panels.map((p): Command => ({
        id: `panel-${p}`, label: PANEL_LABELS[p][0], icon: PANEL_LABELS[p][1], group: "action", keywords: ["패널", ...PANEL_LABELS[p][2]],
        run: run(() => onOpenPanel?.(p)),
      })),
      ...(onOpenLibrary ? [{ id: "library", label: "라이브러리 열기", icon: "📚", shortcut: "Ctrl+L", group: "action" as const, keywords: ["라이브러리", "카드"], run: run(onOpenLibrary) }] : []),
      {
        id: "toggle-tool-cards",
        label: showToolCards ? "도구 호출 숨기기" : "도구 호출 보기",
        icon: "🔧",
        group: "action",
        keywords: ["도구 카드", "tool"],
        run: run(() => {
          try { localStorage.setItem(TOOL_CARDS_KEY, showToolCards ? "0" : "1"); } catch { /* ignore */ }
          window.dispatchEvent(new Event(TOOL_CARDS_EVENT));
        }),
      },
      ...(onExportConversation ? [{ id: "export-conversation", label: "이 대화 내보내기", icon: "📤", group: "action" as const, keywords: ["내보내기", "export", "백업"], run: run(onExportConversation) }] : []),
      ...(onHardStop ? [{ id: "hard-stop", label: "전체 작업 정지", icon: "■", group: "action" as const, keywords: ["정지", "중단", "hardstop", "멈춤"], run: run(onHardStop) }] : []),
      {
        id: "toggle-layout",
        label: layout === "o2" ? "화면 스타일: 클래식으로 바꾸기" : "화면 스타일: O2로 바꾸기",
        hint: layout === "o2" ? "지금 O2" : "지금 클래식",
        icon: "🎨",
        group: "action",
        keywords: ["화면 스타일", "화면 배치", "레이아웃", "배치", "classic", "클래식", "o2"],
        run: run(() => setLayout(layout === "o2" ? "classic" : "o2")),
      },
      { id: "settings", label: "설정 열기", icon: "⚙️", group: "action", keywords: ["환경설정", "설정"], run: run(onOpenSettings) },
      // 빠른 요청 — 빈 화면 제안 카드와 같은 목록 (src/utils/quickPrompts.ts)
      ...QUICK_PROMPTS.map((p): Command => ({
        id: p.id,
        label: p.label,
        icon: p.icon,
        group: "quick",
        run: () => { onSendMessage(p.prompt); onClose(); },
      })),
      // 대화 이동 — 제목 또는 메시지 내용 검색 결과
      ...(onSelectConversation
        ? conversations
            .filter((c) => c.id !== activeConversationId)
            .map((c): Command => ({
              id: `conv-${c.id}`,
              label: c.title || "제목 없음",
              icon: "🗨️",
              group: "conversation",
              hint: contentHits.has(c.id) ? "메시지 내용 일치" : undefined,
              meta: c.lastActive > 1 ? fmtDay(c.lastActive) : undefined,
              keywords: contentHits.has(c.id) ? [query] : undefined,
              run: run(() => onSelectConversation(c.id)),
            }))
        : []),
      // 설정 섹션 — 그룹을 열고 그 섹션으로 스크롤
      ...SETTINGS_SECTION_ANCHORS.map((a): Command => ({
        id: a.id,
        label: a.title,
        icon: "⚙️",
        group: "settings",
        o2Icon: SETTINGS_GROUP_ICONS[a.tab],
        crumb: SETTINGS_TABS.find((t) => t.id === a.tab)?.label,
        keywords: a.keywords,
        run: run(() => (onOpenSettingsSection ? onOpenSettingsSection(a.id) : onOpenSettings())),
      })),
    ];
    return list;
  }, [approval.enabled, approval.toggle, layout, setLayout, panels, conversations, activeConversationId, contentHits, query,
    onClose, onNewChat, onNewFolder, onSessionRefresh, onCompressContext, onOpenPanel, onOpenLibrary, onExportConversation,
    onHardStop, onOpenSettings, onSendMessage, onSelectConversation, onOpenSettingsSection, open]);

  // 필터링된 명령 (그룹 순서 유지, 검색어 없으면 대화 이동은 최근 6개)
  const filteredCommands = useMemo(() => {
    const all = filterPaletteItems(commands, query);
    return isO2 ? all.filter((c) => inScope(scope, c)) : all;
  }, [commands, query, isO2, scope]);

  // 선택 인덱스 보정
  useEffect(() => {
    if (selectedIndex >= filteredCommands.length) {
      setSelectedIndex(Math.max(0, filteredCommands.length - 1));
    }
  }, [filteredCommands.length, selectedIndex]);
  useEffect(() => { setSelectedIndex(0); }, [query, scope]);
  useEffect(() => {
    listRef.current?.querySelector(".command-palette-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // 열릴 때 포커스 및 리셋
  useEffect(() => {
    if (open) {
      setQuery("");
      setScope("all");
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
          if (e.nativeEvent.isComposing) break; // 한글 조합 중 Enter 는 무시
          if (filteredCommands[selectedIndex]) {
            filteredCommands[selectedIndex].run();
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
        case "Tab":
          // o2: Tab / Shift+Tab 으로 범위 칩 이동 (classic 은 기본 동작)
          if (!isO2) break;
          e.preventDefault();
          setScope((cur) => {
            const i = SCOPES.findIndex(([v]) => v === cur);
            return SCOPES[(i + (e.shiftKey ? SCOPES.length - 1 : 1)) % SCOPES.length][0];
          });
          break;
      }
    },
    [filteredCommands, selectedIndex, query, onSendMessage, onClose, isO2]
  );

  if (!open) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="명령 팔레트" onClick={(e) => e.stopPropagation()}>
        <div className="command-palette-header">
          <span className="command-palette-icon">{isO2 ? <Icon name="search" size={18} /> : "⌘"}</span>
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder="명령, 대화, 설정 검색..."
            aria-label="명령 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {isO2 ? <kbd className="o2-kbd command-palette-hint--o2">Esc</kbd> : <span className="command-palette-hint mono">ESC</span>}
        </div>
        {isO2 && (
          <div className="command-palette-scopes" role="tablist" aria-label="검색 범위">
            {SCOPES.map(([v, label]) => (
              <button key={v} type="button" role="tab" aria-selected={scope === v} tabIndex={-1}
                className={`command-palette-scope${scope === v ? " is-on" : ""}`}
                onMouseDown={(e) => e.preventDefault()} onClick={() => setScope(v)}>{label}</button>
            ))}
          </div>
        )}

        <div className="command-palette-list" ref={listRef} role="listbox" aria-label="명령 목록">
          {filteredCommands.length === 0 ? (
            <div className="command-palette-empty">
              <span>"{query}" 로 바로 메시지 전송 (Enter)</span>
            </div>
          ) : (
            filteredCommands.map((cmd, idx) => (
              <Fragment key={cmd.id}>
                {(idx === 0 || filteredCommands[idx - 1].group !== cmd.group) && (
                  <div className="command-palette-group" role="presentation">{PALETTE_GROUP_LABELS[cmd.group]}</div>
                )}
                <div
                  role="option"
                  aria-selected={idx === selectedIndex}
                  data-group={cmd.group}
                  className={`command-palette-item ${
                    idx === selectedIndex ? "selected" : ""
                  }`}
                  onClick={() => cmd.run()}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  {isO2 ? (
                    <>
                      <span className="command-item-icon">
                        <Icon name={cmd.o2Icon ?? O2_ACTION_ICONS[cmd.id]
                          ?? (cmd.group === "conversation" ? "msg" : (cmd.icon && emojiIconName(cmd.icon)) || "chevronRight")} />
                      </span>
                      <span className="command-item-label">
                        {cmd.crumb && <span className="command-item-crumb">{cmd.crumb}<Icon name="chevronRight" size={14} /></span>}
                        {highlight(cmd.label, query)}
                      </span>
                      {cmd.hint && <span className="command-item-hint">{cmd.hint}</span>}
                      <span className="command-item-end">
                        {cmd.meta && <span className="command-item-meta">{cmd.meta}</span>}
                        {cmd.shortcut ? <Keys combo={cmd.shortcut} />
                          : idx === selectedIndex && !cmd.meta ? <kbd className="o2-kbd">↵</kbd> : null}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="command-item-icon">{cmd.icon}</span>
                      <span className="command-item-label">{cmd.label}</span>
                      {cmd.hint && <span className="command-item-hint">{cmd.hint}</span>}
                      {cmd.shortcut && (
                        <span className="command-item-shortcut mono">{cmd.shortcut}</span>
                      )}
                    </>
                  )}
                </div>
              </Fragment>
            ))
          )}
        </div>

        {isO2 ? (
          <div className="command-palette-footer command-palette-footer--o2">
            <span><Keys combo="↑+↓" /> 이동</span>
            <span><kbd className="o2-kbd">↵</kbd> 실행</span>
            <span><kbd className="o2-kbd">Tab</kbd> 범위</span>
            <span className="command-palette-footer__grow" />
            <span><Keys combo="Ctrl+K" /> 열기·닫기</span>
          </div>
        ) : (
          <div className="command-palette-footer">
            <span className="mono">↑↓ 이동</span>
            <span className="mono">Enter 실행</span>
            <span className="mono">Esc 닫기</span>
            <span className="mono">Ctrl+K 열기·닫기</span>
          </div>
        )}
      </div>
    </div>
  );
}
