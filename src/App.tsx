import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import Sidebar from "./components/Sidebar";
import MainChat from "./components/MainChat";
import MetricsPanel from "./components/MetricsPanel";
import Settings from "./components/Settings";
import type {
  ChatMessage,
  Conversation,
  ConnectionStatus,
  SessionMetrics,
  SidecarEvent,
  MCPState,
  FileAttachment,
  ElicitationRequest,
  ElicitationResponse,
} from "./types";
import ElicitationDialog from "./components/ElicitationDialog";
import {
  initDB,
  getAllConversations,
  createConversation,
  deleteConversation,
  updateConversationTitle,
  updateConversationAgentId,
  getMessages,
  saveMessage,
  getConversationAgentId,
  generateTitleFromMessage,
} from "./db";
import "./App.css";

export default function App() {
  // ─── 상태 ───────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connected");
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mcpState, setMcpState] = useState<MCPState>({
    connected: false,
    server: "k-personal",
  });
  const [metrics, setMetrics] = useState<SessionMetrics>({
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turnCount: 0,
    toolCallCount: 0,
    startedAt: Date.now(),
  });
  const [, setTick] = useState(0);
  const [dbReady, setDbReady] = useState(false);
  const [elicitationRequest, setElicitationRequest] = useState<ElicitationRequest | null>(null);
  const elicitationResolveRef = useRef<((response: ElicitationResponse) => void) | null>(null);

  // ─── Auto Session Continuity ────────────────────────────
  // Claude Max 기준 약 200K 토큰, 80%에서 갱신 (더 여유있게)
  const MAX_CONTEXT_TOKENS = 200000;
  const CONTEXT_THRESHOLD = 0.8; // 80% (이전: 90%)
  const [sessionSummary, setSessionSummary] = useState<string | null>(null);
  const [sessionRefreshToast, setSessionRefreshToast] = useState(false);
  const isRefreshingSessionRef = useRef(false);

  // 메시지 저장 디바운스용 ref
  const pendingSaveRef = useRef<Map<string, ChatMessage>>(new Map());
  const saveTimerRef = useRef<number | null>(null);

  // state를 안정된 콜백 안에서 읽기 위한 latest-ref
  const activeConversationIdRef = useRef<string | null>(null);
  const dbReadyRef = useRef(false);
  useEffect(() => { activeConversationIdRef.current = activeConversationId; }, [activeConversationId]);
  useEffect(() => { dbReadyRef.current = dbReady; }, [dbReady]);

  // 매초 UI 갱신 (경과 시간 등)
  useEffect(() => {
    const h = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(h);
  }, []);

  // ─── DB 초기화 및 대화 목록 로드 ─────────────────────
  useEffect(() => {
    (async () => {
      try {
        await initDB();
        const convs = await getAllConversations();
        setConversations(convs);
        setDbReady(true);
        console.log("[App] DB 초기화 완료, 대화 수:", convs.length);
      } catch (err) {
        console.error("[App] DB 초기화 실패:", err);
        setDbReady(true); // 실패해도 앱은 동작하게
      }
    })();
  }, []);

  // 리스너는 한 번만 등록되지만, 핸들러는 매 렌더 갱신된 최신 것을 호출해야 함
  // (특히 HMR 시 useCallback([]) 인스턴스가 재사용돼 stale 되는 문제 방지)
  const handleSidecarEventRef = useRef<(ev: SidecarEvent) => void>(() => {});

  // ─── Sidecar 이벤트 리스너 ────────────────────────────
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    (async () => {
      unlisten = await listen<SidecarEvent>("sidecar-event", (ev) => {
        handleSidecarEventRef.current(ev.payload as SidecarEvent);
      });
    })();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // ─── 트레이에서 Settings 열기 이벤트 ──────────────────
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    (async () => {
      unlisten = await listen("open-settings", () => {
        setSettingsOpen(true);
      });
    })();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleSidecarEvent = (ev: SidecarEvent) => {
    switch (ev.type) {
      case "ready": {
        setStatus("connected");
        console.log(`[sidecar] ready v${ev.version}`);
        // MCP 상태 재확인 요청 (시작 시 mcp_status 이벤트 놓칠 수 있음)
        invoke("ping_sidecar").catch((e) =>
          console.warn("[sidecar] ping failed:", e)
        );
        break;
      }

      case "mcp_status": {
        setMcpState({
          connected: ev.connected,
          server: ev.server,
          error: ev.error,
        });
        if (ev.error) {
          pushSystem(`MCP 설정 문제: ${ev.error}`, "warn");
        }
        break;
      }

      case "assistant_delta": {
        setMessages((prev) => {
          const existingIdx = prev.findIndex(
            (m) => m.id === ev.id && m.role === "assistant"
          );
          if (existingIdx >= 0) {
            const next = [...prev];
            const msg = next[existingIdx];
            if (msg.role === "assistant") {
              next[existingIdx] = {
                ...msg,
                content: ev.text,
                streaming: true,
              };
            }
            return next;
          }
          return [
            ...prev,
            {
              id: ev.id,
              role: "assistant",
              content: ev.text,
              timestamp: Date.now(),
              streaming: true,
            },
          ];
        });
        break;
      }

      case "tool_use": {
        setMessages((prev) => [
          ...prev,
          {
            id: `${ev.id}-tool-${ev.tool_id}`,
            role: "tool",
            toolId: ev.tool_id,
            toolName: ev.name,
            toolInput: ev.input,
            content: "",
            status: "pending",
            timestamp: Date.now(),
          },
        ]);
        setMetrics((m) => ({ ...m, toolCallCount: m.toolCallCount + 1 }));
        break;
      }

      case "tool_result": {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.role === "tool" && m.id === `${ev.id}-tool-${ev.tool_id}`) {
              return {
                ...m,
                toolOutput: ev.output,
                status: "success" as const,
              };
            }
            return m;
          })
        );
        break;
      }

      case "done": {
        setIsStreaming(false);
        setCurrentTurnId(null);

        // agentId를 DB에 저장 (resume 지원)
        const convIdForDone = activeConversationIdRef.current;
        if (ev.agentId && convIdForDone && dbReadyRef.current) {
          const aid = ev.agentId;
          updateConversationAgentId(convIdForDone, aid)
            .then(() => {
              setConversations((prev) =>
                prev.map((c) =>
                  c.id === convIdForDone ? { ...c, agentId: aid } : c
                )
              );
            })
            .catch((err) => console.error("[App] agentId 저장 실패:", err));
        }

        setMessages((prev) => {
          // 스트리밍 완료 표시 및 DB 저장
          const updated = prev.map((m) =>
            m.role === "assistant" && (m as any).streaming
              ? { ...m, streaming: false }
              : m
          );

          // 이번 턴의 메시지들 DB에 저장 (user 제외 - 이미 저장됨)
          const toSave = updated.filter(
            (m) => m.role === "assistant" || m.role === "tool"
          );
          // 비동기로 저장 (상태 업데이트 콜백 내에서 직접 호출 불가하므로 setTimeout 사용)
          setTimeout(() => {
            toSave.forEach((m) => queueMessageSave(m));
            refreshConversations();
          }, 0);

          return updated;
        });

        // 토큰 사용량 업데이트 및 임계치 체크
        // computed_usage 우선 사용 (sidecar에서 modelUsage 기반으로 계산)
        const newInputTokens = ev.computed_usage?.input_tokens ?? ev.usage?.input_tokens ?? 0;
        const newOutputTokens = ev.computed_usage?.output_tokens ?? ev.usage?.output_tokens ?? 0;

        console.log(`[Metrics] Turn tokens - IN: ${newInputTokens}, OUT: ${newOutputTokens}`);

        setMetrics((m) => {
          const updatedMetrics = {
            ...m,
            turnCount: m.turnCount + 1,
            totalInputTokens: m.totalInputTokens + newInputTokens,
            totalOutputTokens: m.totalOutputTokens + newOutputTokens,
          };

          // 90% 임계치 도달 시 자동 세션 갱신 트리거
          const contextUsage = updatedMetrics.totalInputTokens / MAX_CONTEXT_TOKENS;
          if (contextUsage >= CONTEXT_THRESHOLD && !isRefreshingSessionRef.current) {
            console.log(`[Session] 컨텍스트 ${(contextUsage * 100).toFixed(1)}% 도달 - 세션 자동 갱신 시작`);
            isRefreshingSessionRef.current = true;
            // 비동기로 세션 갱신 실행
            setTimeout(() => triggerSessionRefresh(), 100);
          }

          return updatedMetrics;
        });
        break;
      }

      case "error": {
        setIsStreaming(false);
        setCurrentTurnId(null);
        setStatus("error");
        pushSystem(`Error: ${ev.message}`, "error");
        break;
      }

      case "log": {
        if (ev.level !== "info") {
          console[ev.level === "warn" ? "warn" : "error"](
            `[sidecar] ${ev.message}`
          );
        } else {
          console.log(`[sidecar] ${ev.message}`);
        }
        break;
      }

      case "pong":
        break;

      case "elicitation_request": {
        // Sidecar에서 위험한 도구 실행 전 확인 요청
        setElicitationRequest({
          id: ev.id,
          type: "confirm",
          title: ev.title,
          message: ev.message,
          severity: ev.severity,
          confirmLabel: ev.confirm_label,
          cancelLabel: ev.cancel_label,
        });
        // 응답은 handleElicitationResponse에서 처리됨
        break;
      }

      default: {
        // "reloading" 같은 신호 이벤트
        const e: any = ev;
        if (e.type === "reloading") {
          setStatus("connecting");
          setMcpState({ connected: false, server: "k-personal" });
          pushSystem(e.message ?? "재기동 중...", "info");
        }
      }
    }
  };
  // 매 렌더 최신 핸들러를 ref에 반영 — 리스너는 이 ref를 통해 호출
  handleSidecarEventRef.current = handleSidecarEvent;

  function pushSystem(
    content: string,
    level: "info" | "warn" | "error" = "info"
  ) {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "system",
      content,
      level,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, msg]);
    // 시스템 메시지는 DB에 저장하지 않음 (세션별 임시 알림)
  }

  // ─── DB 저장 헬퍼 (디바운스) ────────────────────────────
  // 안정된 함수 — 내부에서 ref로 최신 conversationId 조회
  const queueMessageSave = useCallback((msg: ChatMessage) => {
    const convId = activeConversationIdRef.current;
    if (!convId || !dbReadyRef.current) return;

    pendingSaveRef.current.set(msg.id, msg);

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(async () => {
      const flushConvId = activeConversationIdRef.current;
      if (!flushConvId) return;

      const toSave = Array.from(pendingSaveRef.current.values());
      pendingSaveRef.current.clear();

      for (const m of toSave) {
        try {
          await saveMessage(flushConvId, m);
        } catch (err) {
          console.error("[DB] 메시지 저장 실패:", err);
        }
      }
    }, 300);
  }, []);

  // 대화 목록 새로고침
  const refreshConversations = useCallback(async () => {
    try {
      const convs = await getAllConversations();
      setConversations(convs);
    } catch (err) {
      console.error("[App] 대화 목록 새로고침 실패:", err);
    }
  }, []);

  // ─── 액션 ───────────────────────────────────────────

  async function handleSendMessage(text: string, files?: FileAttachment[]) {
    if ((!text && (!files || files.length === 0)) || isStreaming) return;

    // 활성 대화가 없으면 자동 생성
    let convId = activeConversationId;
    if (!convId && dbReady) {
      convId = crypto.randomUUID();
      const title = generateTitleFromMessage(text);
      try {
        const newConv = await createConversation(convId, title);
        setConversations((prev) => [newConv, ...prev]);
        setActiveConversationId(convId);
        // ref도 즉시 갱신 — 이 턴의 queueMessageSave가 바로 집어가게
        activeConversationIdRef.current = convId;
      } catch (err) {
        console.error("[App] 대화 생성 실패:", err);
      }
    }

    const turnId = crypto.randomUUID();

    // 첨부 파일 정보를 포함한 메시지 내용 구성
    let displayContent = text;
    if (files && files.length > 0) {
      const fileNames = files.map((f) => f.name).join(", ");
      displayContent = text
        ? `${text}\n\n📎 첨부: ${fileNames}`
        : `📎 첨부: ${fileNames}`;
    }

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: displayContent,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setCurrentTurnId(turnId);
    setIsStreaming(true);

    // DB에 사용자 메시지 저장
    if (convId && dbReady) {
      queueMessageSave(userMsg);

      // 첫 메시지면 제목 업데이트
      const conv = conversations.find((c) => c.id === convId);
      if (conv && conv.title === "New Conversation") {
        const msgForTitle = text || (files ? files[0]?.name : "");
        const newTitle = generateTitleFromMessage(msgForTitle);
        updateConversationTitle(convId, newTitle).then(() => {
          setConversations((prev) =>
            prev.map((c) => (c.id === convId ? { ...c, title: newTitle } : c))
          );
        });
      }
    }

    try {
      // 기존 대화면 agent_id를 가져와서 resume 지원
      let agentId: string | undefined;
      if (convId && dbReady) {
        const existingAgentId = await getConversationAgentId(convId);
        if (existingAgentId) {
          agentId = existingAgentId;
        }
      }

      // 이전 대화 컨텍스트 — user/assistant 메시지 최근 20개만 (tool 은 용량 문제로 제외)
      // 방금 추가한 userMsg 는 제외 (prompt 안 current_message 로 따로 감)
      let history = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content }));

      // 세션 갱신 후 요약이 있으면 히스토리 앞에 주입
      if (sessionSummary) {
        history = [
          { role: "user" as const, content: sessionSummary },
          { role: "assistant" as const, content: "이전 대화 맥락을 확인했습니다. 이어서 도와드리겠습니다." },
          ...history,
        ];
        // 요약은 한 번만 사용 후 초기화
        setSessionSummary(null);
      }

      // 파일 첨부가 있으면 base64 데이터 포함
      const attachments = files?.map((f) => ({
        name: f.name,
        type: f.type,
        size: f.size,
        base64: f.base64,
      }));

      await invoke("send_message", {
        message: text || `[파일 첨부: ${files?.map((f) => f.name).join(", ")}]`,
        id: turnId,
        agentId,
        history: history.length > 0 ? history : undefined,
        attachments,
      });
    } catch (err) {
      setIsStreaming(false);
      setCurrentTurnId(null);
      pushSystem(`전송 실패: ${String(err)}`, "error");
    }
  }

  async function handleInterrupt() {
    if (!currentTurnId) return;
    try {
      await invoke("interrupt", { id: currentTurnId });
    } catch (err) {
      console.error("interrupt failed:", err);
    }
  }

  async function handleNewConversation() {
    // 스트리밍 중에는 새 대화 생성 불가
    if (isStreaming) return;

    const id = crypto.randomUUID();
    try {
      const newConv = await createConversation(id, "New Conversation");
      setConversations((prev) => [newConv, ...prev]);
      setActiveConversationId(id);
      activeConversationIdRef.current = id;
      setMessages([]);
      // 메트릭 초기화
      setMetrics({
        totalInputTokens: 0,
        totalOutputTokens: 0,
        turnCount: 0,
        toolCallCount: 0,
        startedAt: Date.now(),
      });
    } catch (err) {
      console.error("[App] 대화 생성 실패:", err);
      pushSystem("대화 생성에 실패했습니다.", "error");
    }
  }

  async function handleSelectConversation(id: string) {
    if (isStreaming) return; // 스트리밍 중에는 전환 불가
    if (id === activeConversationId) return;

    setActiveConversationId(id);
    activeConversationIdRef.current = id;

    // DB에서 메시지 로드
    try {
      const msgs = await getMessages(id);
      setMessages(msgs);
      // 메트릭 초기화 (새 세션 시작)
      setMetrics({
        totalInputTokens: 0,
        totalOutputTokens: 0,
        turnCount: 0,
        toolCallCount: 0,
        startedAt: Date.now(),
      });
    } catch (err) {
      console.error("[App] 메시지 로드 실패:", err);
      setMessages([]);
      pushSystem("메시지를 불러오지 못했습니다.", "error");
    }
  }

  async function handleDeleteConversation(id: string) {
    try {
      await deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));

      // 삭제된 대화가 현재 활성 대화면 초기화
      if (activeConversationId === id) {
        setActiveConversationId(null);
        activeConversationIdRef.current = null;
        setMessages([]);
      }
    } catch (err) {
      console.error("[App] 대화 삭제 실패:", err);
      pushSystem("대화 삭제에 실패했습니다.", "error");
    }
  }

  // ─── Auto Session Continuity ─────────────────────────────
  // 대화 요약 생성 (최근 메시지 기반)
  function generateConversationSummary(msgs: ChatMessage[]): string {
    // user/assistant 메시지만 추출 (tool 결과 등 제외)
    const relevantMsgs = msgs.filter(
      (m) => m.role === "user" || m.role === "assistant"
    );

    // 최근 4개 메시지만 (2턴) - 컨텍스트 최소화
    const recentMsgs = relevantMsgs.slice(-4);

    if (recentMsgs.length === 0) {
      return "";
    }

    // 간단한 요약: 각 메시지 100자 제한, 핵심만
    const summaryLines = recentMsgs.map((m) => {
      const role = m.role === "user" ? "U" : "A";
      // 코드 블록, 긴 출력 등 제거하고 핵심만 추출
      let content = m.content
        .replace(/```[\s\S]*?```/g, "[code]") // 코드 블록 압축
        .replace(/\n+/g, " ")                  // 줄바꿈 → 공백
        .trim();

      // 100자로 엄격히 제한
      if (content.length > 100) {
        content = content.slice(0, 100) + "…";
      }
      return `${role}: ${content}`;
    });

    // 전체 요약 1500자 엄격 제한 (토큰 절약)
    let summary = summaryLines.join(" | ");
    if (summary.length > 1500) {
      summary = summary.slice(0, 1500) + "…";
    }

    return `<prior_conversation>${summary}</prior_conversation>`;
  }

  // 세션 자동 갱신 트리거
  async function triggerSessionRefresh() {
    console.log("[Session] 세션 갱신 시작...");

    const convId = activeConversationIdRef.current;
    if (!convId) {
      isRefreshingSessionRef.current = false;
      return;
    }

    try {
      // 1. 현재 대화 요약 생성
      const summary = generateConversationSummary(messages);
      setSessionSummary(summary);
      console.log("[Session] 대화 요약 생성 완료");

      // 2. agentId 리셋 (새 세션 시작)
      await updateConversationAgentId(convId, null);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId ? { ...c, agentId: null } : c
        )
      );
      console.log("[Session] agentId 리셋 완료");

      // 3. 메트릭 초기화 (새 세션)
      setMetrics({
        totalInputTokens: 0,
        totalOutputTokens: 0,
        turnCount: 0,
        toolCallCount: 0,
        startedAt: Date.now(),
      });

      // 4. 세션 갱신 완료 토스트 표시
      setSessionRefreshToast(true);
      setTimeout(() => setSessionRefreshToast(false), 4000);

      // 5. 시스템 메시지로 알림 (간결하게)
      pushSystem(
        "🔄 세션 갱신됨 (80% 도달). 대화 맥락 유지됩니다.",
        "info"
      );

      console.log("[Session] 세션 갱신 완료");
    } catch (err) {
      console.error("[Session] 세션 갱신 실패:", err);
      pushSystem("세션 갱신에 실패했습니다.", "error");
    } finally {
      isRefreshingSessionRef.current = false;
    }
  }

  // ─── Elicitation (확인 다이얼로그) ─────────────────────
  // 사용자 확인이 필요한 작업에서 호출
  function showElicitation(request: Omit<ElicitationRequest, "id">): Promise<ElicitationResponse> {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      setElicitationRequest({ ...request, id });
      elicitationResolveRef.current = resolve;
    });
  }

  async function handleElicitationResponse(response: ElicitationResponse) {
    setElicitationRequest(null);

    // Sidecar에 응답 전송 (MCP 도구 확인 요청에 대한 응답)
    try {
      await invoke("elicitation_response", {
        id: response.id,
        confirmed: response.confirmed,
      });
    } catch (err) {
      console.error("[Elicitation] 응답 전송 실패:", err);
    }

    // 로컬 Promise resolve (window.__showElicitation용)
    if (elicitationResolveRef.current) {
      elicitationResolveRef.current(response);
      elicitationResolveRef.current = null;
    }
  }

  // 전역에서 접근 가능하게 (MCP 도구에서 호출용) - window에 노출
  useEffect(() => {
    (window as any).__showElicitation = showElicitation;
    return () => {
      delete (window as any).__showElicitation;
    };
  }, []);

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onDeleteConversation={handleDeleteConversation}
        mcpConnected={mcpState.connected}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <MainChat
        messages={messages}
        status={status}
        isStreaming={isStreaming}
        onSendMessage={handleSendMessage}
        onInterrupt={handleInterrupt}
      />

      <MetricsPanel
        metrics={metrics}
        mcpConnected={mcpState.connected}
        onManualRefresh={triggerSessionRefresh}
      />

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        mcpConnected={mcpState.connected}
      />

      <ElicitationDialog
        request={elicitationRequest}
        onResponse={handleElicitationResponse}
      />

      {/* 세션 자동 갱신 토스트 */}
      {sessionRefreshToast && (
        <div className="session-refresh-toast">
          <span className="toast-icon">🔄</span>
          <span className="toast-text">세션이 자동 갱신되었습니다</span>
        </div>
      )}
    </div>
  );
}
