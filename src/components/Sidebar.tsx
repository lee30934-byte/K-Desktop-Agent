import o2Mark from "../assets/o2-mark.png";
import { readMockupFixture } from "../dev/mockupFixture";
import { memo, useState, useEffect, useRef, useMemo, useCallback, Fragment } from "react";
import { getVersion } from "@tauri-apps/api/app";
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
import { Icon, type IconName } from "../ui/icons";
import type { Conversation, Folder } from "../types";
// v0.7.86 UI 6단계 — 내보내기/백업/가져오기는 공용 유틸 (헤더 ⋯ '이 대화 내보내기'와 공유)
import {
  exportConversationToFile,
  exportAllConversationsToFile,
  importConversationsFromFile,
} from "../utils/conversationBackup";
import { useUiLayout } from "../utils/useUiLayout";
// Phase 144 (v0.7.20) — W1 대화별 엔진 라벨/선택지 (App 과 동일 source)
import { providerLabel, PINNABLE_PROVIDERS } from "../providerResolve";

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
  // Phase 144 (v0.7.20) — W1 대화별 엔진(provider) 고정. null = 전역 설정 따름.
  onSetConversationProvider?: (id: string, provider: string | null) => Promise<void> | void;
  // v0.7.86 UI 6단계 (o2 전용) — 레일(56px) 접기, ⚡ 작업 내비, 하단 [다시 연결]
  rail?: boolean;
  onToggleRail?: () => void;
  taskCount?: number;
  /** dzA (B) — 예약(대기) 중인 메시지 수 · 자동 실행 보류 여부. 헤더 작업 칩을 사이드바 '작업' 배지로 합쳤다 */
  taskQueued?: number;
  tasksPaused?: boolean;
  onOpenTasks?: () => void;
  onReconnectTools?: () => void;
}

