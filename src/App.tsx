import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
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
import CommandPalette from "./components/CommandPalette";
import { UpdateChecker } from "./components/UpdateChecker";
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
  generateSummaryPrompt,
  createCompressedConversation,
  updateConversationMetrics,
  getConversationMetrics,
} from "./db";
import "./App.css";
import logger from "./utils/logger";
import { useStableCallback } from "./utils/useStableCallback";

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
  const [dbReady, setDbReady] = useState(false);
  const [elicitationRequest, setElicitationRequest] = useState<ElicitationRequest | null>(null);
  const elicitationResolveRef = useRef<((response: ElicitationResponse) => void) | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // ─── Auto Session Continuity ────────────────────────────
  // Claude Max 기준 약 200K 토큰. 임계치는 estimateConvTokens(messages) 기반.
  // 실측 baseline (시스템 프롬프트 + MCP 42개 도구 정의) 은 보통 15-25K 정도라 50K 는 보수적 가드.
  // 90% 로 완화해 갱신 트리거 시점을 ~110K → ~160K 메시지 콘텐츠 (45% 헤드룸 증가).
  const MAX_CONTEXT_TOKENS = 200000;
  const CONTEXT_THRESHOLD = 0.9; // 90% (이전: 80%)
  const [sessionSummary, setSessionSummary] = useState<string | null>(null);
  const [sessionRefreshToast, setSessionRefreshToast] = useState(false);
  // dev rebuild 등으로 앱이 순간 종료됐다 복구된 경우를 감지해 표시
  const [recentRestartInfo, setRecentRestartInfo] = useState<string | null>(null);
  const isRefreshingSessionRef = useRef(false);
  const [isCompressing, setIsCompressing] = useState(false);

  // 메시지 저장 디바운스용 ref
  const pendingSaveRef = useRef<Map<string, ChatMessage>>(new Map());
  const saveTimerRef = useRef<number | null>(null);

  // state를 안정된 콜백 안에서 읽기 위한 latest-ref
  const activeConversationIdRef = useRef<string | null>(null);
  const dbReadyRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => { activeConversationIdRef.current = activeConversationId; }, [activeConversationId]);
  useEffect(() => { dbReadyRef.current = dbReady; }, [dbReady]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // 자동 갱신 임계치용 baseline — 마지막 갱신 시점의 추정 컨텍스트 크기.
  // 이 값을 빼면 "갱신 이후 새로 누적된 대화" 만 임계치 비교에 쓰인다.
  // 신규 대화 / 대화 전환 / 압축 시에는 0 으로 리셋.
  const refreshBaselineRef = useRef(0);

  // 대화 컨텍스트 크기 추정 — 자동 갱신 임계치 전용 (display 와 분리).
  // sidecar usage 의 cache_read_input_tokens 는 sub-agent 호출까지 합산되어
  // 한 턴에 1M~4M 까지 쉽게 부풀어 윈도우 점유율로는 부적절. 대신 messages 배열에서
  // 단조 증가하는 값을 추정 (4자 ≈ 1 토큰) + baseline 50K (시스템 프롬프트 + MCP 도구 정의).
  function estimateConvTokens(msgs: ChatMessage[]): number {
    // 실측: 시스템 프롬프트 + MCP 42개 도구 JSON 스키마 ≈ 15-25K. 20K 가 현실적 중앙값.
    // (이전 50K 은 과도한 보수치 — 신규 대화도 25% 출발이라 임계치 도달이 빨랐음)
    const baseline = 20_000;
    return msgs.reduce((sum, m) => {
      const contentLen = m.content?.length ?? 0;
      // tool 메시지는 toolInput / toolOutput 도 컨텍스트에 들어감
      const toolInputLen = (m as any).toolInput
        ? JSON.stringify((m as any).toolInput).length
        : 0;
      const toolOutputLen = ((m as any).toolOutput ?? "").length;
      return sum + Math.ceil((contentLen + toolInputLen + toolOutputLen) / 4);
    }, 0) + baseline;
  }

  // ─── 재기동 감지 (dev rebuild 등) ────────────────────
  // 주기적으로 localStorage 에 heartbeat 를 찍고, 기동 시 마지막 heartbeat 와의 갭을 본다.
  // 갭이 2~120초면 "방금 꺼졌다 복구" 로 해석 (HMR 이 아닌 Rust rebuild 가 대표 원인).
  useEffect(() => {
    const KEY = "kda_last_alive";
    const SHOWN_KEY = "kda_restart_shown";
    const now = Date.now();
    const raw = localStorage.getItem(KEY);
    const lastAlive = raw ? parseInt(raw, 10) : 0;
    const gap = now - lastAlive;
    const alreadyShown = localStorage.getItem(SHOWN_KEY);

    // 이미 표시했으면 다시 표시하지 않음 (HMR 중복 방지)
    if (lastAlive > 0 && gap >= 2000 && gap <= 120000 && alreadyShown !== String(lastAlive)) {
      const secs = Math.round(gap / 1000);
      setRecentRestartInfo(`재빌드로 ${secs}초간 재기동 — 복구됨`);
      localStorage.setItem(SHOWN_KEY, String(lastAlive));
    }

    localStorage.setItem(KEY, String(now));
    const hb = window.setInterval(() => {
      localStorage.setItem(KEY, String(Date.now()));
    }, 5000);

    return () => {
      window.clearInterval(hb);
    };
  }, []);

  // ─── 재기동 토스트 자동 닫힘 ─────────────────────────────
  useEffect(() => {
    if (!recentRestartInfo) return;
    const timer = window.setTimeout(() => setRecentRestartInfo(null), 5000);
    return () => window.clearTimeout(timer);
  }, [recentRestartInfo]);

  // ─── 앱 내 단축키 (Ctrl+P: 명령 팔레트) ─────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+P: 명령 팔레트 열기/닫기
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
      // Escape: 닫기
      if (e.key === "Escape" && commandPaletteOpen) {
        setCommandPaletteOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [commandPaletteOpen]);

  // ─── DB 초기화 및 대화 목록 로드 ─────────────────────
  useEffect(() => {
    (async () => {
      try {
        await initDB();
        const convs = await getAllConversations();
        setConversations(convs);
        setDbReady(true);
        logger.log("[App] DB 초기화 완료, 대화 수:", convs.length);
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
        logger.log(`[sidecar] ready v${ev.version}`);
        // MCP 상태 재확인 요청 (시작 시 mcp_status 이벤트 놓칠 수 있음)
        invoke("ping_sidecar").catch((e) =>
          logger.warn("[sidecar] ping failed:", e)
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
        setMetrics((m) => {
          const updated = { ...m, toolCallCount: m.toolCallCount + 1 };
          // DB에도 저장
          const convId = activeConversationIdRef.current;
          if (convId && dbReadyRef.current) {
            updateConversationMetrics(convId, {
              totalInputTokens: updated.totalInputTokens,
              totalOutputTokens: updated.totalOutputTokens,
              turnCount: updated.turnCount,
              toolCallCount: updated.toolCallCount,
            }).catch(() => {});
          }
          return updated;
        });
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
        const usage = ev.computed_usage ?? ev.usage ?? null;
        const newInputTokens = usage?.input_tokens ?? 0;
        const newOutputTokens = usage?.output_tokens ?? 0;
        // 컨텍스트 점유량 = 이번 턴 모델이 본 전체 토큰 (input + cache_creation + cache_read).
        // input_tokens 만 보면 cache hit 시 매우 작게 잡혀서 실제 윈도우 점유율과 동떨어짐.
        const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
        const cacheRead = usage?.cache_read_input_tokens ?? 0;
        const turnContextTokens = newInputTokens + cacheCreation + cacheRead;

        logger.log(
          `[Metrics] Turn IN: ${newInputTokens} (+cc:${cacheCreation} +cr:${cacheRead} = ctx:${turnContextTokens}), OUT: ${newOutputTokens}`
        );

        setMetrics((m) => {
          const updatedMetrics = {
            ...m,
            turnCount: m.turnCount + 1,
            totalInputTokens: m.totalInputTokens + newInputTokens,
            totalOutputTokens: m.totalOutputTokens + newOutputTokens,
            // 마지막 턴 컨텍스트 점유량 (누적 아님, 그 턴 한 번)
            currentContextTokens: turnContextTokens > 0 ? turnContextTokens : m.currentContextTokens,
          };

          // DB에 메트릭 저장 (비동기)
          const convIdForMetrics = activeConversationIdRef.current;
          if (convIdForMetrics && dbReadyRef.current) {
            updateConversationMetrics(convIdForMetrics, {
              totalInputTokens: updatedMetrics.totalInputTokens,
              totalOutputTokens: updatedMetrics.totalOutputTokens,
              turnCount: updatedMetrics.turnCount,
              toolCallCount: updatedMetrics.toolCallCount,
            }).catch((err) => console.error("[App] 메트릭 저장 실패:", err));
          }

          // 임계치 체크 — display 지표(currentContextTokens)는 sub-agent 호출 합산되어
          // 한 턴에 1M~4M 까지 부풀어 윈도우 점유율로 부적절. 대신 messages 추정 - baseline
          // 으로 "마지막 갱신 이후 누적된 실제 대화 크기" 를 본다.
          const estimated = estimateConvTokens(messagesRef.current);
          const effective = Math.max(0, estimated - refreshBaselineRef.current);
          const contextUsage = effective / MAX_CONTEXT_TOKENS;
          if (contextUsage >= CONTEXT_THRESHOLD && !isRefreshingSessionRef.current) {
            logger.log(`[Session] 추정 컨텍스트 ${(contextUsage * 100).toFixed(1)}% (${effective}/${MAX_CONTEXT_TOKENS}) 도달 - 세션 자동 갱신 시작`);
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
          logger.log(`[sidecar] ${ev.message}`);
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

  const handleSendMessage = useStableCallback(async (text: string, files?: FileAttachment[]) => {
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

      // 활성 provider / model / API 키 가져오기 (Settings 에서 저장)
      // Settings 의 LS_ACTIVE_PROVIDER / LS_ACTIVE_MODEL 와 동일 키.
      let provider: string | undefined;
      let model: string | undefined;
      let apiKey: string | undefined;
      try {
        provider = localStorage.getItem("kda_active_provider") || "claude";
        model = localStorage.getItem("kda_active_model") || undefined;
        // claude(Max 구독) 외의 provider 는 API 키 필요
        if (provider !== "claude") {
          const storedKeys = localStorage.getItem("kda_api_keys");
          if (storedKeys) {
            const keys = JSON.parse(storedKeys);
            apiKey = keys[provider];
          }
        }
      } catch (e) {
        console.warn("[App] provider/model 로드 실패:", e);
        provider = "claude";
      }

      // 에이전트 권한 (Settings UI 의 8개 토글 — id → level)
      // Settings.tsx 가 [{id, level, ...}] 배열로 저장하므로 sidecar 의 map 형태 { id: level } 로 변환.
      // 변환 실패 시 undefined 로 두면 sidecar 가 DEFAULT_PERMISSIONS 사용.
      let permissions: Record<string, string> | undefined;
      try {
        const storedPerms = localStorage.getItem("kda_permissions");
        if (storedPerms) {
          const arr = JSON.parse(storedPerms);
          if (Array.isArray(arr)) {
            permissions = {};
            for (const p of arr) {
              if (
                p &&
                typeof p.id === "string" &&
                (p.level === "auto" || p.level === "ask" || p.level === "manual")
              ) {
                permissions[p.id] = p.level;
              }
            }
          }
        }
      } catch (e) {
        console.warn("[App] permissions 로드 실패:", e);
      }

      // 개별 잠금된 도구 (Settings UI "정밀 잠금" 섹션 — 도구 풀네임 배열)
      // 카테고리 토글과 독립적으로 sidecar 의 --disallowed-tools 에 추가됨.
      let lockedTools: string[] | undefined;
      try {
        const storedLocked = localStorage.getItem("kda_locked_tools");
        if (storedLocked) {
          const arr = JSON.parse(storedLocked);
          if (Array.isArray(arr)) {
            lockedTools = arr.filter(
              (t): t is string => typeof t === "string" && t.trim().length > 0
            );
            if (lockedTools.length === 0) lockedTools = undefined;
          }
        }
      } catch (e) {
        console.warn("[App] lockedTools 로드 실패:", e);
      }

      await invoke("send_message", {
        message: text || `[파일 첨부: ${files?.map((f) => f.name).join(", ")}]`,
        id: turnId,
        agentId,
        history: history.length > 0 ? history : undefined,
        attachments,
        apiKey,
        provider,
        model,
        permissions,
        lockedTools,
      });
    } catch (err) {
      setIsStreaming(false);
      setCurrentTurnId(null);
      pushSystem(`전송 실패: ${String(err)}`, "error");
    }
  });

  const handleInterrupt = useStableCallback(async () => {
    if (!currentTurnId) return;
    try {
      await invoke("interrupt", { id: currentTurnId });

      // 🔧 FIX: interrupt 후 UI 상태 즉시 정리 (done 이벤트가 안 올 수 있음)
      // 짧은 딜레이 후 강제 정리 (sidecar가 done을 보내면 중복 호출되어도 무해)
      setTimeout(() => {
        setIsStreaming(false);
        setCurrentTurnId(null);
        // 스트리밍 중인 메시지의 커서 제거
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "assistant" && (m as any).streaming
              ? { ...m, streaming: false }
              : m
          )
        );
      }, 500);
    } catch (err) {
      console.error("interrupt failed:", err);
      // 에러 시에도 UI 상태 정리
      setIsStreaming(false);
      setCurrentTurnId(null);
    }
  });

  const handleNewConversation = useStableCallback(async () => {
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
        currentContextTokens: 0,
      });
      // 자동 갱신 baseline 도 리셋 — 새 대화는 0 부터 카운트
      refreshBaselineRef.current = 0;
    } catch (err) {
      console.error("[App] 대화 생성 실패:", err);
      pushSystem("대화 생성에 실패했습니다.", "error");
    }
  });

  const handleSelectConversation = useStableCallback(async (id: string) => {
    if (isStreaming) return; // 스트리밍 중에는 전환 불가
    if (id === activeConversationId) return;

    setActiveConversationId(id);
    activeConversationIdRef.current = id;
    // 대화 전환 시 baseline 리셋 — 다른 대화는 별개의 누적 컨텍스트
    refreshBaselineRef.current = 0;

    // DB에서 메시지와 메트릭 로드
    try {
      const [msgs, savedMetrics] = await Promise.all([
        getMessages(id),
        getConversationMetrics(id),
      ]);
      setMessages(msgs);

      // 저장된 메트릭이 있으면 복원, 없으면 메시지 기반으로 추정
      if (savedMetrics && savedMetrics.totalInputTokens > 0) {
        setMetrics({
          totalInputTokens: savedMetrics.totalInputTokens,
          totalOutputTokens: savedMetrics.totalOutputTokens,
          turnCount: savedMetrics.turnCount,
          toolCallCount: savedMetrics.toolCallCount,
          startedAt: Date.now(),
          // currentContextTokens 는 다음 턴에서 자연스럽게 갱신됨 (영속 불필요)
          currentContextTokens: 0,
        });
        logger.log(`[App] 메트릭 복원: IN ${savedMetrics.totalInputTokens}, OUT ${savedMetrics.totalOutputTokens}`);
      } else {
        // 저장된 메트릭이 없으면 메시지 기반으로 추정 (4자당 1토큰)
        const estimatedTokens = msgs.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
        const userMessages = msgs.filter(m => m.role === "user").length;
        const toolMessages = msgs.filter(m => m.role === "tool").length;

        setMetrics({
          totalInputTokens: estimatedTokens,
          totalOutputTokens: Math.ceil(estimatedTokens * 0.6), // 대략 출력은 입력의 60%
          turnCount: userMessages,
          toolCallCount: toolMessages,
          startedAt: Date.now(),
          currentContextTokens: 0,
        });
        logger.log(`[App] 메트릭 추정: ${estimatedTokens} tokens (${msgs.length} messages)`);
      }
    } catch (err) {
      console.error("[App] 메시지 로드 실패:", err);
      setMessages([]);
      setMetrics({
        totalInputTokens: 0,
        totalOutputTokens: 0,
        turnCount: 0,
        toolCallCount: 0,
        startedAt: Date.now(),
        currentContextTokens: 0,
      });
      pushSystem("메시지를 불러오지 못했습니다.", "error");
    }
  });

  const handleDeleteConversation = useStableCallback(async (id: string) => {
    try {
      await deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));

      // 삭제된 대화가 현재 활성 대화면 초기화
      if (activeConversationId === id) {
        setActiveConversationId(null);
        activeConversationIdRef.current = null;
        setMessages([]);
        refreshBaselineRef.current = 0;
      }
    } catch (err) {
      console.error("[App] 대화 삭제 실패:", err);
      pushSystem("대화 삭제에 실패했습니다.", "error");
    }
  });

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
  const triggerSessionRefresh = useStableCallback(async () => {
    logger.log("[Session] 세션 갱신 시작...");

    const convId = activeConversationIdRef.current;
    if (!convId) {
      isRefreshingSessionRef.current = false;
      return;
    }

    try {
      // 1. 현재 대화 요약 생성
      const summary = generateConversationSummary(messages);
      setSessionSummary(summary);
      logger.log("[Session] 대화 요약 생성 완료");

      // 2. agentId 리셋 (새 세션 시작)
      await updateConversationAgentId(convId, null);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId ? { ...c, agentId: null } : c
        )
      );
      logger.log("[Session] agentId 리셋 완료");

      // 3. 메트릭 초기화 (새 세션)
      setMetrics({
        totalInputTokens: 0,
        totalOutputTokens: 0,
        turnCount: 0,
        toolCallCount: 0,
        startedAt: Date.now(),
        currentContextTokens: 0,
      });

      // 3.5 임계치 baseline 갱신 — 현재 messages 추정값을 기준으로 잡아서
      // 다음 갱신은 "여기서부터 80% 더 누적" 했을 때 발생.
      refreshBaselineRef.current = estimateConvTokens(messagesRef.current);

      // 4. 세션 갱신 완료 토스트 표시
      setSessionRefreshToast(true);
      setTimeout(() => setSessionRefreshToast(false), 4000);

      // 5. 시스템 메시지로 알림 (간결하게)
      pushSystem(
        "🔄 세션 갱신됨 (80% 도달). 대화 맥락 유지됩니다.",
        "info"
      );

      logger.log("[Session] 세션 갱신 완료");
    } catch (err) {
      console.error("[Session] 세션 갱신 실패:", err);
      pushSystem("세션 갱신에 실패했습니다.", "error");
    } finally {
      isRefreshingSessionRef.current = false;
    }
  });

  // ─── 대화 압축 & 이어하기 ─────────────────────────────
  const handleCompressContext = useStableCallback(async () => {
    if (!activeConversationId || isCompressing || isStreaming) {
      return;
    }

    const currentConv = conversations.find((c) => c.id === activeConversationId);
    if (!currentConv) return;

    // 확인 메시지
    const confirmed = window.confirm(
      "대화를 요약하고 새 세션으로 이어서 진행합니다.\n\n" +
      "• 현재 대화는 그대로 보존됩니다\n" +
      "• 새 대화가 생성되고 요약이 포함됩니다\n" +
      "• Claude가 요약을 참고해 대화를 이어갑니다\n\n" +
      "계속하시겠습니까?"
    );
    if (!confirmed) return;

    setIsCompressing(true);
    pushSystem("📦 대화 압축 중... 잠시만 기다려주세요.", "info");

    try {
      // 1. 요약 프롬프트 생성
      const summaryPrompt = generateSummaryPrompt(messages);

      // 2. Claude에게 요약 요청 (특별한 턴으로 처리)
      const summaryTurnId = crypto.randomUUID();

      // 요약 요청을 보내고 응답 받기
      await invoke("send_message", {
        message: summaryPrompt,
        id: summaryTurnId,
        agentId: null, // 새 세션으로 요약 요청
        history: null,
      });

      // 응답을 기다림 (done 이벤트가 올 때까지)
      // 실제로는 sidecar 이벤트에서 처리하므로, 여기서는 타이머로 대기
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // 마지막 assistant 메시지가 요약이라고 가정
      const lastAssistantMsg = messages
        .filter((m) => m.role === "assistant")
        .pop();

      const summary = lastAssistantMsg?.content || "이전 대화 내용 요약";

      // 3. 압축된 새 대화 생성
      const newConvId = await createCompressedConversation(
        activeConversationId,
        summary,
        currentConv.title
      );

      // 4. 대화 목록 새로고침
      const updatedConvs = await getAllConversations();
      setConversations(updatedConvs);

      // 5. 새 대화로 전환
      setActiveConversationId(newConvId);
      const newMessages = await getMessages(newConvId);
      setMessages(newMessages);

      // 6. 메트릭 초기화
      setMetrics({
        totalInputTokens: 0,
        totalOutputTokens: 0,
        turnCount: 0,
        toolCallCount: 0,
        startedAt: Date.now(),
        currentContextTokens: 0,
      });
      // 압축으로 새 대화로 옮겨갔으니 baseline 리셋
      refreshBaselineRef.current = 0;

      pushSystem(
        `✅ 대화 압축 완료! 새 세션 "${currentConv.title} (continued)"에서 이어갑니다.`,
        "info"
      );

      logger.log(`[Compress] 대화 압축 완료: ${activeConversationId} → ${newConvId}`);
    } catch (err) {
      console.error("[Compress] 대화 압축 실패:", err);
      pushSystem("대화 압축에 실패했습니다: " + (err as Error).message, "error");
    } finally {
      setIsCompressing(false);
    }
  });

  // ─── Elicitation (확인 다이얼로그) ─────────────────────
  // 사용자 확인이 필요한 작업에서 호출
  const showElicitation = useStableCallback((request: Omit<ElicitationRequest, "id">): Promise<ElicitationResponse> => {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      setElicitationRequest({ ...request, id });
      elicitationResolveRef.current = resolve;
    });
  });

  const handleElicitationResponse = useStableCallback(async (response: ElicitationResponse) => {
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
  });

  // 전역에서 접근 가능하게 (MCP 도구에서 호출용) - window에 노출
  // 핸들러가 useStableCallback 으로 평생 동일 ref 라 deps 비워도 안전 (mount 시 1회만)
  useEffect(() => {
    (window as any).__showElicitation = showElicitation;
    (window as any).__kdaSendMessage = handleSendMessage;
    (window as any).__kdaOpenCommandPalette = () => setCommandPaletteOpen(true);
    return () => {
      delete (window as any).__showElicitation;
      delete (window as any).__kdaSendMessage;
      delete (window as any).__kdaOpenCommandPalette;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── 전역 단축키 등록 (Phase 6) ────────────────────────
  useEffect(() => {
    let registeredK = false;
    let registeredS = false;
    let registeredP = false;

    const setupShortcuts = async () => {
      try {
        // Ctrl+Shift+Space: 창 토글 (K는 브라우저 DevTools와 충돌)
        await register("Ctrl+Shift+Space", async () => {
          logger.log("[Shortcut] Ctrl+Shift+Space triggered");
          try {
            await invoke("show_main_window");
          } catch (err) {
            console.error("[Shortcut] 창 토글 실패:", err);
          }
        });
        logger.log("[Shortcut] Ctrl+Shift+Space 등록 완료");
        registeredK = true;

        // Ctrl+Shift+S: 스크린샷 캡처 후 분석
        await register("Ctrl+Shift+S", async () => {
          logger.log("[Shortcut] Ctrl+Shift+S triggered");
          try {
            // 창 표시
            await invoke("show_main_window");
            // 전역 함수로 메시지 전송 (App 컴포넌트에서 노출)
            if ((window as any).__kdaSendMessage) {
              (window as any).__kdaSendMessage("현재 화면을 스크린샷으로 캡처해서 분석해줘");
            }
          } catch (err) {
            console.error("[Shortcut] 스크린샷 분석 실패:", err);
          }
        });
        logger.log("[Shortcut] Ctrl+Shift+S 등록 완료");
        registeredS = true;

        // Ctrl+Shift+P: 명령 팔레트 열기
        await register("Ctrl+Shift+P", async () => {
          logger.log("[Shortcut] Ctrl+Shift+P triggered");
          try {
            await invoke("show_main_window");
            if ((window as any).__kdaOpenCommandPalette) {
              (window as any).__kdaOpenCommandPalette();
            }
          } catch (err) {
            console.error("[Shortcut] 명령 팔레트 실패:", err);
          }
        });
        logger.log("[Shortcut] Ctrl+Shift+P 등록 완료");
        registeredP = true;
      } catch (err) {
        console.error("[Shortcut] 전역 단축키 등록 실패:", err);
      }
    };

    setupShortcuts();

    return () => {
      if (registeredK) unregister("Ctrl+Shift+Space").catch(console.error);
      if (registeredS) unregister("Ctrl+Shift+S").catch(console.error);
      if (registeredP) unregister("Ctrl+Shift+P").catch(console.error);
    };
  }, []);

  // 자식 memo 가 깨지지 않도록 inline arrow 대신 안정 ref 사용.
  // setSettingsOpen / setCommandPaletteOpen 자체는 React가 안정 ref 보장하지만,
  // (() => setSettingsOpen(true)) 같이 한 번 감싸면 매 렌더 새 함수가 됨.
  const openSettings = useStableCallback(() => setSettingsOpen(true));
  const closeSettings = useStableCallback(() => setSettingsOpen(false));
  const closeCommandPalette = useStableCallback(() => setCommandPaletteOpen(false));

  return (
    <div className="app">
      <UpdateChecker />
      <Sidebar
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onDeleteConversation={handleDeleteConversation}
        onRefreshConversations={refreshConversations}
        mcpConnected={mcpState.connected}
        onOpenSettings={openSettings}
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
        onCompressContext={handleCompressContext}
        isCompressing={isCompressing}
      />

      <Settings
        open={settingsOpen}
        onClose={closeSettings}
        mcpConnected={mcpState.connected}
      />

      <ElicitationDialog
        request={elicitationRequest}
        onResponse={handleElicitationResponse}
      />

      <CommandPalette
        open={commandPaletteOpen}
        onClose={closeCommandPalette}
        onSendMessage={handleSendMessage}
        onOpenSettings={openSettings}
        onNewChat={handleNewConversation}
      />

      {/* 세션 자동 갱신 토스트 */}
      {sessionRefreshToast && (
        <div className="session-refresh-toast">
          <span className="toast-icon">🔄</span>
          <span className="toast-text">세션이 자동 갱신되었습니다</span>
        </div>
      )}

      {/* dev rebuild 재기동 토스트 */}
      {recentRestartInfo && (
        <div className="session-refresh-toast restart-toast">
          <span className="toast-icon">⟳</span>
          <span className="toast-text">{recentRestartInfo}</span>
        </div>
      )}
    </div>
  );
}
