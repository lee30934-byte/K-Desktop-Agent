// ─────────────────────────────────────────────────────────────────
// Phase 112 (v0.6.63) — 대화 라이브러리 (LibraryPanel)
// ─────────────────────────────────────────────────────────────────
// K 보고: "대화목록 보는게 좀 불편하고 작아서 잘 안보이는데 효과적이고
// 실용적으로 볼 수 있는 아이디어 없을까?". 선택 = 옵션 C — 완전 redesign.
//
// 설계:
//   - 풀스크린 overlay (z-index 매우 높음)
//   - 큰 검색 input (글로벌, 제목 + 미리보기에서 검색 — 미리보기는 v0.6.64)
//   - 빠른 필터 칩 (전체 / ★ 즐겨찾기 / ● 작업중 / 폴더별)
//   - 카드 grid: auto-fit minmax(320px, 1fr), gap 14px
//   - 각 카드:
//     · 좌측 border = 폴더 색 (없으면 transparent)
//     · 우상단 = ★ 즐겨찾기 / ● 작업중 dot
//     · 큰 제목 (16px, 2줄 max)
//     · 폴더 경로 (📁 > 하위폴더, 없으면 "루트")
//     · 메타 (메시지 카운트 + lastActive relative)
//   - 카드 클릭 → onSelect(convId) + 자동 close
//   - ESC, 빈 공간 클릭 = close
//   - Ctrl+L = open (App.tsx 에서 hook)
//
// pitfall_css_class_undefined_invisible 회피: 모든 layout 은 inline style 로
// 강제 박음 (CSS 클래스 의존 X).

import { memo, useEffect, useMemo, useState, useCallback } from "react";
import type { Conversation, Folder } from "../types";

interface Props {
  open: boolean;
  conversations: Conversation[];
  folders: Folder[];
  activeConversationId: string | null;
  streamingConvIds?: Set<string>;
  onSelect: (convId: string) => void;
  onClose: () => void;
}

