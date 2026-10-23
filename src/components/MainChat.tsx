import {
  useRef,
  useState,
  useCallback,
  useMemo,
  memo,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import CornerBrackets from "./CornerBrackets";
import Message from "./Message";
import Composer from "./Composer";
import type { SendMode } from "../conversationControl";
import type { ChatMessage, ConnectionStatus, FileAttachment } from "../types";
import { filterMessagesForBody, filterMessagesForCopy } from "../utils/messageFilters";

interface MainChatProps {
  activityPanel?: ReactNode;
  // v0.7.49 — 채팅창 안(입력창 위)에 표시할 알림 배너 (작업 결과 확인 대기 / 응답 정체 등).
  notices?: ReactNode;
  conversationId: string;
  isStopping?: boolean;
  queuedCount?: number;
  queuePaused?: boolean;
  onResumeQueue?: () => void;
  messages: ChatMessage[];
  status: ConnectionStatus;
  isStreaming: boolean;
  onSendMessage: (text: string, files?: FileAttachment[], mode?: SendMode) => Promise<void>;
  onInterrupt: () => void;
  // Phase 46 (v0.5.34) — "모두 중단" 강한 stop
  onHardStop?: () => void;
  // Phase 34 (v0.5.22) — 큐 미리보기 + 취소
  queuedSend?: { text: string; fileCount: number; queuedAt: number } | null;
  onCancelQueuedSend?: () => void;
  // Phase 49 (v0.5.37) — "지금 전송" (작업 중단 후 큐 바로 새 turn)
  onFlushQueueNow?: () => void;
  // Phase 44 (v0.5.32) — 메시지 안 link 클릭 → SidePanel 트리거
  onPreviewRequest?: (pathOrUrl: string, label?: string) => void;
  // v0.7.50 — 페이지 로딩 (최근 메시지만 먼저, 위로 스크롤 시 이전 메시지)
  loading?: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  // 일부만 불러온 대화에서 '복사' 시 DB 에서 본문 전체를 읽는다
  onLoadAllForCopy?: () => Promise<ChatMessage[]>;
}

// 빌트인 도구 → 한국어 라벨 매핑. MCP 도구는 정규식으로 자동 변환 (mcp__server__tool → tool).
const TOOL_LABELS: Record<string, string> = {
  Read: "파일 읽기",
  Write: "파일 쓰기",
  Edit: "파일 편집",
  MultiEdit: "파일 편집",
  NotebookEdit: "노트북 편집",
  Bash: "명령어 실행",
  Glob: "파일 검색",
  Grep: "내용 검색",
  WebFetch: "웹 가져오기",
  WebSearch: "웹 검색",
  Task: "에이전트 작업",
  TaskOutput: "작업 결과 조회",
  TaskStop: "작업 중단",
  TodoWrite: "할일 정리",
  ToolSearch: "도구 검색",
  PowerShell: "PowerShell 실행",
  ExitPlanMode: "계획 모드 종료",
  EnterPlanMode: "계획 모드 진입",
  ScheduleWakeup: "예약 호출",
  CronCreate: "Cron 등록",
  CronDelete: "Cron 삭제",
  CronList: "Cron 목록",
  AskUserQuestion: "사용자 질문",
  PushNotification: "알림 전송",
};

function formatToolName(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  // MCP 도구 — mcp__k-personal__cc_screenshot → "screenshot"
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const tool = parts[parts.length - 1] ?? name;
    return tool.replace(/^cc_/, "").replace(/_/g, " ");
  }
  return name;
}