// dzA (o2) — 사용자가 고른 대화·폴더 이모지 중 흔한 것은 같은 뜻의 라인 아이콘으로 (목업 v2.1). 그 밖의 이모지는 고른 그대로 둔다.
const O2_GLYPH_ICONS: Record<string, IconName> = {
  "💬": "msg", "🗨️": "msg", "📊": "sheet", "📈": "sheet", "📝": "note", "🗒️": "note", "📄": "file", "📃": "file", "📑": "file",
  "✈️": "send", "📨": "send", "🖼️": "image", "🖼": "image", "📷": "camera", "📁": "folder", "📂": "folder", "🗂️": "folder",
  "🧾": "file", "⚙️": "settings", "🔧": "wrench", "🤖": "bot", "🌐": "globe", "🔒": "lock",
};
function o2Glyph(icon: string | null | undefined, fallback: IconName) {
  if (!icon) return <Icon name={fallback} />;
  const name = O2_GLYPH_ICONS[icon] ?? O2_GLYPH_ICONS[icon.replace(/️/g, "")] ?? O2_GLYPH_ICONS[`${icon}️`];
  return name ? <Icon name={name} /> : icon;
}
// dzA (o2) — 최근 대화 옆 상대 시간 (2시간 · 어제 · 11월 8일)
function o2RelTime(ts: number, now = Date.now()) {
  const min = Math.floor((now - ts) / 60_000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}시간`;
  const d = new Date(ts);
  const y = new Date(now); y.setHours(0, 0, 0, 0); y.setDate(y.getDate() - 1);
  if (d >= y) return "어제";
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}
// dzA (o2) — 우클릭·⋯ 메뉴: 앞 글자 기호 대신 라인 아이콘. '즐겨찾기'는 사이드바 묶음 이름(고정됨)에 맞춰 '고정'
const O2_MENU_ICONS: Record<string, IconName> = {
  "📁": "folderPlus", "✎": "pencil", "🎨": "palette", "💠": "app", "📜": "note", "🗑": "trash",
  "★": "pin", "☆": "pin", "🤖": "bot", "📂": "arrowUpLevel",
};
function o2MenuLabel(label: string) {
  const sp = label.indexOf(" ");
  const lead = sp > 0 ? label.slice(0, sp) : "";
  let name = O2_MENU_ICONS[lead];
  if (!name) return label;
  let text = label.slice(sp + 1);
  if (lead === "★") text = "고정 해제";
  else if (lead === "☆") text = "고정";
  else if (lead === "📁" && text.startsWith("폴더로")) name = "folder";
  return <><Icon name={name} />{text}</>;
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
  onSetConversationProvider,
  rail = false,
  onToggleRail,
  taskCount = 0,
  taskQueued = 0,
  tasksPaused = false,
  onOpenTasks,
  onReconnectTools,
}: SidebarProps) {
  // v0.7.86 UI 6단계 — o2 는 단순화된 사이드바(내비 3줄 · '대화' 섹션 · 하단 고정 행 · 레일),
  // classic 은 예전 구조(새 폴더/📚 버튼 줄 · 검색창 · 백업 details · 환경설정 · K-PERSONAL footer) 그대로.
  const { isO2 } = useUiLayout();
  const railMode = isO2 && rail;
  // o2 내비 '🔍 검색' — 누르면 같은 자리에서 입력창으로 펼침
  const [searchOpen, setSearchOpen] = useState(false);
  // v0.7.86 UI 8단계 — o2 의 백업·가져오기는 설정 › 데이터·백업 › 대화 백업으로 옮겼다 (classic 은 아래 details 그대로)
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
  // v0.7.86 fidA — 개발용 목업 픽스처(DEV + ?fixture=mockup)면 픽스처 폴더가 들어온 뒤 한 번만 그 폴더로 (배포 빌드는 null)
  const fixtureFolderRef = useRef<string | null>(readMockupFixture()?.currentFolderId ?? null);
  useEffect(() => {
    const id = fixtureFolderRef.current;
    if (id && folders.some((f) => f.id === id)) { fixtureFolderRef.current = null; setCurrentFolderId(id); }
  }, [folders]);
  // v0.7.86 fidA (o2) — Ctrl+N = 새 대화 (지금 폴더 안). 목업의 [새 대화  Ctrl+N]. classic 은 단축키 없음(예전 그대로).
  const newHereRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!isO2) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newHereRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isO2]);

  // 브랜드 헤더 버전 — Tauri 앱 버전(tauri.conf.json/Cargo)을 따라감.
  // 하드코딩 "V0.1.0" 금지 (릴리스해도 안 바뀌던 버그). getVersion 으로 런타임 주입.
  const [appVersion, setAppVersion] = useState<string>("");
  useEffect(() => {
    getVersion()
      .then((v) => setAppVersion(v))
      .catch(() => {
        /* 브라우저/비-Tauri 환경 — 버전 미표시 */
      });
  }, []);

  // 검색
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<Set<string> | null>(null);

  // 우클릭 메뉴
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // 색상/아이콘 picker
  const [pickerState, setPickerState] = useState<
    | { kind: "color"; type: "folder" | "conversation"; id: string; x: number; y: number }
    | { kind: "icon"; type: "folder" | "conversation"; id: string; x: number; y: number }
    // Phase 144 (v0.7.20) — W1 대화별 엔진(provider) 지정
    | { kind: "provider"; type: "conversation"; id: string; x: number; y: number }
    | null
  >(null);

  // Phase 38 (v0.5.26) — 폴더 생성 inline 입력 (prompt() 가 Tauri webview 에서 막힘 fallback)
  const [creatingFolder, setCreatingFolder] = useState<{ parentId: string | null; name: string } | null>(null);
  const createFolderInputRef = useRef<HTMLInputElement | null>(null);

  // Phase 38 — 폴더 picker (대화→폴더 이동 fallback, DnD 안 될 때)
  const [folderPicker, setFolderPicker] = useState<{
    convIds: string[];
    x: number;
    y: number;
  } | null>(null);
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [selectedConvIds, setSelectedConvIds] = useState<Set<string>>(() => new Set());
  const [bulkMovePending, setBulkMovePending] = useState(false);

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

  useEffect(() => {
    const liveIds = new Set(conversations.map((c) => c.id));
    setSelectedConvIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (liveIds.has(id)) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [conversations]);

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

  const toggleBulkSelection = useCallback((convId: string) => {
    setSelectedConvIds((prev) => {
      const next = new Set(prev);
      if (next.has(convId)) next.delete(convId);
      else next.add(convId);
      return next;
    });
  }, []);

  const setBulkSelectionFor = useCallback((convIds: string[], selected: boolean) => {
    setSelectedConvIds((prev) => {
      const next = new Set(prev);
      for (const id of convIds) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const moveConversationsToFolder = useCallback(
    async (convIds: string[], folderId: string | null) => {
      if (!onMoveConversationToFolder || convIds.length === 0) return;
      setBulkMovePending(true);
      try {
        for (let i = 0; i < convIds.length; i++) {
          await onMoveConversationToFolder(convIds[i], folderId, i);
        }
        setSelectedConvIds((prev) => {
          const next = new Set(prev);
          for (const id of convIds) next.delete(id);
          return next;
        });
        if (bulkSelectMode) setBulkSelectMode(false);
      } finally {
        setBulkMovePending(false);
      }
    },
    [bulkSelectMode, onMoveConversationToFolder],
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
                {/* Phase 144 (v0.7.20) — 엔진이 고정된 대화만 배지. 미지정(전역 따름)은 표시 없음 */}
                {c.provider && (
                  <span
                    title={`이 대화는 ${providerLabel(c.provider)} 로 고정됨 (전역 설정 무관)`}
                    style={{
                      marginLeft: 6,
                      padding: "0 5px",
                      borderRadius: 4,
                      border: "1px solid var(--border)",
                      opacity: 0.85,
                    }}
                  >
                    {providerLabel(c.provider)}
                  </span>
                )}
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

  // 현재 대화 내보내기 / 전체 백업 / 가져오기 — 본문은 utils/conversationBackup.ts
  const handleExportCurrent = () => exportConversationToFile(activeConversationId);
  const handleExportAll = () => exportAllConversationsToFile();
  const handleImport = () => importConversationsFromFile(onRefreshConversations);

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
          label: "📜 폴더 지침…",
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
      // Phase 144 (v0.7.20) — W1: 이 대화만의 엔진 고정. 미지정이면 "전역 따름".
      // 라벨에 현재 상태를 그대로 노출해, 폴백 중인지 고정됐는지가 메뉴에서 바로 보이게 한다.
      if (onSetConversationProvider) {
        items.push({
          label: `🤖 엔진: ${providerLabel(c?.provider ?? null)}…`,
          action: () => setPickerState({ kind: "provider", type: "conversation", id, x, y }),
        });
      }
      items.push({
        label: "📁 폴더로 이동…",
        action: () => setFolderPicker({ convIds: [id], x: contextMenu.x, y: contextMenu.y }),
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
            {isO2 ? o2MenuLabel(it.label) : it.label}
          </button>
        ))}
      </div>
    );
  };

  // ─── Phase 108 (v0.6.57) — Explorer 모드 렌더 ────────────────────
  // Windows 탐색기 패러다임 — 한 화면에 한 폴더만 + breadcrumb + 위로 가기.
  // 폴더 더블클릭 = 진입, 대화 클릭 = 활성화. 우클릭 메뉴는 기존과 동일.
  // 검색 결과가 있으면 검색 hit 만 표시 (현재 폴더 무관 — 검색은 글로벌).
  // v0.7.86 UI 6단계 (o2) — 행 hover ⋯ : 우클릭과 같은 메뉴. 드래그(PointerSensor)·클릭·더블클릭으로 새지 않게 막는다.
  const renderRowMore = (type: "folder" | "conversation", id: string) => (
    <button
      type="button"
      className="explorer-row-more"
      aria-label={type === "folder" ? "폴더 메뉴" : "대화 메뉴"}
      title="메뉴 (우클릭과 같음)"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        setContextMenu({ type, id, x: r.left, y: r.bottom + 2 });
      }}
    >
      <Icon name="more" size={14} />
    </button>
  );
  // dzA (o2) — 대화 줄에 올리면(또는 키보드 포커스) [고정 · 제목 변경 · ⋯]. 모두 기존 동작(즐겨찾기 토글 · 제목 변경 · 우클릭 메뉴)
  const stopRow = {
    onPointerDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
    onDoubleClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  };
  const renderConvActions = (c: Conversation) => (
    <span className="explorer-acts">
      {onToggleFavorite && (
        <button type="button" className="explorer-act" {...stopRow} aria-pressed={!!c.isFavorite}
          aria-label={c.isFavorite ? "고정 해제" : "고정"} title={c.isFavorite ? "고정 해제" : "고정"}
          onClick={(e) => { e.stopPropagation(); void onToggleFavorite(c.id); }}>
          <Icon name="pin" size={14} />
        </button>
      )}
      <button type="button" className="explorer-act" {...stopRow} aria-label="제목 변경" title="제목 변경"
        onClick={(e) => { e.stopPropagation(); startEditConv(c.id, c.title); }}>
        <Icon name="pencil" size={14} />
      </button>
      {renderRowMore("conversation", c.id)}
    </span>
  );

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
          style={isO2 ? undefined : {
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
          onMouseEnter={isO2 ? undefined : (e) => {
            (e.currentTarget as HTMLElement).style.background = "var(--bg-2, rgba(255,255,255,0.05))";
          }}
          onMouseLeave={isO2 ? undefined : (e) => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
          }}
          title={`더블클릭=진입 · 우클릭=메뉴 · 드래그 = 이동 · 하위 ${childCount}폴더 / ${convCount}대화`}
        >
          <span className="explorer-icon" style={isO2 ? undefined : { fontSize: 16 }}>{isO2 ? o2Glyph(f.icon, "folder") : f.icon ?? "📁"}</span>
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
            <span className="explorer-title" style={isO2 ? (f.color ? { color: f.color } : undefined) : { flex: 1, fontSize: 13, color: f.color ?? "var(--text, #e8eaff)" }}>
              {f.name}
            </span>
          )}
          {!isO2 && (childCount > 0 || convCount > 0) && (
            <span style={{ fontSize: 10, opacity: 0.45 }}>
              {childCount > 0 ? `📁${childCount} ` : ""}
              {convCount > 0 ? `💬${convCount}` : ""}
            </span>
          )}
          {isO2 && !isEditing && convCount + childCount > 0 && <span className="explorer-meta">{convCount + childCount}</span>}
          {isO2 && !isEditing && <span className="explorer-acts">{renderRowMore("folder", f.id)}</span>}
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
      const selected = selectedConvIds.has(c.id);
      // Phase 113.1 (v0.6.65) — Explorer 대화 카드에 DnD wrap.
      // DraggableConv 로 wrap 하면 8px 이동 시 drag 시작 (PointerSensor activation),
      // 짧은 click 은 정상 onClick 호출 → 활성화. drop 처리는 handleDndEnd 가 담당.
      return (
        <DraggableConv
          key={`conv-${c.id}`}
          convId={c.id}
          disabled={isEditing || bulkSelectMode}
          className={`explorer-item explorer-conv ${active ? "active" : ""} ${selected ? "selected" : ""}`}
          style={isO2 ? undefined : {
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px",
            borderRadius: 6,
            cursor: "pointer",
            userSelect: "none",
            background: active || selected ? "var(--accent-dim, rgba(102,204,255,0.18))" : "transparent",
            transition: "background 0.1s",
            borderLeft: active ? "2px solid var(--accent, #66ccff)" : "2px solid transparent",
          }}
          onClick={() => {
            if (isEditing) return;
            if (bulkSelectMode) {
              toggleBulkSelection(c.id);
              return;
            }
            onSelectConversation(c.id);
            setContextMenu(null);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({ type: "conversation", id: c.id, x: e.clientX, y: e.clientY });
          }}
          onMouseEnter={isO2 ? undefined : (e) => {
            if (!active && !selected) {
              (e.currentTarget as HTMLElement).style.background = "var(--bg-2, rgba(255,255,255,0.05))";
            }
          }}
          onMouseLeave={isO2 ? undefined : (e) => {
            if (!active && !selected) {
              (e.currentTarget as HTMLElement).style.background = "transparent";
            }
          }}
          title="클릭=열기 · 우클릭=메뉴 · 드래그=폴더로 이동"
        >
          {bulkSelectMode && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => toggleBulkSelection(c.id)}
              onClick={(e) => e.stopPropagation()}
              title="Select conversation"
              style={{ width: 14, height: 14, flexShrink: 0 }}
            />
          )}
          <span className={`explorer-icon${c.isFavorite && !isO2 ? " is-star" : ""}`} style={isO2 ? undefined : { fontSize: 14 }}>
            {isO2 ? o2Glyph(c.icon, "msg") : c.isFavorite ? "★" : c.icon ?? "💬"}
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
              className="explorer-title"
              style={isO2 ? (c.color ? { color: c.color } : undefined) : {
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
          {streamingConvIds?.has(c.id) && (isO2 ? (
            <span className="explorer-live" title="이 대화에서 작업 진행 중" aria-label="작업 진행 중" />
          ) : (
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
          ))}
          {isO2 && !isEditing && !streamingConvIds?.has(c.id) && <span className="explorer-meta">{o2RelTime(c.lastActive)}</span>}
          {isO2 && !isEditing && !bulkSelectMode && renderConvActions(c)}
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
    const visibleConvIdsInFolder = convs.map((c) => c.id);
    const selectedVisibleCount = visibleConvIdsInFolder.filter((id) => selectedConvIds.has(id)).length;
    const allVisibleSelected =
      visibleConvIdsInFolder.length > 0 && selectedVisibleCount === visibleConvIdsInFolder.length;

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
          className="bulk-organize-bar"
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
            type="button"
            className="folder-picker-item"
            style={{ width: "auto", padding: "4px 8px", fontSize: 11 }}
            onClick={() => {
              const nextMode = !bulkSelectMode;
              setBulkSelectMode(nextMode);
              if (!nextMode) setSelectedConvIds(new Set<string>());
            }}
            title="여러 대화를 선택해서 폴더로 이동"
          >
            {bulkSelectMode ? "정리 종료" : "대량 정리"}
          </button>
          {bulkSelectMode && (
            <>
              <button
                type="button"
                className="folder-picker-item"
                style={{ width: "auto", padding: "4px 8px", fontSize: 11 }}
                disabled={visibleConvIdsInFolder.length === 0}
                onClick={() => setBulkSelectionFor(visibleConvIdsInFolder, !allVisibleSelected)}
              >
                {allVisibleSelected ? "보이는 항목 해제" : "보이는 항목 선택"}
              </button>
              <button
                type="button"
                className="folder-picker-item"
                style={{ width: "auto", padding: "4px 8px", fontSize: 11 }}
                disabled={selectedConvIds.size === 0 || bulkMovePending}
                onClick={(e) =>
                  setFolderPicker({
                    convIds: Array.from(selectedConvIds),
                    x: e.currentTarget.getBoundingClientRect().left,
                    y: e.currentTarget.getBoundingClientRect().bottom + 4,
                  })
                }
              >
                이동 {selectedConvIds.size}
              </button>
              <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.55 }}>
                {selectedVisibleCount}/{visibleConvIdsInFolder.length}
              </span>
            </>
          )}
        </div>

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

  // ─── v0.7.86 fidA (o2) — 목업 모양의 탐색기 ─────────────────────────────
  // classic 의 renderExplorer 는 그대로 두고 o2 만 별도로 그린다. 같은 DnD 컴포넌트·우클릭 메뉴·대량 정리를 쓴다.
  // 위: 경로(루트 › 업무, 누르면 그 폴더로 이동 · 끌어다 놓으면 그 폴더로 옮김 · Backspace = 위로)
  // 목록: ★ 고정 대화(어느 폴더에 있든) → '폴더' → '대화'. 비어 있으면 작은 안내 문구만.
  const renderO2Explorer = () => {
    const hit = (c: Conversation) => !visibleConvIds || visibleConvIds.has(c.id);
    const subFolders = (tree.childFolders.get(currentFolderId) ?? []).filter((f) => !visibleConvIds || folderHasHit(f.id));
    const convs = (tree.convsInFolder.get(currentFolderId) ?? []).filter(hit);
    const pinned = conversations.filter((c) => c.isFavorite && hit(c));
    const pinnedIds = new Set(pinned.map((c) => c.id));
    const rest = convs.filter((c) => !pinnedIds.has(c.id));
    const visibleIds = convs.map((c) => c.id);
    const selectedVisible = visibleIds.filter((id) => selectedConvIds.has(id)).length;
    const allSelected = visibleIds.length > 0 && selectedVisible === visibleIds.length;
    const empty = pinned.length === 0 && subFolders.length === 0 && rest.length === 0;
    return (
      <div className="explorer-section sb-explorer">
        {/* dzA — 목록 묶음: 고정됨 → 폴더(머리에 새 폴더·여러 대화 선택, 하위 폴더면 경로 줄) → 최근 */}
        <div className="explorer-body sb-tree" onContextMenu={(e) => { if (e.target === e.currentTarget) setContextMenu(null); }}>
          {pinned.length > 0 && <div className="sb-grp-label">고정됨</div>}
          {pinned.map((c) => renderExplorerItem(c, "conversation"))}
          {renderSectionHead()}
          {currentFolderId !== null && (
            <nav className="sb-crumb explorer-breadcrumb" aria-label="현재 폴더">
              <Icon name="arrowUpLevel" size={14} />
              <BreadcrumbDropButton plain dropId="__root__" onClick={() => setCurrentFolderId(null)} isCurrent={false}
                title="루트로 · 끌어다 놓으면 루트로 옮김" label="루트" />
              {breadcrumbPath.map((f, i) => (
                <Fragment key={f.id}>
                  <Icon name="chevronRight" size={14} />
                  <BreadcrumbDropButton plain dropId={`folder:${f.id}`} onClick={() => setCurrentFolderId(f.id)} isCurrent={i === breadcrumbPath.length - 1}
                    title={`${f.name} · 끌어다 놓으면 이 폴더로 옮김`} label={f.name} />
                </Fragment>
              ))}
            </nav>
          )}
          {subFolders.map((f) => renderExplorerItem(f, "folder"))}
          {rest.length > 0 && <div className="sb-grp-label">최근</div>}
          {rest.map((c) => renderExplorerItem(c, "conversation"))}
          {empty && (
            <div className="sb-empty">{visibleConvIds ? "검색 결과가 없어요" : currentFolderId ? "이 폴더는 비어 있어요" : "아직 대화가 없어요"}</div>
          )}
        </div>
        {bulkSelectMode && (
          <div className="bulk-organize-bar sb-bulk">
            <button type="button" onClick={toggleBulkMode} title="여러 대화 선택 끝내기">정리 종료</button>
            <button type="button" disabled={visibleIds.length === 0} onClick={() => setBulkSelectionFor(visibleIds, !allSelected)}>
              {allSelected ? "보이는 항목 해제" : "보이는 항목 선택"}
            </button>
            <button type="button" disabled={selectedConvIds.size === 0 || bulkMovePending}
              onClick={(e) => setFolderPicker({ convIds: Array.from(selectedConvIds), x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4 })}>
              이동 {selectedConvIds.size}
            </button>
            <span className="sb-bulk-count">{selectedVisible}/{visibleIds.length}</span>
          </div>
        )}
      </div>
    );
  };

  // ─── 색상/아이콘 picker 렌더 ───────────────────────────────
  const renderPicker = () => {
    if (!pickerState) return null;
    const { kind, type, id, x, y } = pickerState;
    // Phase 144 (v0.7.20) — W1 대화별 엔진 선택.
    // null(전역 따름) 을 첫 항목으로 둬서 "폴백 상태로 되돌리기" 가 항상 가능하게 한다.
    if (kind === "provider") {
      const conv = conversations.find((x) => x.id === id);
      const current = conv?.provider ?? null;
      const streaming = streamingConvIds?.has(id) ?? false;
      return (
        <div
          className="picker-popover"
          style={{ left: clampX(x), top: clampY(y), minWidth: 190 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="picker-label">이 대화의 엔진</div>
          {PINNABLE_PROVIDERS.map((p) => (
            <button
              key={p ?? "__global__"}
              className={`ctx-item ${current === p ? "active" : ""}`}
              style={{ width: "100%", textAlign: "left" }}
              onClick={() => {
                if (onSetConversationProvider) void onSetConversationProvider(id, p);
                setPickerState(null);
              }}
            >
              {current === p ? "● " : "　"}
              {providerLabel(p)}
              {p === null ? " (기본)" : ""}
            </button>
          ))}
          {streaming && (
            <div className="picker-label" style={{ opacity: 0.7, fontSize: 11, marginTop: 6 }}>
              ⏳ 응답 중 — 변경은 다음 턴부터 적용됩니다
            </div>
          )}
        </div>
      );
    }
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

  // ─── v0.7.86 UI 6단계 — o2 사이드바 조각 (classic 은 아래 JSX 의 예전 구조) ───────────
  // 새 대화: 탐색기에서 폴더 안이면 그 폴더에 만들고 폴더 지침 자동 적용 (classic 과 같은 동작)
  const handleNewConversationHere = () => {
    onNewConversation(viewMode === "explorer" ? currentFolderId : null);
  };
  newHereRef.current = handleNewConversationHere;
  const currentFolderName = currentFolderId ? folders.find((f) => f.id === currentFolderId)?.name : undefined;
  const toggleBulkMode = () => {
    const nextMode = !bulkSelectMode;
    setBulkSelectMode(nextMode);
    if (!nextMode) setSelectedConvIds(new Set<string>());
  };
  const connLabel = mcpConnected ? "컴퓨터 도구 연결됨" : "도구 연결 끊김";

  const renderO2Top = () => (
    <>
      <div className="sidebar-actions sb-top">
        <button
          className="new-chat-btn"
          onClick={handleNewConversationHere}
          title={currentFolderName ? `현재 폴더(📁 ${currentFolderName}) 안에 새 대화 · 폴더 지침 자동 적용 (Ctrl+N)` : "새 대화 (Ctrl+N)"}
          aria-label={currentFolderName ? `새 대화 (📁 ${currentFolderName})` : "새 대화"}
        >
          <span className="plus"><Icon name="plus" /></span>
          {/* fidA — 목업처럼 '새 대화' 만. 지금 폴더는 바로 아래 경로(루트 › 업무)와 툴팁에 보인다 */}
          <span className="new-chat-label">새 대화</span>
          <span className="sb-kbd sb-kbd--keys" aria-hidden="true"><kbd>Ctrl</kbd><kbd>N</kbd></span>
        </button>
      </div>
      <nav className="sb-nav" aria-label="사이드바 메뉴">
        {onSearchConversations && (searchOpen || searchQuery ? (
          <div className="sidebar-search sb-search">
            <input
              type="text"
              className="search-input"
              placeholder="제목 / 메시지 검색"
              aria-label="대화 검색"
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setSearchQuery(""); setSearchOpen(false); }
              }}
              onBlur={() => { if (!searchQuery) setSearchOpen(false); }}
            />
            {searchQuery && (
              <button className="search-clear" onClick={() => { setSearchQuery(""); setSearchOpen(false); }} title="검색 해제">
                ✕
              </button>
            )}
          </div>
        ) : (
          <button type="button" className="sb-nav-item" onClick={() => setSearchOpen(true)}>
            <span className="sb-nav-icon" aria-hidden="true"><Icon name="search" /></span><span>검색</span>
          </button>
        ))}
        {onOpenLibrary && (
          <button type="button" className="sb-nav-item" onClick={onOpenLibrary} title="대화 라이브러리 — 모든 대화를 카드로 크게 보기">
            <span className="sb-nav-icon" aria-hidden="true"><Icon name="book" /></span><span>라이브러리</span><span className="sb-kbd">Ctrl+L</span>
          </button>
        )}
        {onOpenTasks && (
          <button type="button" className="sb-nav-item" onClick={onOpenTasks} title="작업 패널 열기">
            <span className="sb-nav-icon" aria-hidden="true"><Icon name="zap" /></span><span>작업</span>
            {/* dzA (B) — 헤더 'n 실행 · n 예약' 칩을 이 배지로 합침 (같은 작업 패널 열기) */}
            {(taskCount > 0 || taskQueued > 0) && (
              <span className={`sb-badge${taskCount === 0 ? " sb-badge--idle" : ""}`}
                aria-label={`실행 중 ${taskCount}개${taskQueued > 0 ? ` · 예약 ${taskQueued}개` : ""}`}
                title={`실행 ${taskCount}${taskQueued > 0 ? ` · 예약 ${taskQueued}` : ""}${tasksPaused ? " · 자동 실행 보류" : ""}`}>
                {taskCount}{taskQueued > 0 && <span className="sb-badge__sub">+{taskQueued}</span>}
              </span>
            )}
            {tasksPaused && <span className="sb-paused" title="자동 실행 보류 중" aria-label="자동 실행 보류 중"><Icon name="pause" size={14} /></span>}
          </button>
        )}
      </nav>
    </>
  );

  const renderSectionHead = () => (
    <div className="sb-sec-head sb-grp-head">
      <span className="eyebrow section-label">폴더</span>
      <span className="sb-sec-tools">
        {onCreateFolder && (
          <button type="button" onClick={() => handleNewSubfolder(null)} aria-label="새 폴더"
            title={currentFolderName ? "현재 폴더 안에 새 폴더" : "새 폴더"}><Icon name="folderPlus" size={15} /></button>
        )}
        <button type="button" onClick={toggleBulkMode} aria-pressed={bulkSelectMode} aria-label="여러 대화 선택"
          title={bulkSelectMode ? "정리 종료" : "여러 대화 선택해서 폴더로 이동"}><Icon name="checkSquare" size={15} /></button>
      </span>
    </div>
  );

  const renderO2Foot = () => (
    <div className="sb-foot">
      <span className={`sb-conn${mcpConnected ? "" : " sb-conn--off"}`} title="K-Personal MCP (컴퓨터 도구)">
        <span className={`status-dot ${mcpConnected ? "status-dot-live" : "status-dot-off"}`} aria-hidden="true" />
        {/* 끊겼을 땐 [다시 연결] 자리를 위해 짧게 (전체 문구는 툴팁) */}
        <span className="sb-conn-label" title={connLabel}>{mcpConnected ? "도구 연결됨" : "연결 끊김"}</span>
        {!mcpConnected && onReconnectTools && (
          <button type="button" className="sb-reconnect" onClick={onReconnectTools}>다시 연결</button>
        )}
      </span>
      <button type="button" className="sb-settings" onClick={onOpenSettings} title="설정">
        <Icon name="settings" /><span>설정</span>
      </button>
    </div>
  );

  // 레일(56px): 심볼 · 새 대화 · 검색 · 라이브러리 · 작업 · (빈 공간) · ● · 설정 (10단계: 라인 아이콘)
  const renderRail = () => (
    <nav className="sb-rail" aria-label="사이드바 (접힘)">
      <button type="button" className="brand-logo brand-logo-btn" onClick={onToggleRail}
        aria-label="사이드바 펼치기" title={`O2 AGENT${appVersion ? ` v${appVersion}` : ""} · 사이드바 펼치기 (Ctrl+B)`}>
        <img src={o2Mark} width={28} height={28} alt="" draggable={false} />
      </button>
      <button type="button" className="sb-rail-btn" onClick={handleNewConversationHere} aria-label="새 대화"
        title={currentFolderName ? `새 대화 (📁 ${currentFolderName})` : "새 대화"}><Icon name="plus" size={18} /></button>
      {onSearchConversations && (
        <button type="button" className="sb-rail-btn" aria-label="검색" title="검색 (사이드바를 펼칩니다)"
          onClick={() => { setSearchOpen(true); onToggleRail?.(); }}><Icon name="search" size={18} /></button>
      )}
      {onOpenLibrary && (
        <button type="button" className="sb-rail-btn" onClick={onOpenLibrary} aria-label="라이브러리" title="라이브러리 (Ctrl+L)"><Icon name="book" size={18} /></button>
      )}
      {onOpenTasks && (
        <button type="button" className="sb-rail-btn" onClick={onOpenTasks} aria-label="작업" title={taskCount > 0 ? `작업 ${taskCount}개 실행 중` : "작업"}>
          <Icon name="zap" size={18} />{taskCount > 0 && <span className="sb-rail-badge">{taskCount}</span>}
        </button>
      )}
      <span className="sb-rail-grow" />
      {mcpConnected || !onReconnectTools ? (
        <span className={`status-dot ${mcpConnected ? "status-dot-live" : "status-dot-off"} sb-rail-dot`} role="img" aria-label={connLabel} title={connLabel} />
      ) : (
        <button type="button" className="sb-rail-btn sb-rail-reconnect" onClick={onReconnectTools} aria-label="도구 다시 연결" title="도구 연결 끊김 · 눌러서 다시 연결">
          <span className="status-dot status-dot-off" aria-hidden="true" />
        </button>
      )}
      <button type="button" className="sb-rail-btn" onClick={onOpenSettings} aria-label="설정" title="설정"><Icon name="settings" size={18} /></button>
    </nav>
  );

  // 트리 root level (parent_id = null) 자식 폴더 + 대화
  const rootFolders = tree.childFolders.get(null) ?? [];
  const rootConvs = tree.convsInFolder.get(null) ?? [];

  return (
    <aside className={`sidebar${isO2 ? " sidebar--o2" : ""}${railMode ? " sidebar--rail" : ""}${bulkSelectMode ? " sidebar--bulk" : ""}`}>
      <DndContext sensors={sensors} onDragStart={handleDndStart} onDragEnd={handleDndEnd}>
      {railMode ? renderRail() : (<>
      {/* 브랜드 헤더 */}
      <div className="sidebar-brand">
        {isO2 ? (
          // v0.7.86 UI 6단계 — o2 는 심볼을 누르면 레일로 접힘 (Ctrl+B)
          <button type="button" className="brand-logo brand-logo-btn" onClick={onToggleRail}
            aria-label="사이드바 접기" title={`O2 AGENT${appVersion ? ` v${appVersion}` : ""} · 클릭하면 접기 (Ctrl+B)`}>
            <img src={o2Mark} width={30} height={30} alt="" draggable={false} />
          </button>
        ) : (
        <div className="brand-logo" aria-hidden="true">
          {/* v0.7.86 — O2 심볼 (GPT 이미지 생성, evidence/o2-symbol-20261111/b). 앱 아이콘과 같은 원본 */}
          <img src={o2Mark} width={30} height={30} alt="" draggable={false} />
        </div>
        )}
        {/* v0.7.86 — K 요청: 줄바꿈 없이 한 줄로 'O₂ AGENT' + 오른쪽 끝 버전. 부제는 툴팁 */}
        <div className="brand-text brand-text-inline" title={`O2 — 동원의 에이전트${appVersion ? ` · v${appVersion}` : ""}`}>
          <span className="brand-name brand-name-o2" aria-label="O2 AGENT">O<sub>2</sub><span className="brand-word">AGENT</span></span>
          {appVersion && <span className="brand-sub brand-version">v{appVersion}</span>}
        </div>
        {/* dzA (o2) — 목업 v2.1: 브랜드 줄 오른쪽 끝 접기 버튼 (심볼 클릭 · Ctrl+B 와 같은 동작) */}
        {isO2 && onToggleRail && (
          <button type="button" className="sb-collapse" onClick={onToggleRail} aria-label="사이드바 접기 (Ctrl+B)" title="사이드바 접기 (Ctrl+B)">
            <Icon name="panelRight" size={14} />
          </button>
        )}
      </div>

      {isO2 ? renderO2Top() : (<>
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
      </>)}

      {/* Phase 36 (v0.5.24): 즐겨찾기는 별도 섹션 X — ★ 아이콘 + 자동 정렬로 통합 */}

      {/* 대화 목록 (Phase 108: 트리 / 탐색기 viewMode 분기) */}
      <div className="sidebar-section sidebar-tree-section">
        {/* dzA (o2) — '대화' 머리 + 경로 줄을 따로 두지 않는다. 새 폴더·여러 대화 선택 도구는 목록 안 '폴더' 묶음 머리로 옮김 */}
        {isO2 ? null : (
        <div className="eyebrow section-label">
          {viewMode === "explorer" ? "탐색기" : "대화 목록"}
        </div>
        )}
        {isO2 && viewMode === "explorer" ? renderO2Explorer() : viewMode === "explorer" ? (
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

      {isO2 ? renderO2Foot() : (<>
      {/* 백업/복구 */}
      <details className="sidebar-section sidebar-backup">
        <summary>백업·가져오기</summary>
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
      </details>

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
      </>)}
      </>)}

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
              void moveConversationsToFolder(folderPicker.convIds, null);
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
                    void moveConversationsToFolder(folderPicker.convIds, f.id);
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
  /** v0.7.86 fidA (o2) — 인라인 스타일 없이 CSS(.sb-crumb-btn)로 그리는 평평한 경로 글자 */
  plain?: boolean;
}
function BreadcrumbDropButton({
  dropId,
  onClick,
  isCurrent,
  title,
  label,
  plain,
}: BreadcrumbDropButtonProps) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId });
  if (plain) {
    return (
      <button ref={setNodeRef} type="button" onClick={onClick} title={title} aria-current={isCurrent ? "location" : undefined}
        className={`sb-crumb-btn${isCurrent ? " is-current" : ""}${isOver ? " is-over" : ""}`}>
        {label}
      </button>
    );
  }
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
