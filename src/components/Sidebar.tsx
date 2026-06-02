import { memo, useState, useEffect, useRef, useMemo, useCallback, Fragment } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
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
  // Phase 113 (v0.6.64) — folderId 인자 추가 (optional). Explorer 모드에서 폴더 안일 때 자동 박힘.
  onNewConversation: (folderId?: string | null) => void;
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
  // Phase 107 (v0.6.56) — 폴더 프로젝트 지침 + 첨부 편집 진입. App.tsx 의
  // FolderInstructionsDialog state 를 열어서 textarea + 파일 picker 표시.
  onEditFolderInstructions?: (folderId: string) => void;
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
  // Phase 111 (v0.6.60) — 현재 streaming 중인 conv ID 집합. 사이드바 conv 옆 ● dot 배지 표시.
  // K 가 다른 conv 로 이동했어도 옛 turn 이 진행 중이면 그 conv 옆에 표시.
  streamingConvIds?: Set<string>;
  // Phase 112 (v0.6.63) — 대화 라이브러리 (full-screen panel) 진입 callback.
  onOpenLibrary?: () => void;
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
  onEditFolderInstructions,
  onMoveConversationToFolder,
  onToggleFavorite,
  onSetConversationColor,
  onSetConversationIcon,
  onSearchConversations,
  mcpConnected = false,
  onOpenSettings,
  streamingConvIds,
  onOpenLibrary,
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

  // Phase 108 (v0.6.57) → Phase 113 (v0.6.64) — K 정정 "트리 구조 버려".
  // viewMode 는 "explorer" 로 고정 (트리 모드 제거). setViewMode 호출되어도 explorer 유지.
  // 옛 localStorage 의 "tree" 값은 무시 — 자동으로 explorer 로 보임.
  // (state 자체는 유지 — 다른 분기들이 viewMode 참조하므로 type/api 호환)
  const [viewMode, setViewMode] = useState<"tree" | "explorer">("explorer");
  // 옛 localStorage 잔재 정리 (1회) — 다음 부팅 시 깨끗.
  useEffect(() => {
    try {
      const stored = localStorage.getItem("kda_sidebar_view_mode");
      if (stored && stored !== "explorer") {
        localStorage.setItem("kda_sidebar_view_mode", "explorer");
      }
    } catch {
      /* ignore */
    }
  }, []);
  // setViewMode 미사용 경고 회피
  void setViewMode;

  // Phase 108 — Explorer 모드에서 현재 표시 중인 폴더 ID. null = 루트.
  // viewMode 가 tree 면 무시됨. explorer 모드로 토글한 직후엔 자동으로 루트부터 시작.
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);

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

  // Phase 38 (v0.5.26) — 폴더 생성 inline 입력 (prompt() 가 Tauri webview 에서 막힘 fallback)
  const [creatingFolder, setCreatingFolder] = useState<{ parentId: string | null; name: string } | null>(null);
  const createFolderInputRef = useRef<HTMLInputElement | null>(null);

  // Phase 38 — 폴더 picker (대화→폴더 이동 fallback, DnD 안 될 때)
  const [folderPicker, setFolderPicker] = useState<{
    convId: string;
    x: number;
    y: number;
  } | null>(null);

  // Phase 38 — 폴더 삭제 confirm dialog (confirm() 도 Tauri webview 에서 안 뜰 수 있음)
  const [folderDeleteDialog, setFolderDeleteDialog] = useState<{
    folder: Folder;
    childCount: number;
    convCount: number;
  } | null>(null);

  // Phase 39 (v0.5.27): @dnd-kit 도입 — native HTML5 DnD 가 K 의 PC 에서 작동 안 한
  // 패턴 (button→div fix 후에도) 우회. dnd-kit 은 PointerSensor 로 mousedown→move 를
  // 직접 추적하므로 Tauri webview 의 native drag quirk 영향 없음.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_activeDragId, setActiveDragId] = useState<string | null>(null);
  // PointerSensor: 8px 이동 후에 drag 시작 — 일반 click 과 충돌 없음
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // Phase 36 (v0.5.24): 즐겨찾기 섹션 제거 — K 가 "제목 2개 보임 + 시야 좁다" 보고. ★ 아이콘 + 정렬 우선만 남김.

  // 편집 진입 시 input 자동 포커스 + 전체 선택
  useEffect(() => {
    if (editingState && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingState?.id, editingState?.kind]);

  // 우클릭 메뉴 / picker / folder picker 외부 클릭 닫기 + Escape
  useEffect(() => {
    if (!contextMenu && !pickerState && !folderPicker) return;
    const handleDocClick = () => {
      setContextMenu(null);
      setPickerState(null);
      setFolderPicker(null);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setContextMenu(null);
        setPickerState(null);
        setFolderPicker(null);
        setFolderDeleteDialog(null);
      }
    };
    document.addEventListener("click", handleDocClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("click", handleDocClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [contextMenu, pickerState, folderPicker]);

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

  // Phase 108 (v0.6.57) — Explorer breadcrumb path.
  // currentFolderId 부터 parentId 따라 root 까지 거슬러 올라간 폴더 배열 (root → ... → 현재 순).
  // currentFolderId === null 이면 빈 배열 ([] = 루트 표시).
  // cycle 방지를 위해 seen Set + early break.
  const breadcrumbPath = useMemo(() => {
    if (!currentFolderId) return [] as Folder[];
    const path: Folder[] = [];
    let cur: string | null | undefined = currentFolderId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const f = folders.find((x) => x.id === cur);
      if (!f) break;
      path.unshift(f);
      cur = f.parentId;
    }
    return path;
  }, [currentFolderId, folders]);

  // Phase 108 — currentFolderId 가 가리키는 폴더가 사라지면 (삭제, 검색 etc.) 자동으로 루트로 reset.
  // 영구 dangling reference 방지.
  useEffect(() => {
    if (currentFolderId && !folders.some((f) => f.id === currentFolderId)) {
      setCurrentFolderId(null);
    }
  }, [folders, currentFolderId]);

  // Phase 108 — Explorer 모드 위로 가기 (Backspace 단축키).
  // 입력 필드 안에서는 trigger 안 됨 (검색 input, 제목 편집 input 등).
  useEffect(() => {
    if (viewMode !== "explorer") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!currentFolderId) return;
      const cur = folders.find((f) => f.id === currentFolderId);
      setCurrentFolderId(cur?.parentId ?? null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewMode, currentFolderId, folders]);

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

  // ─── DnD (Phase 39 v0.5.27: @dnd-kit) ───────────────────────────
  // active.id / over.id 는 prefix 로 분기:
  //   "conv:<id>"   = 대화 드래그
  //   "folder:<id>" = 폴더 드래그
  //   "folder:<id>" / "__root__" = 드롭 타겟
  const handleDndStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
    console.log(`[DnD] start active=${event.active.id}`);
  };
  const handleDndEnd = async (event: DragEndEvent) => {
    setActiveDragId(null);
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    console.log(`[DnD] end active=${activeId} over=${overId}`);
    if (!overId) return;

    const [activeKind, activeRealId] = activeId.split(":");
    const target = overId === "__root__" ? null : overId.split(":")[1] ?? null;

    if (activeKind === "conv") {
      if (!onMoveConversationToFolder) return;
      await onMoveConversationToFolder(activeRealId, target, 0);
    } else if (activeKind === "folder") {
      if (!onMoveFolder) return;
      // 사이클 차단
      if (target === activeRealId) return;
      if (target !== null && isDescendantOf(folders, activeRealId, target)) return;
      const siblings = folders.filter((f) => f.parentId === target);
      const newPos = siblings.length > 0 ? Math.max(...siblings.map((f) => f.position)) + 1 : 0;
      await onMoveFolder(activeRealId, target, newPos);
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

  // Phase 38 (v0.5.26) — prompt() / confirm() 이 Tauri webview 에서 작동 안 함 → inline UI 로 대체
  const handleNewSubfolder = (parentId: string | null) => {
    if (!onCreateFolder) return;
    setCreatingFolder({ parentId, name: "" });
    // 부모 폴더는 자동 펼침
    if (parentId) {
      setExpandedFolders((prev) => new Set(prev).add(parentId));
    }
    // 다음 tick 에 input 포커스
    setTimeout(() => {
      createFolderInputRef.current?.focus();
    }, 50);
  };

  const commitNewFolder = async () => {
    if (!creatingFolder || !onCreateFolder) {
      setCreatingFolder(null);
      return;
    }
    const name = creatingFolder.name.trim();
    if (!name) {
      setCreatingFolder(null);
      return;
    }
    try {
      await onCreateFolder(name, creatingFolder.parentId);
    } catch (e) {
      console.error("[Sidebar] 폴더 생성 실패:", e);
    }
    setCreatingFolder(null);
  };

  const cancelNewFolder = () => setCreatingFolder(null);

  const handleDeleteFolderWithPrompt = (id: string) => {
    if (!onDeleteFolder) return;
    const fol = folders.find((f) => f.id === id);
    if (!fol) return;
    const inHere = tree.convsInFolder.get(id) ?? [];
    const subs = tree.childFolders.get(id) ?? [];
    setFolderDeleteDialog({ folder: fol, childCount: subs.length, convCount: inHere.length });
  };

  // ─── 렌더 헬퍼 ─────────────────────────────────────────────
  const renderConvItem = (c: Conversation, depth: number) => {
    const isEditing =
      editingState?.kind === "conversation" && editingState.id === c.id;
    const isFiltered = visibleConvIds !== null && !visibleConvIds.has(c.id);
    if (isFiltered) return null;
    return (
      <DraggableConv
        key={c.id}
        convId={c.id}
        disabled={isEditing}
        className={`conv-item depth-${Math.min(depth, 5)} ${
          c.id === activeConversationId ? "active" : ""
        } ${c.isFavorite ? "is-fav" : ""}`}
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
              <div className="conv-title">
                {c.title}
                {/* Phase 111 (v0.6.60) — streaming 중인 conv 옆 ● dot (트리 모드) */}
                {streamingConvIds?.has(c.id) && (
                  <span
                    title="이 대화에서 작업 진행 중"
                    style={{
                      display: "inline-block",
                      marginLeft: 6,
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: "var(--accent, #66ccff)",
                      boxShadow: "0 0 6px var(--accent, #66ccff)",
                      verticalAlign: "middle",
                      animation: "kda-pulse 1.4s ease-in-out infinite",
                    }}
                  />
                )}
              </div>
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
      </DraggableConv>
    );
  };

  const renderFolder = (f: Folder, depth: number): JSX.Element | null => {
    const expanded = isFolderExpanded(f.id);
    const isEditing = editingState?.kind === "folder" && editingState.id === f.id;
    // 검색 active 면 hit 없는 폴더는 숨김
    if (visibleConvIds && !folderHasHit(f.id)) return null;
    const subFolders = tree.childFolders.get(f.id) ?? [];
    const subConvs = tree.convsInFolder.get(f.id) ?? [];
    return (
      <div key={f.id} className={`folder-block depth-${Math.min(depth, 5)}`}>
        <DndFolder
          folderId={f.id}
          disabled={isEditing}
          className="folder-row"
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
        </DndFolder>
        {expanded && (
          <div className="folder-children">
            {subFolders.map((sf) => renderFolder(sf, depth + 1))}
            {subConvs.map((c) => renderConvItem(c, depth + 1))}
            {/* Phase 38: 이 폴더 안에 새 폴더 만들 때 inline input */}
            {creatingFolder && creatingFolder.parentId === f.id && (
              <div className="folder-row folder-row-creating">
                <span className="folder-toggle">▾</span>
                <span className="folder-icon">📁</span>
                <input
                  ref={createFolderInputRef}
                  className="folder-name-edit"
                  type="text"
                  placeholder="하위 폴더 이름 (Enter=생성, Esc=취소)"
                  value={creatingFolder.name}
                  onChange={(e) => setCreatingFolder({ ...creatingFolder, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitNewFolder();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelNewFolder();
                    }
                  }}
                  onBlur={() => void commitNewFolder()}
                  maxLength={80}
                />
              </div>
            )}
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
      // Phase 107 (v0.6.56) — 폴더 프로젝트 지침 + 첨부 편집 진입
      if (onEditFolderInstructions) {
        items.push({
          label: "📜 프로젝트 지침…",
          action: () => onEditFolderInstructions(id),
        });
      }
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
        label: "📁 폴더로 이동…",
        action: () => setFolderPicker({ convId: id, x: contextMenu.x, y: contextMenu.y }),
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

  // ─── Phase 108 (v0.6.57) — Explorer 모드 렌더 ────────────────────
  // Windows 탐색기 패러다임 — 한 화면에 한 폴더만 + breadcrumb + 위로 가기.
  // 폴더 더블클릭 = 진입, 대화 클릭 = 활성화. 우클릭 메뉴는 기존과 동일.
  // 검색 결과가 있으면 검색 hit 만 표시 (현재 폴더 무관 — 검색은 글로벌).
  const renderExplorerItem = (item: Folder | Conversation, kind: "folder" | "conversation") => {
    if (kind === "folder") {
      const f = item as Folder;
      const childCount = (tree.childFolders.get(f.id) ?? []).length;
      const convCount = (tree.convsInFolder.get(f.id) ?? []).length;
      // Phase 124 (v0.6.79) — Explorer 모드 폴더 인라인 이름 편집 분기.
      const isEditing = editingState?.kind === "folder" && editingState.id === f.id;
      // Phase 113.1 (v0.6.65) — Explorer 폴더 카드에 DnD wrap. 옛 트리 모드의 옮기기
      // 기능을 Explorer 에서 살림 (K 명시: "트리는 제거하되 옮기기 기능은 그대로").
      // DndFolder = draggable + droppable. conv 를 폴더 위에 drop → 이동.
      return (
        <DndFolder
          key={`folder-${f.id}`}
          folderId={f.id}
          className="explorer-item explorer-folder"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px",
            borderRadius: 6,
            cursor: "pointer",
            userSelect: "none",
            background: "transparent",
            transition: "background 0.1s",
          }}
          onDoubleClick={() => {
            if (isEditing) return;
            setCurrentFolderId(f.id);
            setContextMenu(null);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({ type: "folder", id: f.id, x: e.clientX, y: e.clientY });
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = "var(--bg-2, rgba(255,255,255,0.05))";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
          }}
          title={`더블클릭=진입 · 우클릭=메뉴 · 드래그 = 이동 · 하위 ${childCount}폴더 / ${convCount}대화`}
        >
          <span style={{ fontSize: 16 }}>{f.icon ?? "📁"}</span>
          {isEditing ? (
            <input
              ref={editInputRef}
              className="conv-title-edit"
              style={{ flex: 1, fontSize: 13 }}
              value={editingState!.title}
              onChange={(e) => setEditingState({ ...editingState!, title: e.target.value })}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onBlur={() => void commitEdit()}
              onKeyDown={handleEditKeyDown}
              maxLength={120}
              placeholder="이름 (Enter=저장, Esc=취소)"
            />
          ) : (
            <span style={{ flex: 1, fontSize: 13, color: f.color ?? "var(--text, #e8eaff)" }}>
              {f.name}
            </span>
          )}
          {(childCount > 0 || convCount > 0) && (
            <span style={{ fontSize: 10, opacity: 0.45 }}>
              {childCount > 0 ? `📁${childCount} ` : ""}
              {convCount > 0 ? `💬${convCount}` : ""}
            </span>
          )}
        </DndFolder>
      );
    } else {
      const c = item as Conversation;
      const active = c.id === activeConversationId;
      // Phase 124 (v0.6.79) — Explorer 모드 인라인 제목 편집. 옛 트리 모드에만 있던
      // isEditing 분기를 Explorer 로 포팅. 이게 없으면 "제목 변경" 메뉴가
      // editingState 만 세팅하고 그릴 곳이 없어 silent 무반응.
      const isEditing =
        editingState?.kind === "conversation" && editingState.id === c.id;
      // Phase 113.1 (v0.6.65) — Explorer 대화 카드에 DnD wrap.
      // DraggableConv 로 wrap 하면 8px 이동 시 drag 시작 (PointerSensor activation),
      // 짧은 click 은 정상 onClick 호출 → 활성화. drop 처리는 handleDndEnd 가 담당.
      return (
        <DraggableConv
          key={`conv-${c.id}`}
          convId={c.id}
          disabled={isEditing}
          className={`explorer-item explorer-conv ${active ? "active" : ""}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px",
            borderRadius: 6,
            cursor: "pointer",
            userSelect: "none",
            background: active ? "var(--accent-dim, rgba(102,204,255,0.18))" : "transparent",
            transition: "background 0.1s",
            borderLeft: active ? "2px solid var(--accent, #66ccff)" : "2px solid transparent",
          }}
          onClick={() => {
            if (isEditing) return;
            onSelectConversation(c.id);
            setContextMenu(null);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({ type: "conversation", id: c.id, x: e.clientX, y: e.clientY });
          }}
          onMouseEnter={(e) => {
            if (!active) {
              (e.currentTarget as HTMLElement).style.background = "var(--bg-2, rgba(255,255,255,0.05))";
            }
          }}
          onMouseLeave={(e) => {
            if (!active) {
              (e.currentTarget as HTMLElement).style.background = "transparent";
            }
          }}
          title="클릭=열기 · 우클릭=메뉴 · 드래그=폴더로 이동"
        >
          <span style={{ fontSize: 14 }}>
            {c.isFavorite ? "★" : c.icon ?? "💬"}
          </span>
          {isEditing ? (
            <input
              ref={editInputRef}
              className="conv-title-edit"
              style={{ flex: 1, fontSize: 13 }}
              value={editingState!.title}
              onChange={(e) => setEditingState({ ...editingState!, title: e.target.value })}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => void commitEdit()}
              onKeyDown={handleEditKeyDown}
              maxLength={120}
              placeholder="제목 (Enter=저장, Esc=취소)"
            />
          ) : (
            <span
              style={{
                flex: 1,
                fontSize: 13,
                color: c.color ?? "var(--text, #e8eaff)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {c.title}
            </span>
          )}
          {/* Phase 111 (v0.6.60) — streaming 중인 conv 옆 ● dot */}
          {streamingConvIds?.has(c.id) && (
            <span
              title="이 대화에서 작업 진행 중"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--accent, #66ccff)",
                boxShadow: "0 0 6px var(--accent, #66ccff)",
                flexShrink: 0,
                animation: "kda-pulse 1.4s ease-in-out infinite",
              }}
            />
          )}
        </DraggableConv>
      );
    }
  };

  const renderExplorer = () => {
    const subFolders = (tree.childFolders.get(currentFolderId) ?? []).filter(
      (f) => !visibleConvIds || folderHasHit(f.id),
    );
    const convs = (tree.convsInFolder.get(currentFolderId) ?? []).filter(
      (c) => !visibleConvIds || visibleConvIds.has(c.id),
    );
    const currentFolder = currentFolderId
      ? folders.find((f) => f.id === currentFolderId) ?? null
      : null;
    const parentId = currentFolder?.parentId ?? null;
    const canGoUp = currentFolderId !== null;

    return (
      <div
        className="explorer-section"
        style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}
      >
        {/* breadcrumb + 위로 가기 */}
        <div
          className="explorer-breadcrumb"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 8px",
            borderBottom: "1px solid var(--border-dim, #1d2540)",
            background: "var(--bg-1, #0a0e18)",
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => {
              if (canGoUp) setCurrentFolderId(parentId);
            }}
            disabled={!canGoUp}
            title="위로 가기 (Backspace)"
            style={{
              background: "transparent",
              border: "1px solid var(--border-dim, #1d2540)",
              borderRadius: 4,
              color: canGoUp ? "var(--accent, #66ccff)" : "var(--text-dim, #555)",
              cursor: canGoUp ? "pointer" : "default",
              padding: "2px 8px",
              fontSize: 12,
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            ↑
          </button>
          <div
            className="breadcrumb-path"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              fontSize: 11,
              overflowX: "auto",
              flex: 1,
              whiteSpace: "nowrap",
            }}
          >
            <BreadcrumbDropButton
              dropId="__root__"
              onClick={() => setCurrentFolderId(null)}
              isCurrent={currentFolderId === null}
              title="루트 (대화/폴더 drop 시 루트로 이동)"
              label="📁 루트"
            />
            {breadcrumbPath.map((f, i) => {
              const isLast = i === breadcrumbPath.length - 1;
              return (
                <Fragment key={f.id}>
                  <span style={{ color: "var(--text-dim, #555)", fontSize: 10 }}>/</span>
                  <BreadcrumbDropButton
                    dropId={`folder:${f.id}`}
                    onClick={() => setCurrentFolderId(f.id)}
                    isCurrent={isLast}
                    title={`${f.name} (drop = 이 폴더로 이동)`}
                    label={`${f.icon ?? "📁"} ${f.name}`}
                  />
                </Fragment>
              );
            })}
          </div>
        </div>

        {/* 본문 — 폴더 + 대화 list */}
        <div
          className="explorer-body"
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "6px 4px",
          }}
          onContextMenu={(e) => {
            // 빈 공간 우클릭 — 메뉴 닫기
            if (e.target === e.currentTarget) {
              setContextMenu(null);
            }
          }}
        >
          {subFolders.length === 0 && convs.length === 0 ? (
            <div
              style={{
                padding: "20px 12px",
                textAlign: "center",
                opacity: 0.4,
                fontSize: 12,
              }}
            >
              {visibleConvIds ? "검색 결과 없음" : "비어있음"}
              {currentFolderId === null && !visibleConvIds && (
                <div style={{ marginTop: 8, fontSize: 11 }}>
                  상단의 [📁+] 또는 [+ 새 대화] 로 시작하세요
                </div>
              )}
            </div>
          ) : (
            <>
              {subFolders.map((f) => renderExplorerItem(f, "folder"))}
              {convs.map((c) => renderExplorerItem(c, "conversation"))}
            </>
          )}
        </div>
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

  return (
    <aside className="sidebar">
      <DndContext sensors={sensors} onDragStart={handleDndStart} onDragEnd={handleDndEnd}>
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

      {/* 새 대화 + 새 폴더 + 라이브러리 버튼 */}
      <div className="sidebar-actions">
        <button
          className="new-chat-btn"
          onClick={() => {
            // Phase 113 (v0.6.64) — Explorer 모드에서 폴더 안에 있으면 그 folderId 자동 전달.
            // 결과: 새 대화가 그 폴더에 박혀 첫 send 시 폴더 지침 + 첨부 자동 적용.
            const targetFolderId = viewMode === "explorer" ? currentFolderId : null;
            onNewConversation(targetFolderId);
          }}
          title={
            viewMode === "explorer" && currentFolderId
              ? "현재 폴더 안에 새 대화 (폴더 지침 자동 적용)"
              : "새 대화 (루트)"
          }
        >
          <span className="plus">+</span>
          <span>새 대화{viewMode === "explorer" && currentFolderId ? " (📁)" : ""}</span>
        </button>
        {onCreateFolder && (
          <button
            className="new-folder-btn"
            onClick={() => handleNewSubfolder(null)}
            title={
              viewMode === "explorer" && currentFolderId
                ? "현재 폴더 안에 하위폴더 생성"
                : "새 폴더 (root)"
            }
          >
            <span className="plus">📁+</span>
          </button>
        )}
        {/* Phase 112 (v0.6.63) — 대화 라이브러리 진입 (Ctrl+L 단축키 동일) */}
        {onOpenLibrary && (
          <button
            className="new-folder-btn"
            onClick={onOpenLibrary}
            title="대화 라이브러리 (Ctrl+L) — 카드 grid 로 모든 대화 큰 화면 탐색"
            style={{ fontSize: 14 }}
          >
            <span>📚</span>
          </button>
        )}
      </div>

      {/* Phase 113 (v0.6.64) — K 정정 "트리 구조 버려". 뷰 모드 토글 제거. Explorer 만 사용. */}

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

      {/* 대화 목록 (Phase 108: 트리 / 탐색기 viewMode 분기) */}
      <div className="sidebar-section sidebar-tree-section">
        <div className="eyebrow section-label">
          {viewMode === "explorer" ? "탐색기" : "대화 목록"}
        </div>
        {viewMode === "explorer" ? (
          renderExplorer()
        ) : (
        <DroppableRoot className="conv-list root-drop">
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
        </DroppableRoot>
        )}
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

      {/* Phase 38 (v0.5.26): 새 폴더 inline 입력 — root 영역에 박힘 */}
      {creatingFolder && creatingFolder.parentId === null && (
        <div className="folder-create-overlay" onClick={(e) => e.stopPropagation()}>
          <div className="folder-create-box">
            <span className="folder-icon">📁</span>
            <input
              ref={createFolderInputRef}
              className="folder-name-edit"
              type="text"
              placeholder="새 폴더 이름 (Enter=생성, Esc=취소)"
              value={creatingFolder.name}
              onChange={(e) => setCreatingFolder({ ...creatingFolder, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitNewFolder();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelNewFolder();
                }
              }}
              onBlur={() => void commitNewFolder()}
              maxLength={80}
            />
          </div>
        </div>
      )}

      {/* Phase 38: 폴더 picker (대화→폴더 이동 fallback) */}
      {folderPicker && (
        <div
          className="picker-popover folder-picker"
          style={{ left: clampX(folderPicker.x), top: clampY(folderPicker.y) }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="picker-label">폴더 선택 (대화 이동)</div>
          <button
            className="folder-picker-item"
            onClick={() => {
              if (onMoveConversationToFolder) {
                void onMoveConversationToFolder(folderPicker.convId, null, 0);
              }
              setFolderPicker(null);
            }}
          >
            📂 루트 (폴더 밖)
          </button>
          {folders.length === 0 ? (
            <div className="folder-picker-empty">등록된 폴더가 없습니다.</div>
          ) : (
            folders.map((f) => {
              // 자식폴더 깊이로 들여쓰기
              let depth = 0;
              let cur: string | null = f.parentId ?? null;
              while (cur) {
                depth++;
                cur = folders.find((p) => p.id === cur)?.parentId ?? null;
                if (depth > 6) break;
              }
              return (
                <button
                  key={f.id}
                  className="folder-picker-item"
                  style={{ paddingLeft: `${10 + depth * 14}px` }}
                  onClick={() => {
                    if (onMoveConversationToFolder) {
                      void onMoveConversationToFolder(folderPicker.convId, f.id, 0);
                    }
                    setFolderPicker(null);
                  }}
                >
                  {f.icon ?? "📁"} {f.name}
                </button>
              );
            })
          )}
        </div>
      )}

      {/* Phase 38: 폴더 삭제 confirm dialog */}
      {folderDeleteDialog && (
        <div className="folder-delete-overlay" onClick={() => setFolderDeleteDialog(null)}>
          <div className="folder-delete-box" onClick={(e) => e.stopPropagation()}>
            <div className="folder-delete-title">
              📁 "{folderDeleteDialog.folder.name}" 삭제
            </div>
            {folderDeleteDialog.convCount === 0 && folderDeleteDialog.childCount === 0 ? (
              <>
                <div className="folder-delete-msg">빈 폴더입니다. 삭제할까요?</div>
                <div className="folder-delete-actions">
                  <button
                    className="folder-delete-btn primary"
                    onClick={async () => {
                      if (onDeleteFolder) await onDeleteFolder(folderDeleteDialog.folder.id, "moveToParent");
                      setFolderDeleteDialog(null);
                    }}
                  >
                    삭제
                  </button>
                  <button
                    className="folder-delete-btn secondary"
                    onClick={() => setFolderDeleteDialog(null)}
                  >
                    취소
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="folder-delete-msg">
                  안에 <strong>{folderDeleteDialog.convCount}개 대화</strong> +{" "}
                  <strong>{folderDeleteDialog.childCount}개 하위폴더</strong>가 있습니다.
                </div>
                <div className="folder-delete-actions">
                  <button
                    className="folder-delete-btn primary"
                    title="폴더만 지우고 안의 대화/하위폴더는 부모로 이동 (안전)"
                    onClick={async () => {
                      if (onDeleteFolder) await onDeleteFolder(folderDeleteDialog.folder.id, "moveToParent");
                      setFolderDeleteDialog(null);
                    }}
                  >
                    📂 폴더만 지움 (내용 보존)
                  </button>
                  <button
                    className="folder-delete-btn danger"
                    title="폴더 안의 모든 대화 영구 삭제 (되돌릴 수 없음)"
                    onClick={async () => {
                      if (onDeleteFolder) await onDeleteFolder(folderDeleteDialog.folder.id, "deleteAll");
                      setFolderDeleteDialog(null);
                    }}
                  >
                    🗑 전체 삭제 ({folderDeleteDialog.convCount}개 손실)
                  </button>
                  <button
                    className="folder-delete-btn secondary"
                    onClick={() => setFolderDeleteDialog(null)}
                  >
                    취소
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      </DndContext>
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

// ─── Phase 39 (v0.5.27): @dnd-kit wrapper 컴포넌트 ─────────
// 기존 conv-item / folder-row div 의 className/style/onContextMenu 등은 그대로 유지하면서
// dnd-kit 의 setNodeRef + listeners 만 추가. native HTML5 quirk 회피.

interface DraggableConvProps extends React.HTMLAttributes<HTMLDivElement> {
  convId: string;
  disabled?: boolean;
  children: React.ReactNode;
}
function DraggableConv({
  convId,
  disabled,
  className,
  style,
  children,
  ...rest
}: DraggableConvProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `conv:${convId}`,
    disabled,
  });
  const composedStyle: React.CSSProperties = {
    ...style,
    ...(transform
      ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
      : {}),
    ...(isDragging ? { opacity: 0.5, zIndex: 10 } : {}),
  };
  return (
    <div
      ref={setNodeRef}
      className={className}
      style={composedStyle}
      {...attributes}
      {...listeners}
      {...rest}
    >
      {children}
    </div>
  );
}

interface DndFolderProps extends React.HTMLAttributes<HTMLDivElement> {
  folderId: string;
  disabled?: boolean;
  children: React.ReactNode;
}
function DndFolder({
  folderId,
  disabled,
  className,
  style,
  children,
  ...rest
}: DndFolderProps) {
  const draggable = useDraggable({ id: `folder:${folderId}`, disabled });
  const droppable = useDroppable({ id: `folder:${folderId}` });
  const setRef = (node: HTMLElement | null) => {
    draggable.setNodeRef(node);
    droppable.setNodeRef(node);
  };
  const composedStyle: React.CSSProperties = {
    ...style,
    ...(draggable.transform
      ? {
          transform: `translate3d(${draggable.transform.x}px, ${draggable.transform.y}px, 0)`,
        }
      : {}),
    ...(draggable.isDragging ? { opacity: 0.5, zIndex: 10 } : {}),
  };
  const overClass = droppable.isOver ? "drag-over" : "";
  return (
    <div
      ref={setRef}
      className={`${className ?? ""} ${overClass}`.trim()}
      style={composedStyle}
      {...draggable.attributes}
      {...draggable.listeners}
      {...rest}
    >
      {children}
    </div>
  );
}

interface DroppableRootProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}
function DroppableRoot({ className, children, ...rest }: DroppableRootProps) {
  const { setNodeRef, isOver } = useDroppable({ id: "__root__" });
  return (
    <div
      ref={setNodeRef}
      className={`${className ?? ""} ${isOver ? "drag-over" : ""}`.trim()}
      {...rest}
    >
      {children}
    </div>
  );
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

// Phase 113.1 (v0.6.65) — Explorer breadcrumb 의 root / 폴더 chip 을 droppable 박는 컴포넌트.
// K 가 conv (또는 폴더) 를 breadcrumb 의 "📁 루트" 또는 상위 폴더 chip 에 drop 하면
// 그 폴더로 이동 (root 이면 폴더 빼기). 기존 handleDndEnd 가 dropId 보고 라우팅.
// hook (useDroppable) 안전 호출 위해 별도 컴포넌트로 분리 (renderExplorer 안에 hook X).
interface BreadcrumbDropButtonProps {
  dropId: string;
  onClick: () => void;
  isCurrent: boolean;
  title: string;
  label: string;
}
function BreadcrumbDropButton({
  dropId,
  onClick,
  isCurrent,
  title,
  label,
}: BreadcrumbDropButtonProps) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId });
  return (
    <button
      ref={setNodeRef}
      onClick={onClick}
      style={{
        background: isOver
          ? "var(--accent-dim, rgba(102,204,255,0.22))"
          : "transparent",
        border: "none",
        outline: isOver ? "1px dashed var(--accent, #66ccff)" : "none",
        outlineOffset: 1,
        borderRadius: 4,
        color: isCurrent ? "var(--accent, #66ccff)" : "var(--text-dim, #8e9ab5)",
        cursor: "pointer",
        padding: "2px 6px",
        fontSize: 11,
        fontWeight: isCurrent ? 600 : 400,
        maxWidth: 160,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        transition: "background 0.1s, outline 0.1s",
      }}
      title={title}
    >
      {label}
    </button>
  );
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