function MainChat({
  activityPanel,
  notices,
  conversationId,
  isStopping,
  queuedCount,
  queuePaused,
  onResumeQueue,
  messages,
  status,
  isStreaming,
  onSendMessage,
  onInterrupt,
  onHardStop,
  queuedSend,
  onCancelQueuedSend,
  onFlushQueueNow,
  onPreviewRequest,
  loading = false,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  onLoadAllForCopy,
}: MainChatProps) {
  // Phase 103 (v0.6.49) — react-virtuoso 박은 후 scroll 관리는 Virtuoso 가 자체 처리.
  // 기존 messagesContainerRef + userScrolledUpRef + scrollToBottom + 4 useEffect 들 모두 제거.
  // Virtuoso 의 followOutput / atBottomStateChange / scrollToIndex API 로 대체.
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");

  // Phase 90 (v0.6.32) — tool_use 카드 visibility + 카테고리/위험도 필터.
  // default OFF (기존 K 흐름 무변경). 토글 ON 시 tool 메시지 visible + filter chip 사용 가능.
  const [showToolCards, setShowToolCards] = useState<boolean>(() => {
    try {
      return localStorage.getItem("kda_show_tool_cards") === "1";
    } catch {
      return false;
    }
  });
  // activeFilter: 클릭한 위험도 또는 카테고리. null = 필터 없음 (전체 보임).
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>(null);
  const setShowToolCardsPersist = useCallback((v: boolean) => {
    setShowToolCards(v);
    try {
      localStorage.setItem("kda_show_tool_cards", v ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (!v) setActiveFilter(null); // off 면 filter 도 클리어
  }, []);

  // 대화 내용 복사 함수
  const handleCopyChat = async () => {
    // v0.7.50 — 이전 메시지가 아직 안 불러와졌으면 DB 에서 본문 전체를 읽어 복사 (화면 일부만 복사 방지).
    let source = messages;
    if (onLoadAllForCopy) {
      try {
        source = await onLoadAllForCopy();
      } catch (err) {
        console.error("Failed to load full conversation for copy:", err);
      }
    }
    const visibleMessages = filterMessagesForCopy(source);

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

  // Phase 103 (v0.6.49) — Virtuoso 기반 scroll 관리.
  // "맨 아래로 가기" 버튼 클릭 → Virtuoso ref 로 마지막 item 강제 scroll. 자동 follow 도 재활성.
  const handleScrollToBottomClick = useCallback(() => {
    const v = virtuosoRef.current;
    if (!v) return;
    // v0.7.49 — smooth 는 높이 미측정 항목이 많거나 스트리밍으로 끝이 늘어나면 목표를 계속 쫓아가
    // 바닥에 도달하지 못했다(6x CPU 실측: 30초 내 미도달, 커밋 1000회). 즉시 이동 + 측정 후 1회 보정.
    v.scrollToIndex({ index: "LAST", behavior: "auto", align: "end" });
    requestAnimationFrame(() => v.scrollToIndex({ index: "LAST", behavior: "auto", align: "end" }));
    setShowScrollToBottom(false);
  }, []);

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
          {activityPanel}
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

      {/* Phase 90 — tool_use 카드 visibility 토글 + 필터 chip (상단 sticky bar) */}
      {(showToolCards || activeFilter) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            fontSize: "0.78em",
            background: "rgba(79,232,225,0.06)",
            borderBottom: "1px solid rgba(79,232,225,0.2)",
            flexWrap: "wrap",
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showToolCards}
              onChange={(e) => setShowToolCardsPersist(e.target.checked)}
            />
            <span>🔧 도구 호출 카드 표시</span>
          </label>
          {activeFilter && (
            <span
              style={{
                padding: "2px 8px",
                background: "rgba(249,115,22,0.15)",
                border: "1px solid rgba(249,115,22,0.4)",
                borderRadius: 12,
                fontWeight: 600,
              }}
            >
              필터:{" "}
              {activeFilter.kind === "risk"
                ? `위험도=${activeFilter.value}`
                : `카테고리=${activeFilter.value}`}
              <button
                onClick={() => setActiveFilter(null)}
                style={{
                  marginLeft: 6,
                  background: "transparent",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  opacity: 0.7,
                }}
                title="필터 해제"
              >
                ✕
              </button>
            </span>
          )}
          <span style={{ marginLeft: "auto", opacity: 0.6 }}>
            tool 카드의 🟢🟡🟠🔴 배지 또는 category 라벨을 클릭하면 필터 토글
          </span>
        </div>
      )}
      {!showToolCards && !activeFilter && (
        <div
          style={{
            padding: "4px 12px",
            fontSize: "0.75em",
            opacity: 0.5,
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button
            onClick={() => setShowToolCardsPersist(true)}
            style={{
              background: "transparent",
              border: "1px dashed var(--border-subtle)",
              color: "inherit",
              cursor: "pointer",
              borderRadius: 4,
              padding: "2px 8px",
              fontSize: "0.92em",
            }}
            title="채팅에 도구 호출 카드 표시 + 카테고리/위험도 필터 활성"
          >
            🔧 도구 호출 보기
          </button>
        </div>
      )}

      {/* 메시지 영역 */}
      <div className="main-body">
        <div className="messages">
          <MessageList
            key={conversationId}
            loading={loading}
            hasOlder={hasOlder}
            loadingOlder={loadingOlder}
            onLoadOlder={onLoadOlder}
            messages={messages}
            showToolCards={showToolCards}
            activeFilter={activeFilter}
            setActiveFilter={setActiveFilter}
            onPreviewRequest={onPreviewRequest}
            virtuosoRef={virtuosoRef}
            onAtBottomChange={setShowScrollToBottom}
          />
        </div>

        {/* 맨 아래로 가기 버튼 — 위로 스크롤했을 때만 노출 */}
        {showScrollToBottom && (
          <button
            className="scroll-to-bottom-btn"
            onClick={handleScrollToBottomClick}
            title="맨 아래로"
            aria-label="맨 아래로"
          >
            <span className="scroll-to-bottom-icon">▼</span>
          </button>
        )}

        {/* v0.7.49 — 알림 배너: 레이아웃 흐름 안에서 메시지 영역만 줄인다. */}
        {notices ? <div className="chat-notices">{notices}</div> : null}

        {/* 진행 중 표시 — 스트리밍 중에만 노출, 마지막 pending tool 라벨 표시 */}
        <ProgressIndicator messages={messages} isStreaming={isStreaming} />

        {/* 입력창 */}
        <Composer
          key={conversationId}
          conversationId={conversationId}
          isStopping={isStopping}
          queuedCount={queuedCount}
          queuePaused={queuePaused}
          onResumeQueue={onResumeQueue}
          disabled={status !== "connected"}
          isStreaming={isStreaming}
          onSubmit={onSendMessage}
          onInterrupt={onInterrupt}
          onHardStop={onHardStop}
          queuedSend={queuedSend}
          onCancelQueuedSend={onCancelQueuedSend}
          onFlushQueueNow={onFlushQueueNow}
        />
      </div>
    </section>
  );
}

type ActiveFilter =
  | { kind: "risk"; value: "low" | "medium" | "high" | "critical" }
  | { kind: "category"; value: string }
  | null;

// v0.7.49 — Virtuoso components 는 반드시 안정된 참조. 인라인 `Header: () => ...` 는 렌더마다
// 새 컴포넌트 타입이라 헤더가 unmount/remount 되고 목록 높이를 다시 재게 만든다.
// v0.7.50 — 헤더: 이전 메시지가 남아 있으면 불러오기 표시/버튼 (startReached 가 안 뜨는 짧은 목록 대비).
type ListContext = { hasOlder: boolean; loadingOlder: boolean; onLoadOlder?: () => void };
const VIRTUOSO_COMPONENTS = {
  Header: function MessagesSpacer({ context }: { context?: ListContext }) {
    return (
      <div className="messages-spacer">
        {context?.hasOlder ? (
          <div className="messages-older">
            {context.loadingOlder ? (
              <span>이전 메시지 불러오는 중…</span>
            ) : (
              <button type="button" className="messages-older-btn" onClick={() => context.onLoadOlder?.()}>
                이전 메시지 더 보기
              </button>
            )}
          </div>
        ) : null}
      </div>
    );
  },
};
// Virtuoso 는 앞에 항목이 붙으면 firstItemIndex 를 그 수만큼 줄여야 스크롤 위치를 유지한다.
const FIRST_INDEX_BASE = 1_000_000_000;
const VIRTUOSO_VIEWPORT = { top: 800, bottom: 800 };
const VIRTUOSO_STYLE = { height: "100%" };
const DIM_STYLE = { opacity: 0.25, transition: "opacity 0.2s" };
const NORMAL_STYLE = { transition: "opacity 0.2s" };

/**
 * v0.7.49 — 채팅 메시지 목록 (memo).
 * 종전엔 MainChat 본문 안 IIFE 라, App 이 매 렌더 새로 만드는 activityPanel 엘리먼트 때문에
 * MainChat memo 가 항상 깨지고 → 전체 필터(대형 대화 3만+ 행) + Virtuoso 재렌더가 매번 일어났다.
 * (6x CPU 실측: 5초 동안 163 커밋, 2.5초 소비.) 여기선 목록과 무관한 prop 변화엔 재렌더하지 않는다.
 */
const MessageList = memo(function MessageList({
  loading,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  messages,
  showToolCards,
  activeFilter,
  setActiveFilter,
  onPreviewRequest,
  virtuosoRef,
  onAtBottomChange,
}: {
  loading: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder?: () => void;
  messages: ChatMessage[];
  showToolCards: boolean;
  activeFilter: ActiveFilter;
  setActiveFilter: Dispatch<SetStateAction<ActiveFilter>>;
  onPreviewRequest?: (pathOrUrl: string, label?: string) => void;
  virtuosoRef: RefObject<VirtuosoHandle>;
  onAtBottomChange: (showButton: boolean) => void;
}) {
  // Phase 90/98.4/101 — 본문 필터 (src/utils/messageFilters.ts). messages/토글이 바뀔 때만 재계산.
  const visibleMessages = useMemo(
    () => filterMessagesForBody(messages, showToolCards),
    [messages, showToolCards],
  );

  const handleToolFilterToggle = useCallback(
    (kind: "risk" | "category", value: string) => {
      setActiveFilter((cur) => {
        if (cur && cur.kind === kind && cur.value === value) return null;
        return { kind, value } as ActiveFilter;
      });
    },
    [setActiveFilter],
  );

  // activeFilter 매칭 — tool 메시지의 risk 와 매칭. tool 아닌 메시지는 항상 통과.
  const itemContent = useCallback(
    (_: number, msg: ChatMessage) => {
      let dimmed = false;
      if (activeFilter && msg.role === "tool") {
        const r = (msg as any).risk;
        dimmed = !r
          ? true
          : activeFilter.kind === "risk"
            ? r.level !== activeFilter.value
            : r.categoryId !== activeFilter.value;
      }
      return (
        <div style={dimmed ? DIM_STYLE : NORMAL_STYLE}>
          <Message
            message={msg}
            onPreviewRequest={onPreviewRequest}
            onToolFilterToggle={handleToolFilterToggle}
          />
        </div>
      );
    },
    [activeFilter, onPreviewRequest, handleToolFilterToggle],
  );
  const computeItemKey = useCallback((_: number, msg: ChatMessage) => msg.id, []);

  // v0.7.50 — 앞에 붙은(이전 페이지) 항목 수만큼 firstItemIndex 를 줄인다. 끝에 추가되는 새 메시지는 무관.
  // 대화가 바뀌면 이 컴포넌트는 key 로 새로 마운트되므로 누적값도 초기화된다.
  const firstIdRef = useRef<string | null>(null);
  const prependedRef = useRef(0);
  const firstItemIndex = useMemo(() => {
    const nextFirst = visibleMessages[0]?.id ?? null;
    const prev = firstIdRef.current;
    if (prev != null && nextFirst != null && prev !== nextFirst) {
      const idx = visibleMessages.findIndex((m) => m.id === prev);
      if (idx > 0) prependedRef.current += idx;
    }
    firstIdRef.current = nextFirst;
    return FIRST_INDEX_BASE - prependedRef.current;
  }, [visibleMessages]);
  const listContext = useMemo<ListContext>(
    () => ({ hasOlder, loadingOlder, onLoadOlder }),
    [hasOlder, loadingOlder, onLoadOlder],
  );
  const startReached = useCallback(() => {
    if (hasOlder && !loadingOlder) onLoadOlder?.();
  }, [hasOlder, loadingOlder, onLoadOlder]);
  // 맨 아래일 때만 새 메시지를 따라간다. "smooth" 는 스트리밍 토큰마다 애니메이션이 겹쳐
  // 바닥을 쫓아가는 상태가 이어지므로 즉시("auto") 따라간다.
  const followOutput = useCallback((isAtBottom: boolean) => (isAtBottom ? "auto" : false), []);
  const atBottomStateChange = useCallback(
    (atBottom: boolean) => onAtBottomChange(!atBottom),
    [onAtBottomChange],
  );

  if (visibleMessages.length === 0) {
    if (loading) {
      return (
        <div className="conversation-loading" role="status">
          대화를 불러오는 중…
        </div>
      );
    }
    // 페이지 전체가 도구 기록이라 본문이 안 보이는 경우: 이전 메시지를 이어서 볼 수 있게.
    if (hasOlder) {
      return (
        <div className="conversation-loading">
          <button type="button" className="messages-older-btn" onClick={() => onLoadOlder?.()} disabled={loadingOlder}>
            {loadingOlder ? "이전 메시지 불러오는 중…" : "이전 메시지 더 보기"}
          </button>
        </div>
      );
    }
    return <EmptyState />;
  }

  return (
    <Virtuoso
      ref={virtuosoRef}
      data={visibleMessages}
      firstItemIndex={firstItemIndex}
      context={listContext}
      startReached={startReached}
      computeItemKey={computeItemKey}
      followOutput={followOutput}
      atBottomStateChange={atBottomStateChange}
      initialTopMostItemIndex={visibleMessages.length - 1}
      increaseViewportBy={VIRTUOSO_VIEWPORT}
      components={VIRTUOSO_COMPONENTS}
      itemContent={itemContent}
      style={VIRTUOSO_STYLE}
    />
  );
});

// memo — 핸들러 ref 안정화로 props 변동은 사실상 messages/status/isStreaming 뿐.
// 다른 state 변화 (settingsOpen 등) 로 인한 부모 리렌더에선 스킵됨.
export default memo(MainChat);

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

// 진행 중 표시 — 컴포저 위에 얇은 띠로 표시.
// isStreaming 일 때만 노출. 마지막 pending tool 이 있으면 그 라벨, 없으면 "응답 생성 중...".
// (이전의 누적 ToolLogPanel 보다 노이즈가 훨씬 적고 "지금 무슨 작업 중인지" 만 명확히 전달)
function ProgressIndicator({
  messages,
  isStreaming,
}: {
  messages: ChatMessage[];
  isStreaming: boolean;
}) {
  // 마지막 pending tool 찾기 — 끝에서 거꾸로 스캔 (보통 가장 최근).
  const currentTool = useMemo(() => {
    if (!isStreaming) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "tool" && m.status === "pending") {
        return m;
      }
    }
    return null;
  }, [messages, isStreaming]);

  if (!isStreaming) return null;

  const label = currentTool
    ? `${formatToolName(currentTool.toolName)} 실행 중...`
    : "응답 생성 중...";

  return (
    <div className="progress-indicator" role="status" aria-live="polite">
      <span className="progress-spinner" aria-hidden="true" />
      <span className="progress-label mono">{label}</span>
    </div>
  );
}