type FilterKind = "all" | "favorites" | "streaming" | string; // string = folderId

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  const week = Math.floor(day / 7);
  if (week < 4) return `${week}주 전`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}개월 전`;
  return `${Math.floor(day / 365)}년 전`;
}

function folderPathOf(folder: Folder | undefined, folderMap: Map<string, Folder>): string {
  if (!folder) return "📂 루트";
  const parts: string[] = [];
  let cur: Folder | undefined = folder;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(`${cur.icon ?? "📁"} ${cur.name}`);
    cur = cur.parentId ? folderMap.get(cur.parentId) : undefined;
  }
  return parts.join(" / ");
}

function LibraryPanel({
  open,
  conversations,
  folders,
  activeConversationId,
  streamingConvIds,
  onSelect,
  onClose,
}: Props) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");

  // ESC 닫기
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // open 시 검색/필터 초기화
  useEffect(() => {
    if (open) {
      setSearch("");
      setFilter("all");
    }
  }, [open]);

  const folderMap = useMemo(() => {
    const m = new Map<string, Folder>();
    for (const f of folders) m.set(f.id, f);
    return m;
  }, [folders]);

  // 필터링 + 정렬
  const visibleConvs = useMemo(() => {
    let list = conversations;

    // 필터 칩
    if (filter === "favorites") {
      list = list.filter((c) => c.isFavorite);
    } else if (filter === "streaming") {
      list = list.filter((c) => streamingConvIds?.has(c.id));
    } else if (filter !== "all") {
      // folderId
      list = list.filter((c) => c.folderId === filter);
    }

    // 검색
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((c) => c.title.toLowerCase().includes(q));
    }

    // 정렬: 활성 conv 최상위, 즐겨찾기 우선, 그 후 lastActive desc
    return [...list].sort((a, b) => {
      if (a.id === activeConversationId) return -1;
      if (b.id === activeConversationId) return 1;
      const favDiff = (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0);
      if (favDiff !== 0) return favDiff;
      return b.lastActive - a.lastActive;
    });
  }, [conversations, filter, search, streamingConvIds, activeConversationId]);

  // 빠른 필터 칩 데이터 (count 표시)
  const filterChips = useMemo(() => {
    const favCount = conversations.filter((c) => c.isFavorite).length;
    const streamingCount = streamingConvIds?.size ?? 0;
    return [
      { key: "all" as FilterKind, label: `전체 (${conversations.length})` },
      { key: "favorites" as FilterKind, label: `★ 즐겨찾기 (${favCount})` },
      { key: "streaming" as FilterKind, label: `● 작업중 (${streamingCount})` },
    ];
  }, [conversations, streamingConvIds]);

  const handleCardClick = useCallback(
    (convId: string) => {
      onSelect(convId);
      onClose();
    },
    [onSelect, onClose],
  );

  if (!open) return null;

  return (
    <div
      className="library-overlay"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9998, // FolderInstructionsDialog (9999) 보다 살짝 낮게 — 다이얼로그 항상 위
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        className="library-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          width: "min(1200px, 94vw)",
          height: "min(800px, 90vh)",
          background: "var(--bg-1, #0a0e18)",
          border: "1px solid var(--border-accent, #2a3550)",
          borderRadius: 12,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
        }}
      >
        {/* Header — 큰 검색 + 닫기 */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--border-dim, #1d2540)",
            display: "flex",
            alignItems: "center",
            gap: 14,
            background: "var(--bg-2, #0f1420)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 22 }}>📚</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 2 }}>
              대화 라이브러리
            </div>
            <div style={{ fontSize: 11, opacity: 0.55 }}>
              {visibleConvs.length} 개 표시 · 전체 {conversations.length} 개 · Esc 또는 빈 공간 클릭 = 닫기
            </div>
          </div>
          <input
            type="text"
            placeholder="🔍 제목 검색…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            spellCheck={false}
            style={{
              width: 320,
              padding: "9px 14px",
              fontSize: 14,
              background: "var(--bg-1, #0a0e18)",
              border: "1px solid var(--border-dim, #1d2540)",
              borderRadius: 8,
              color: "var(--text, #e8eaff)",
              outline: "none",
            }}
          />
          <button
            onClick={onClose}
            title="닫기 (Esc)"
            style={{
              background: "transparent",
              border: "1px solid var(--border-dim, #1d2540)",
              borderRadius: 8,
              color: "var(--text-dim, #8e9ab5)",
              cursor: "pointer",
              padding: "8px 14px",
              fontSize: 16,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        {/* 필터 칩 + 폴더 필터 */}
        <div
          style={{
            padding: "10px 20px",
            borderBottom: "1px solid var(--border-dim, #1d2540)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            overflowX: "auto",
            flexShrink: 0,
          }}
        >
          {filterChips.map((c) => {
            const active = filter === c.key;
            return (
              <button
                key={c.key}
                onClick={() => setFilter(c.key)}
                style={{
                  padding: "5px 12px",
                  background: active
                    ? "var(--accent-dim, rgba(102,204,255,0.22))"
                    : "transparent",
                  border: `1px solid ${active ? "var(--accent, #66ccff)" : "var(--border-dim, #1d2540)"}`,
                  borderRadius: 16,
                  color: active ? "var(--accent, #66ccff)" : "var(--text-dim, #8e9ab5)",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: active ? 600 : 400,
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                {c.label}
              </button>
            );
          })}
          {/* 폴더 칩 (있는 폴더만) */}
          {folders.length > 0 && (
            <>
              <span style={{ color: "var(--text-dim, #555)", margin: "0 4px" }}>|</span>
              {folders.slice(0, 12).map((f) => {
                const active = filter === f.id;
                const count = conversations.filter((c) => c.folderId === f.id).length;
                if (count === 0) return null;
                return (
                  <button
                    key={f.id}
                    onClick={() => setFilter(f.id)}
                    title={f.name}
                    style={{
                      padding: "5px 12px",
                      background: active
                        ? "var(--accent-dim, rgba(102,204,255,0.22))"
                        : "transparent",
                      border: `1px solid ${active ? "var(--accent, #66ccff)" : "var(--border-dim, #1d2540)"}`,
                      borderRadius: 16,
                      color: active ? "var(--accent, #66ccff)" : "var(--text-dim, #8e9ab5)",
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: active ? 600 : 400,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                      maxWidth: 180,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {f.icon ?? "📁"} {f.name} ({count})
                  </button>
                );
              })}
            </>
          )}
        </div>

        {/* 본문 — card grid */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "18px 20px",
          }}
        >
          {visibleConvs.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                opacity: 0.45,
                fontSize: 14,
                padding: "60px 20px",
              }}
            >
              {search.trim() ? "검색 결과 없음" : "대화 없음"}
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                gap: 14,
              }}
            >
              {visibleConvs.map((c) => {
                const folder = c.folderId ? folderMap.get(c.folderId) : undefined;
                const isActive = c.id === activeConversationId;
                const isStreaming = streamingConvIds?.has(c.id) ?? false;
                return (
                  <button
                    key={c.id}
                    onClick={() => handleCardClick(c.id)}
                    style={{
                      position: "relative",
                      textAlign: "left",
                      padding: "14px 16px",
                      background: isActive
                        ? "var(--accent-dim, rgba(102,204,255,0.12))"
                        : "var(--bg-2, #0f1420)",
                      border: `1px solid ${isActive ? "var(--accent, #66ccff)" : "var(--border-dim, #1d2540)"}`,
                      borderLeft: c.color
                        ? `4px solid ${c.color}`
                        : isActive
                          ? "4px solid var(--accent, #66ccff)"
                          : "4px solid transparent",
                      borderRadius: 8,
                      cursor: "pointer",
                      color: "var(--text, #e8eaff)",
                      minHeight: 120,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      transition: "transform 0.08s, background 0.1s",
                      fontFamily: "inherit",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
                      if (!isActive) {
                        (e.currentTarget as HTMLElement).style.background =
                          "var(--bg-3, rgba(255,255,255,0.04))";
                      }
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
                      if (!isActive) {
                        (e.currentTarget as HTMLElement).style.background = "var(--bg-2, #0f1420)";
                      }
                    }}
                  >
                    {/* 우상단 배지 — 즐겨찾기 / 작업중 dot */}
                    <div
                      style={{
                        position: "absolute",
                        top: 10,
                        right: 12,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      {isStreaming && (
                        <span
                          title="작업 진행 중"
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: "var(--accent, #66ccff)",
                            boxShadow: "0 0 8px var(--accent, #66ccff)",
                            animation: "kda-pulse 1.4s ease-in-out infinite",
                          }}
                        />
                      )}
                      {c.isFavorite && (
                        <span title="즐겨찾기" style={{ fontSize: 14, color: "#ffd455" }}>
                          ★
                        </span>
                      )}
                    </div>

                    {/* 폴더 경로 */}
                    <div
                      style={{
                        fontSize: 10,
                        opacity: 0.55,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        paddingRight: 50,
                      }}
                    >
                      {folderPathOf(folder, folderMap)}
                    </div>

                    {/* 제목 (큰) */}
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 600,
                        lineHeight: 1.35,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                        wordBreak: "break-word",
                        paddingRight: 50,
                      }}
                    >
                      {c.icon ?? "💬"} {c.title}
                    </div>

                    {/* 메타 */}
                    <div
                      style={{
                        marginTop: "auto",
                        display: "flex",
                        gap: 10,
                        fontSize: 11,
                        opacity: 0.55,
                        fontFamily: "monospace",
                      }}
                    >
                      <span>{c.messageCount} msg</span>
                      <span>·</span>
                      <span>{formatRelative(c.lastActive)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default memo(LibraryPanel);
