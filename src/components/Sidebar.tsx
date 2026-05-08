import { memo, useState, useEffect, useRef, useMemo, useCallback } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import CornerBrackets from "./CornerBrackets";
import type { Conversation, Folder } from "../types";
import {
  exportConversation,
  exportAllConversations,
  importConversation,
  importAllConversations,
  type ExportedConversation,
  type ExportedBackup,
} from "../db";

// Phase 32 — 색상/아이콘 picker 의 사전 정의 팔레트
const COLOR_PALETTE: Array<{ key: string; value: string | null; label: string }> = [
  { key: "default", value: null, label: "기본" },
  { key: "red", value: "#ff5d5d", label: "빨강" },
  { key: "orange", value: "#ff9c4a", label: "주황" },
  { key: "yellow", value: "#ffd84a", label: "노랑" },
  { key: "green", value: "#5dd472", label: "초록" },
  { key: "cyan", value: "#4fe8e1", label: "시안" },
  { key: "blue", value: "#5b8def", label: "파랑" },
  { key: "purple", value: "#b07cff", label: "보라" },
  { key: "pink", value: "#ff7cd6", label: "핑크" },
];

const ICON_PALETTE = ["📁", "📂", "💬", "⭐", "💡", "🛠", "🔥", "📌", "🧠", "🎯", "🚀", "📝", "🐞", "🧪", "📊", "🔒"];

interface ContextMenuState {
  x: number;
  y: number;
  type: "folder" | "conversation";
  id: string;
}

