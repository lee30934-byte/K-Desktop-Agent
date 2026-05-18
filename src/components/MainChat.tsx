import { useEffect, useRef, useLayoutEffect, useState, useCallback, useMemo, memo } from "react";
import CornerBrackets from "./CornerBrackets";
import Message from "./Message";
import Composer from "./Composer";
import type { ChatMessage, ConnectionStatus, FileAttachment } from "../types";

interface MainChatProps {
  messages: ChatMessage[];
  status: ConnectionStatus;
  isStreaming: boolean;
  onSendMessage: (text: string, files?: FileAttachment[]) => void;
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

// "맨 아래" 판정 임계값 (px). 사용자가 이 안에 있으면 자동 스크롤 따라감.
const SCROLL_BOTTOM_THRESHOLD = 80;

function MainChat({
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
}: MainChatProps) {
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const lastMessageCountRef = useRef(0);
  // 사용자가 위로 스크롤했는지 — true 면 자동 스크롤 일시 중지.
  // ref 로 들고서 effect 가 stale 안 되게.
  const userScrolledUpRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");

  // 대화 내용 복사 함수
  const handleCopyChat = async () => {
    const visibleMessages = messages.filter((msg) => msg.role !== "tool");

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

  // 컨테이너가 맨 아래에 있는가
  const isAtBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return true;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - (scrollTop + clientHeight) <= SCROLL_BOTTOM_THRESHOLD;
  }, []);

  // 스크롤 함수 (force=true 면 사용자 의도 무시하고 강제)
  const scrollToBottom = useCallback((force = false) => {
    const container = messagesContainerRef.current;
    if (!container) return;
    if (!force && userScrolledUpRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, []);

  // 사용자가 직접 클릭한 "맨 아래로 가기" — 자동 스크롤도 다시 켜짐
  const handleScrollToBottomClick = useCallback(() => {
    userScrolledUpRef.current = false;
    setShowScrollToBottom(false);
    scrollToBottom(true);
  }, [scrollToBottom]);

  // 사용자 스크롤 감지 — 위로 올렸으면 자동 스크롤 잠금, 다시 맨 아래로 가면 해제
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const atBottom = isAtBottom();
      userScrolledUpRef.current = !atBottom;
      setShowScrollToBottom(!atBottom);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [isAtBottom]);

  // 메시지 변경 시 — 사용자가 맨 아래일 때만 따라감
  useLayoutEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // 스트리밍 중 100ms 폴링 — 동일하게 사용자 의도 존중
  useEffect(() => {
    if (!isStreaming) return;
    const interval = setInterval(() => scrollToBottom(), 100);
    return () => clearInterval(interval);
  }, [isStreaming, scrollToBottom]);

  // 새 메시지 추가 시 — 신규 발화면 강제 스크롤 (대화 시작 시 위에 묶이는 거 방지)
  useEffect(() => {
    if (messages.length !== lastMessageCountRef.current) {
      const isNewMessage = messages.length > lastMessageCountRef.current;
      lastMessageCountRef.current = messages.length;
      // 사용자가 자기 메시지 보냈을 때(=last is user)는 강제로 따라감
      const lastMsg = messages[messages.length - 1];
      if (isNewMessage && lastMsg?.role === "user") {
        userScrolledUpRef.current = false;
        setShowScrollToBottom(false);
        scrollToBottom(true);
      } else {
        scrollToBottom();
      }
    }
  }, [messages, scrollToBottom]);

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

      {/* 메시지 영역 */}
      <div className="main-body">
        <div className="messages" ref={messagesContainerRef}>
          {(() => {
            // Tool 메시지 필터링 - user/assistant/system만 표시
            const visibleMessages = messages.filter(
              (msg) => msg.role !== "tool"
            );

            if (visibleMessages.length === 0) {
              return <EmptyState />;
            }

            return (
              <>
                {/* 메시지가 적을 때 위쪽 빈 공간 채우기 */}
                <div className="messages-spacer" />
                {visibleMessages.map((msg) => (
                  <Message key={msg.id} message={msg} onPreviewRequest={onPreviewRequest} />
                ))}
              </>
            );
          })()}
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

        {/* 진행 중 표시 — 스트리밍 중에만 노출, 마지막 pending tool 라벨 표시 */}
        <ProgressIndicator messages={messages} isStreaming={isStreaming} />

        {/* 입력창 */}
        <Composer
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