interface SidebarProps {
  conversations: Conversation[];
  folders: Folder[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation?: (id: string) => void;
  onRenameConversation?: (id: string, newTitle: string) => Promise<void> | void;
  onRefreshConversations?: () => void;
  // Phase 32 — folder tree
  onCreateFolder?: (name: string, parentId: string | null) => Promise<void> | void;
  onRenameFolder?: (id: string, newName: string) => Promise<void> | void;
  onDeleteFolder?: (id: string, mode?: "moveToParent" | "deleteAll") => Promise<void> | void;
  onMoveFolder?: (id: string, newParentId: string | null, newPosition: number) => Promise<void> | void;
  onSetFolderColor?: (id: string, color: string | null) => Promise<void> | void;
  onSetFolderIcon?: (id: string, icon: string | null) => Promise<void> | void;
  onMoveConversationToFolder?: (
    convId: string,
    folderId: string | null,
    position?: number,
  ) => Promise<void> | void;
  onToggleFavorite?: (id: string) => Promise<void> | void;
  onSetConversationColor?: (id: string, color: string | null) => Promise<void> | void;
  onSetConversationIcon?: (id: string, icon: string | null) => Promise<void> | void;
  onSearchConversations?: (query: string) => Promise<Set<string>>;
  onRefreshFolders?: () => void;
  mcpConnected?: boolean;
  onOpenSettings?: () => void;
}

function Sidebar({
  conversations,
  folders,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onRenameConversation,
  onRefreshConversations,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveFolder,
  onSetFolderColor,
  onSetFolderIcon,
  onMoveConversationToFolder,
  onToggleFavorite,
  onSetConversationColor,
  onSetConversationIcon,
  onSearchConversations,
  mcpConnected = false,
  onOpenSettings,
}: SidebarProps) {
  // 제목 inline edit (대화/폴더 공용)
  const [editingState, setEditingState] = useState<
    | { kind: "conversation"; id: string; title: string }
    | { kind: "folder"; id: string; title: string }
    | null
  >(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  // 펼침/접힘 — 폴더 ID 셋
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());

  // 검색
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<Set<string> | null>(null);

  // 우클릭 메뉴
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // 색상/아이콘 picker
  const [pickerState, setPickerState] = useState<
    | { kind: "color"; type: "folder" | "conversation"; id: string; x: number; y: number }
    | { kind: "icon"; type: "folder" | "conversation"; id: string; x: number; y: number }
    | null
  >(null);

  // DnD: 현재 드래그 중인 대상 + 드롭 후보
  const [dragOver, setDragOver] = useState<string | null>(null); // folderId 또는 "__root__"
  const dragRef = useRef<{ kind: "conversation" | "folder"; id: string } | null>(null);

  // Phase 36 (v0.5.24): 즐겨찾기 섹션 제거 — K 가 "제목 2개 보임 + 시야 좁다" 보고. ★ 아이콘 + 정렬 우선만 남김.

  // 편집 진입 시 input 자동 포커스 + 전체 선택
  useEffect(() => {
    if (editingState && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingState?.id, editingState?.kind]);

  // 우클릭 메뉴 / picker 외부 클릭 닫기 + Escape
  useEffect(() => {
    if (!contextMenu && !pickerState) return;
    const handleDocClick = () => {
      setContextMenu(null);
      setPickerState(null);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setContextMenu(null);
        setPickerState(null);
      }
    };
    document.addEventListener("click", handleDocClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("click", handleDocClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [contextMenu, pickerState]);

  // 검색 — debounce 200ms
  useEffect(() => {
    if (!onSearchConversations) return;
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchHits(null);
      return;
    }
    const t = setTimeout(async () => {
      const hits = await onSearchConversations(trimmed);
      setSearchHits(hits);
    }, 200);
    return () => clearTimeout(t);
  }, [searchQuery, onSearchConversations]);

  // 인라인 편집 헬퍼
  const startEditConv = (id: string, currentTitle: string) => {
    if (!onRenameConversation) return;
    setEditingState({ kind: "conversation", id, title: currentTitle });
  };
  const startEditFolder = (id: string, currentTitle: string) => {
    if (!onRenameFolder) return;
    setEditingState({ kind: "folder", id, title: currentTitle });
  };
  const commitEdit = async () => {
    if (!editingState) return;
    const newTitle = editingState.title.trim();
    if (!newTitle) {
      setEditingState(null);
      return;
    }
    try {
      if (editingState.kind === "conversation" && onRenameConversation) {
        const original = conversations.find((c) => c.id === editingState.id)?.title ?? "";
        if (newTitle !== original) await onRenameConversation(editingState.id, newTitle);
      } else if (editingState.kind === "folder" && onRenameFolder) {
        const original = folders.find((f) => f.id === editingState.id)?.name ?? "";
        if (newTitle !== original) await onRenameFolder(editingState.id, newTitle);
      }
    } catch (e) {
      console.error("[Sidebar] rename 실패:", e);
    }
    setEditingState(null);
  };
  const cancelEdit = () => setEditingState(null);
  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  // ─── 트리 빌드 ─────────────────────────────────────────────
  const tree = useMemo(() => {
    // parent_id 별 자식 폴더 + 폴더 별 대화 매핑
    const childFolders = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const key = f.parentId;
      const arr = childFolders.get(key) ?? [];
      arr.push(f);
      childFolders.set(key, arr);
    }
    for (const arr of childFolders.values()) {
      arr.sort((a, b) => (a.position - b.position) || a.createdAt - b.createdAt);
    }

    const convsInFolder = new Map<string | null, Conversation[]>();
    for (const c of conversations) {
      const key = c.folderId ?? null;
      const arr = convsInFolder.get(key) ?? [];
      arr.push(c);
      convsInFolder.set(key, arr);
    }
    // Phase 36 (v0.5.24): 즐겨찾기 우선 정렬 — 별도 섹션 없애고 같은 부모 안에서 ★ 가 위로.
    for (const arr of convsInFolder.values()) {
      arr.sort((a, b) => {
        const favDiff = (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0);
        if (favDiff !== 0) return favDiff;
        const posDiff = (a.position ?? 0) - (b.position ?? 0);
        if (posDiff !== 0) return posDiff;
        return b.lastActive - a.lastActive;
      });
    }

    return { childFolders, convsInFolder };
  }, [folders, conversations]);

  // 검색 필터: 폴더는 자손 중 hit 가 있으면 표시
  const visibleConvIds = useMemo(() => {
    if (!searchHits) return null;
    return searchHits;
  }, [searchHits]);

  const folderHasHit = useCallback(
    (folderId: string): boolean => {
      if (!visibleConvIds) return true;
      // 이 폴더 또는 자손 폴더의 대화 중 hit 있는지
      const stack = [folderId];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const inHere = tree.convsInFolder.get(cur) ?? [];
        for (const c of inHere) {
          if (visibleConvIds.has(c.id)) return true;
        }
        const subs = tree.childFolders.get(cur) ?? [];
        for (const sf of subs) stack.push(sf.id);
      }
      return false;
    },
    [tree, visibleConvIds],
  );

  // 검색 active 면 모든 폴더 자동 펼치기 (사용자 펼침 상태와 OR)
  const isFolderExpanded = (id: string) => {
    if (visibleConvIds) return true;
    return expandedFolders.has(id);
  };
  const toggleFolderExpand = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ─── DnD ───────────────────────────────────────────────────
  const handleDragStart = (
    e: React.DragEvent,
    kind: "conversation" | "folder",
    id: string,
  ) => {
    dragRef.current = { kind, id };
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", `${kind}:${id}`);
    } catch {}
  };
  const handleDragOver = (e: React.DragEvent, target: string | "__root__") => {
    if (!dragRef.current) return;
    // 폴더를 자기 자신/자손으로 못 넣게 — drag over 단계에서 미리 차단
    if (dragRef.current.kind === "folder" && target !== "__root__") {
      if (target === dragRef.current.id) return;
      if (isDescendantOf(folders, dragRef.current.id, target)) return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(target);
  };
  const handleDragLeave = () => {
    setDragOver(null);
  };
  const handleDrop = async (e: React.DragEvent, target: string | "__root__") => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);
    const dragged = dragRef.current;
    dragRef.current = null;
    if (!dragged) return;
    const newParentId = target === "__root__" ? null : target;
    if (dragged.kind === "conversation") {
      if (!onMoveConversationToFolder) return;
      await onMoveConversationToFolder(dragged.id, newParentId, 0);
    } else {
      if (!onMoveFolder) return;
      // 동일 부모 / 자기 자신 / 자손 차단
      if (newParentId === dragged.id) return;
      if (newParentId !== null && isDescendantOf(folders, dragged.id, newParentId)) return;
      // 타겟 부모 안의 마지막 + 1 position
      const siblings = folders.filter((f) => f.parentId === newParentId);
      const newPos = siblings.length > 0 ? Math.max(...siblings.map((f) => f.position)) + 1 : 0;
      await onMoveFolder(dragged.id, newParentId, newPos);
    }
  };

  // ─── 우클릭 메뉴 ────────────────────────────────────────────
  const openContextMenu = (
    e: React.MouseEvent,
    type: "folder" | "conversation",
    id: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, type, id });
  };

  const handleNewSubfolder = (parentId: string | null) => {
    if (!onCreateFolder) return;
    const name = prompt("새 폴더 이름:");
    if (!name) return;
    void onCreateFolder(name, parentId);
  };

  const handleDeleteFolderWithPrompt = async (id: string) => {
    if (!onDeleteFolder) return;
    const fol = folders.find((f) => f.id === id);
    if (!fol) return;
    // 폴더 안에 대화가 있으면 옵션 묻기
    const inHere = tree.convsInFolder.get(id) ?? [];
    const subs = tree.childFolders.get(id) ?? [];
    const hasContent = inHere.length > 0 || subs.length > 0;
    if (!hasContent) {
      if (confirm(`폴더 "${fol.name}" 을(를) 삭제할까요?`)) {
        await onDeleteFolder(id, "moveToParent");
      }
      return;
    }
    const choice = prompt(
      `폴더 "${fol.name}" 안에 ${inHere.length}개 대화 + ${subs.length}개 하위폴더가 있습니다.\n` +
        `1 = 폴더만 지우고 안의 항목은 부모로 이동\n` +
        `2 = 폴더와 안의 모든 대화/하위폴더까지 전부 삭제 (되돌릴 수 없음)\n\n숫자 입력 (1 또는 2):`,
      "1",
    );
    if (choice === "1") await onDeleteFolder(id, "moveToParent");
    else if (choice === "2") {
      if (confirm(`정말 모든 내용을 영구 삭제할까요? (${inHere.length}개 대화 손실)`)) {
        await onDeleteFolder(id, "deleteAll");
      }
    }
  };

  // ─── 렌더 헬퍼 ─────────────────────────────────────────────
  const renderConvItem = (c: Conversation, depth: number) => {
    const isEditing =
      editingState?.kind === "conversation" && editingState.id === c.id;
    const isFiltered = visibleConvIds !== null && !visibleConvIds.has(c.id);
    if (isFiltered) return null;
    return (
      <div
        key={c.id}
        className={`conv-item depth-${Math.min(depth, 5)} ${
          c.id === activeConversationId ? "active" : ""
        } ${c.isFavorite ? "is-fav" : ""}`}
        draggable={!isEditing}
        onDragStart={(e) => handleDragStart(e, "conversation", c.id)}
        onContextMenu={(e) => openContextMenu(e, "conversation", c.id)}
        style={c.color ? { borderLeftColor: c.color } : undefined}
      >
        {isEditing ? (
          <div className="conv-item-main conv-item-editing">
            <div className="conv-dot" />
            <input
              ref={editInputRef}
              className="conv-title-edit"
              value={editingState!.title}
              onChange={(e) => setEditingState({ ...editingState!, title: e.target.value })}
              onBlur={() => void commitEdit()}
              onKeyDown={handleEditKeyDown}
              maxLength={120}
              placeholder="제목 (Enter=저장, Esc=취소)"
            />
          </div>
        ) : (
          // Phase 33 (v0.5.21): button → div role=button 으로 변경 — HTML5 native DnD 가
          // <button> 안에서는 mousedown 이 button focus 로 가로채여 dragstart 가 시작 안 됨.
          // div + role 로 a11y 유지하면서 wrapper 의 draggable 이 정상 작동.
          <div
            className="conv-item-main"
            role="button"
            tabIndex={0}
            onClick={() => onSelectConversation(c.id)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startEditConv(c.id, c.title);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectConversation(c.id);
              }
            }}
            title="더블클릭=제목 편집 · 우클릭=메뉴 · 드래그=폴더 이동"
          >
            <span className="conv-icon">{c.icon ?? "💬"}</span>
            <div className="conv-content">
              <div className="conv-title">{c.title}</div>
              <div className="conv-meta mono">
                {c.messageCount} msg · {formatRelative(c.lastActive)}
              </div>
            </div>
          </div>
        )}
        {!isEditing && onToggleFavorite && (
          <button
            className={`conv-fav-btn ${c.isFavorite ? "active" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              void onToggleFavorite(c.id);
            }}
            title={c.isFavorite ? "즐겨찾기 해제" : "즐겨찾기 추가"}
          >
            {c.isFavorite ? "★" : "☆"}
          </button>
        )}
        {!isEditing && onRenameConversation && (
          <button
            className="conv-rename-btn"
            onClick={(e) => {
              e.stopPropagation();
              startEditConv(c.id, c.title);
            }}
            title="제목 변경"
          >
            ✎
          </button>
        )}
        {!isEditing && onDeleteConversation && (
          <button
            className="conv-delete-btn"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`대화 "${c.title}" 을(를) 삭제할까요?`)) {
                onDeleteConversation(c.id);
              }
            }}
            title="대화 삭제"
          >
            ×
          </button>
        )}
      </div>
    );
  };

  const renderFolder = (f: Folder, depth: number): JSX.Element | null => {
    const expanded = isFolderExpanded(f.id);
    const isEditing = editingState?.kind === "folder" && editingState.id === f.id;
    // 검색 active 면 hit 없는 폴더는 숨김
    if (visibleConvIds && !folderHasHit(f.id)) return null;
    const subFolders = tree.childFolders.get(f.id) ?? [];
    const subConvs = tree.convsInFolder.get(f.id) ?? [];
    const isDragOver = dragOver === f.id;
    return (
      <div key={f.id} className={`folder-block depth-${Math.min(depth, 5)}`}>
        <div
          className={`folder-row ${isDragOver ? "drag-over" : ""}`}
          draggable={!isEditing}
          onDragStart={(e) => handleDragStart(e, "folder", f.id)}
          onDragOver={(e) => handleDragOver(e, f.id)}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, f.id)}
          onContextMenu={(e) => openContextMenu(e, "folder", f.id)}
          style={f.color ? { borderLeftColor: f.color } : undefined}
        >
          <button
            className="folder-toggle"
            onClick={() => toggleFolderExpand(f.id)}
            title={expanded ? "접기" : "펼치기"}
          >
            {expanded ? "▾" : "▸"}
          </button>
          <span className="folder-icon">{f.icon ?? "📁"}</span>
          {isEditing ? (
            <input
              ref={editInputRef}
              className="folder-name-edit"
              value={editingState!.title}
              onChange={(e) => setEditingState({ ...editingState!, title: e.target.value })}
              onBlur={() => void commitEdit()}
              onKeyDown={handleEditKeyDown}
              maxLength={80}
              placeholder="폴더 이름"
            />
          ) : (
            // Phase 33 (v0.5.21): button → div role=button (DnD 호환)
            <div
              className="folder-name"
              role="button"
              tabIndex={0}
              onDoubleClick={(e) => {
                e.stopPropagation();
                startEditFolder(f.id, f.name);
              }}
              onClick={() => toggleFolderExpand(f.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleFolderExpand(f.id);
                }
              }}
              title="더블클릭=이름 편집 · 우클릭=메뉴 · 클릭=펼침/접힘 · 드래그=다른 폴더로 이동"
              style={f.color ? { color: f.color } : undefined}
            >
              {f.name}
            </div>
          )}
          <span className="folder-count mono">
            {(tree.convsInFolder.get(f.id)?.length ?? 0) +
              (tree.childFolders.get(f.id)?.length ?? 0)}
          </span>
        </div>
        {expanded && (
          <div className="folder-children">
            {subFolders.map((sf) => renderFolder(sf, depth + 1))}
            {subConvs.map((c) => renderConvItem(c, depth + 1))}
          </div>
        )}
      </div>
    );
  };

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
      if (data.conversations && Array.isArray(data.conversations)) {
        const backup = data as ExportedBackup;
        const imported = await importAllConversations(backup);
        alert(`${imported}개 대화 가져오기 완료!`);
      } else if (data.conversation && data.messages) {
        const conv = data as ExportedConversation;
        await importConversation(conv, true);
        alert(`"${conv.conversation.title}" 가져오기 완료!`);
      } else {
        alert("유효하지 않은 백업 파일입니다.");
        return;
      }
      onRefreshConversations?.();
    } catch (e) {
      console.error("Import error:", e);
      alert("가져오기 실패: " + (e as Error).message);
    }
  };

  // ─── 우클릭 메뉴 렌더 ───────────────────────────────────────
  const renderContextMenu = () => {
    if (!contextMenu) return null;
    const { type, id, x, y } = contextMenu;
    const items: Array<{ label: string; action: () => void; danger?: boolean }> = [];
    if (type === "folder") {
      items.push({
        label: "📁 새 하위폴더",
        action: () => handleNewSubfolder(id),
      });
      items.push({
        label: "✎ 이름 변경",
        action: () => {
          const f = folders.find((x) => x.id === id);
          if (f) startEditFolder(f.id, f.name);
        },
      });
      items.push({
        label: "🎨 색상…",
        action: () => setPickerState({ kind: "color", type: "folder", id, x, y }),
      });
      items.push({
        label: "💠 아이콘…",
        action: () => setPickerState({ kind: "icon", type: "folder", id, x, y }),
      });
      items.push({
        label: "🗑 삭제",
        danger: true,
        action: () => void handleDeleteFolderWithPrompt(id),
      });
    } else {
      const c = conversations.find((x) => x.id === id);
      items.push({
        label: c?.isFavorite ? "★ 즐겨찾기 해제" : "☆ 즐겨찾기 추가",
        action: () => onToggleFavorite && void onToggleFavorite(id),
      });
      items.push({
        label: "✎ 제목 변경",
        action: () => c && startEditConv(c.id, c.title),
      });
      items.push({
        label: "🎨 색상…",
        action: () => setPickerState({ kind: "color", type: "conversation", id, x, y }),
      });
      items.push({
        label: "💠 아이콘…",
        action: () => setPickerState({ kind: "icon", type: "conversation", id, x, y }),
      });
      items.push({
        label: "📂 루트로 이동",
        action: () =>
          onMoveConversationToFolder && void onMoveConversationToFolder(id, null, 0),
      });
      items.push({
        label: "🗑 삭제",
        danger: true,
        action: () => {
          if (!onDeleteConversation || !c) return;
          if (confirm(`대화 "${c.title}" 을(를) 삭제할까요?`)) onDeleteConversation(id);
        },
      });
    }
    return (
      <div
        className="ctx-menu"
        style={{ left: clampX(x), top: clampY(y) }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((it, i) => (
          <button
            key={i}
            className={`ctx-item ${it.danger ? "danger" : ""}`}
            onClick={() => {
              it.action();
              setContextMenu(null);
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    );
  };

  // ─── 색상/아이콘 picker 렌더 ───────────────────────────────
  const renderPicker = () => {
    if (!pickerState) return null;
    const { kind, type, id, x, y } = pickerState;
    if (kind === "color") {
      return (
        <div
          className="picker-popover"
          style={{ left: clampX(x), top: clampY(y) }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="picker-label">색상 선택</div>
          <div className="color-grid">
            {COLOR_PALETTE.map((c) => (
              <button
                key={c.key}
                className="color-swatch"
                style={{
                  background: c.value ?? "transparent",
                  border: c.value ? "1px solid #0006" : "1px dashed var(--border)",
                }}
                title={c.label}
                onClick={() => {
                  if (type === "folder" && onSetFolderColor) {
                    void onSetFolderColor(id, c.value);
                  } else if (type === "conversation" && onSetConversationColor) {
                    void onSetConversationColor(id, c.value);
                  }
                  setPickerState(null);
                }}
              />
            ))}
          </div>
        </div>
      );
    }
    return (
      <div
        className="picker-popover"
        style={{ left: clampX(x), top: clampY(y) }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="picker-label">아이콘 선택</div>
        <div className="icon-grid">
          {ICON_PALETTE.map((emoji) => (
            <button
              key={emoji}
              className="icon-swatch"
              onClick={() => {
                if (type === "folder" && onSetFolderIcon) {
                  void onSetFolderIcon(id, emoji);
                } else if (type === "conversation" && onSetConversationIcon) {
                  void onSetConversationIcon(id, emoji);
                }
                setPickerState(null);
              }}
            >
              {emoji}
            </button>
          ))}
          <button
            className="icon-swatch icon-clear"
            title="기본으로"
            onClick={() => {
              if (type === "folder" && onSetFolderIcon) {
                void onSetFolderIcon(id, null);
              } else if (type === "conversation" && onSetConversationIcon) {
                void onSetConversationIcon(id, null);
              }
              setPickerState(null);
            }}
          >
            ✕
          </button>
        </div>
      </div>
    );
  };

  // 트리 root level (parent_id = null) 자식 폴더 + 대화
  const rootFolders = tree.childFolders.get(null) ?? [];
  const rootConvs = tree.convsInFolder.get(null) ?? [];
  const rootDragOver = dragOver === "__root__";

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

      {/* 새 대화 + 새 폴더 버튼 */}
      <div className="sidebar-actions">
        <button className="new-chat-btn" onClick={onNewConversation}>
          <span className="plus">+</span>
          <span>새 대화</span>
        </button>
        {onCreateFolder && (
          <button
            className="new-folder-btn"
            onClick={() => handleNewSubfolder(null)}
            title="새 폴더 (root)"
          >
            <span className="plus">📁+</span>
          </button>
        )}
      </div>

      {/* 검색 인풋 */}
      {onSearchConversations && (
        <div className="sidebar-search">
          <input
            type="text"
            className="search-input"
            placeholder="🔍 제목 / 메시지 검색…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              className="search-clear"
              onClick={() => setSearchQuery("")}
              title="검색 해제"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Phase 36 (v0.5.24): 즐겨찾기는 별도 섹션 X — ★ 아이콘 + 자동 정렬로 통합 */}

      {/* 대화 목록 (트리) */}
      <div className="sidebar-section sidebar-tree-section">
        <div className="eyebrow section-label">대화 목록</div>
        <div
          className={`conv-list root-drop ${rootDragOver ? "drag-over" : ""}`}
          onDragOver={(e) => handleDragOver(e, "__root__")}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, "__root__")}
        >
          {conversations.length === 0 && folders.length === 0 ? (
            <div className="conv-empty">대화 없음</div>
          ) : (
            <>
              {rootFolders.map((f) => renderFolder(f, 0))}
              {rootConvs.map((c) => renderConvItem(c, 0))}
              {visibleConvIds && visibleConvIds.size === 0 && (
                <div className="conv-empty">검색 결과 없음</div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 백업/복구 */}
      <div className="sidebar-section">
        <div className="eyebrow section-label">백업</div>
        <button className="tool-item" onClick={handleExportCurrent} title="현재 대화 내보내기">
          <span className="tool-icon">📤</span>
          <span>대화 내보내기</span>
        </button>
        <button className="tool-item" onClick={handleExportAll} title="전체 백업">
          <span className="tool-icon">💾</span>
          <span>전체 백업</span>
        </button>
        <button className="tool-item" onClick={handleImport} title="가져오기">
          <span className="tool-icon">📥</span>
          <span>가져오기</span>
        </button>
      </div>

      {/* 설정 */}
      <div className="sidebar-section sidebar-bottom">
        <div className="eyebrow section-label">설정</div>
        <button className="tool-item" onClick={onOpenSettings}>
          <span className="tool-icon">⚙</span>
          <span>환경설정</span>
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

      {renderContextMenu()}
      {renderPicker()}
    </aside>
  );
}

export default memo(Sidebar);

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

// 폴더 사이클 방지 — folderId 가 candidateAncestor 의 자손인지 확인
function isDescendantOf(
  allFolders: Folder[],
  ancestorId: string,
  candidateId: string,
): boolean {
  const stack: (string | null)[] = [candidateId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === null || cur === undefined) continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (cur === ancestorId) return true;
    const parent = allFolders.find((f) => f.id === cur)?.parentId ?? null;
    if (parent !== null) stack.push(parent);
  }
  return false;
}

// ctx menu / picker 가 화면 밖으로 나가지 않게 — rough viewport clamp
function clampX(x: number): number {
  const max = window.innerWidth - 220;
  return Math.min(Math.max(8, x), max);
}
function clampY(y: number): number {
  const max = window.innerHeight - 280;
  return Math.min(Math.max(8, y), max);
}
