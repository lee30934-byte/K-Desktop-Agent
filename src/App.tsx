import { useEffect, useState, useCallback, useRef, useMemo } from "react";
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
  RateLimitInfo,
  RateLimitWindow,
} from "./types";
import ElicitationDialog from "./components/ElicitationDialog";
import CommandPalette from "./components/CommandPalette";
import { UpdateChecker } from "./components/UpdateChecker";
import SidebarResizer from "./components/SidebarResizer";
import SidePanel, { type SidePanelItem } from "./components/SidePanel";
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
  // Phase 32 — folders + DnD + favorites + color/icon
  getAllFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  moveFolder,
  setFolderColor,
  setFolderIcon,
  moveConversationToFolder,
  toggleConversationFavorite,
  setConversationColor,
  setConversationIcon,
  searchConversations,
} from "./db";
import type { Folder } from "./types";
import "./App.css";
import logger from "./utils/logger";
import { useStableCallback } from "./utils/useStableCallback";

// ─── Rate Limit Normalization (Phase 15.5) ────────────────────────────────
//
// provider 별 raw payload → 표준 RateLimitInfo 로 변환.
// 첫 빌드 후 sidecar.log 에서 실제 필드명 확인되면 매핑 정밀화 가능 — 지금은
// 가능한 패턴들을 다 시도하는 defensive parser.
function readWindow(obj: any): RateLimitWindow | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  // Claude Code statusLine: used_percentage + resets_at (ISO string)
  // OpenAI Codex backend-api/codex/usage: utilization_percent + reset_at (epoch sec)
  // Anthropic Claude Code SSE rate_limit_event: resetsAt (epoch sec) — used% 없음
  const usedRaw =
    obj.used_percentage ??
    obj.used_pct ??
    obj.used_percent ??              // Phase 33 (v0.5.21) — chatgpt.com /codex/usage 실제 키
    obj.utilization_percent ??
    obj.utilization ??
    obj.percent_used ??
    (typeof obj.remaining === "number" && typeof obj.limit === "number"
      ? ((obj.limit - obj.remaining) / obj.limit) * 100
      : undefined);
  const resetRaw =
    obj.resets_at ??
    obj.reset_at ??
    obj.resetsAt ??
    obj.reset_time ??
    (typeof obj.resets_in_seconds === "number" ? Date.now() + obj.resets_in_seconds * 1000 : undefined) ??
    (typeof obj.next_reset === "number" ? obj.next_reset : undefined);
  const used = typeof usedRaw === "number" ? usedRaw : undefined;
  // resetRaw 가 ISO string 이면 Date.parse, 작은 epoch(sec) 이면 *1000
  let reset: number | undefined;
  if (typeof resetRaw === "number") {
    reset = resetRaw < 1e12 ? resetRaw * 1000 : resetRaw;
  } else if (typeof resetRaw === "string") {
    const parsed = Date.parse(resetRaw);
    if (!Number.isNaN(parsed)) reset = parsed;
  }
  if (used === undefined && reset === undefined && obj.used_tokens === undefined) return undefined;

  // 시간 진행률 (Phase 15.5 🅑) — block_start ~ block_end / weekly 의 week_start ~ +7d 사이 현재 위치.
  // ccusage path 에서 used_pct 못 받을 때 UI 의 진행률 bar 로 사용. "한도 %" 가 아니라 "시간 %".
  let timePct: number | undefined;
  const blockStartRaw = obj.block_start ?? obj.week_start;
  const blockEndRaw = obj.block_end ?? (obj.week_start ? new Date(new Date(obj.week_start).getTime() + 7 * 24 * 3600 * 1000).toISOString() : undefined);
  if (blockStartRaw && blockEndRaw) {
    const startMs = typeof blockStartRaw === "string" ? Date.parse(blockStartRaw) : blockStartRaw;
    const endMs = typeof blockEndRaw === "string" ? Date.parse(blockEndRaw) : blockEndRaw;
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs) {
      const now = Date.now();
      const pct = ((now - startMs) / (endMs - startMs)) * 100;
      timePct = Math.max(0, Math.min(100, pct));
    }
  }

  return {
    used_pct: used !== undefined ? Math.max(0, Math.min(100, used)) : undefined,
    reset_at: reset ?? 0,
    used_tokens: obj.used_tokens ?? obj.used,
    limit_tokens: obj.limit_tokens ?? obj.limit,
    time_pct: timePct,
    burn_rate_per_min: obj.burn_rate,
    projection_remaining_min: obj.projection_remaining_min,
  };
}

function normalizeRateLimit(
  provider: "anthropic" | "codex",
  payload: unknown,
  receivedAt: number
): RateLimitInfo | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as any;
  // Phase 31 (v0.5.19): chatgpt.com endpoint 가 schema 자주 바꿈 — 후보 키 확장.
  // 가능한 컨테이너 필드들 (top-level)
  const primaryRaw =
    p.primary ??
    p.five_hour ??
    p.hourly ??
    p["5h"] ??
    p.short ??
    p.short_term ??
    p.hourly_quota ??
    p.usage_5h;
  const secondaryRaw =
    p.secondary ??
    p.weekly ??
    p.seven_day ??
    p["7d"] ??
    p.long ??
    p.long_term ??
    p.weekly_quota ??
    p.usage_weekly;
  let primary = readWindow(primaryRaw);
  let secondary = readWindow(secondaryRaw);

  // rate_limits 배열인 경우 (Anthropic 형식)
  if (!primary && Array.isArray(p.rate_limits)) {
    primary = readWindow(
      p.rate_limits.find((r: any) => /5|hour|primary|short/i.test(r?.type ?? r?.window ?? "")),
    );
  }
  if (!secondary && Array.isArray(p.rate_limits)) {
    secondary = readWindow(
      p.rate_limits.find((r: any) => /week|7d|secondary|long/i.test(r?.type ?? r?.window ?? "")),
    );
  }

  // Phase 31: usage / quotas / limits 같은 컨테이너 안의 객체도 시도
  // Phase 33 (v0.5.21): Codex 의 실제 schema 는 `rate_limit` 컨테이너 안에 primary_window/secondary_window
  for (const containerKey of [
    "usage",
    "quotas",
    "limits",
    "subscription",
    "plan",
    "rate_limit",       // Phase 33 — chatgpt.com /codex/usage 의 실제 키 (singular)
    "rate_limits",      // 일부 endpoint 가 plural 도 씀
  ]) {
    if (primary && secondary) break;
    const c = p[containerKey];
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    // Phase 33 — primary_window / secondary_window 도 후보
    if (!primary) {
      primary = readWindow(
        c.primary ??
          c.primary_window ??
          c.five_hour ??
          c.hourly ??
          c.short,
      );
    }
    if (!secondary) {
      secondary = readWindow(
        c.secondary ??
          c.secondary_window ??
          c.weekly ??
          c.seven_day ??
          c.long,
      );
    }
  }

  // Phase 33 (v0.5.21) — top-level 에 primary_window/secondary_window 가 직접 박힌 케이스도 안전망
  if (!primary && p.primary_window) primary = readWindow(p.primary_window);
  if (!secondary && p.secondary_window) secondary = readWindow(p.secondary_window);

  if (!primary && !secondary) return null;
  return { provider, primary, secondary, receivedAt, rawPayload: payload };
}

export default function App() {
  // ─── 상태 ───────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // Phase 32 — folder tree
  const [folders, setFolders] = useState<Folder[]>([]);
  // Phase 38 (v0.5.26) — 사이드바 폭 (resizable, localStorage 저장)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = parseInt(localStorage.getItem("kda_sidebar_width") || "", 10);
      if (!Number.isNaN(saved) && saved >= 200 && saved <= 600) return saved;
    } catch {}
    return 260;
  });
  // Phase 44 (v0.5.32) — 우측 SidePanel: 대화 안 link/file 클릭 → 미리보기
  const [sidePanelOpen, setSidePanelOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("kda_side_panel_open") === "1";
    } catch {
      return false;
    }
  });
  const [sidePanelItem, setSidePanelItem] = useState<SidePanelItem | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem("kda_side_panel_open", sidePanelOpen ? "1" : "0");
    } catch {}
  }, [sidePanelOpen]);
  const handlePreviewRequest = useStableCallback((pathOrUrl: string, label?: string) => {
    setSidePanelItem({ pathOrUrl, label });
    setSidePanelOpen(true);
  });
  const handleSidePanelClose = useStableCallback(() => {
    setSidePanelItem(null);
  });
  // CSS variable 동기화
  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
    try {
      localStorage.setItem("kda_sidebar_width", String(sidebarWidth));
    } catch {}
  }, [sidebarWidth]);
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

  // ─── Phase 15.5 — Rate Limit Info ────────────────────────
  // Anthropic / Codex 의 5h primary + 7d secondary 한도. provider 별로 별도 state.
  // localStorage 영속 — 앱 재시작 후에도 마지막 본 값 유지.
  const [rateLimitAnthropic, setRateLimitAnthropic] = useState<RateLimitInfo | null>(() => {
    try {
      const raw = localStorage.getItem("kda_rate_limit_anthropic");
      return raw ? (JSON.parse(raw) as RateLimitInfo) : null;
    } catch {
      return null;
    }
  });
  const [rateLimitCodex, setRateLimitCodex] = useState<RateLimitInfo | null>(() => {
    try {
      const raw = localStorage.getItem("kda_rate_limit_codex");
      return raw ? (JSON.parse(raw) as RateLimitInfo) : null;
    } catch {
      return null;
    }
  });
  // Phase 29 (v0.5.17): Codex usage polling 의 fail 사유 — UI 노출용. null 이면 정상 또는 미로그인.
  const [codexUsageError, setCodexUsageError] = useState<string | null>(null);
  // Phase 31 (v0.5.19): normalize fail 시 raw payload 보관 — [Raw 보기] 버튼이 열어 K 가 schema 직접 확인.
  const [codexUsageRawPayload, setCodexUsageRawPayload] = useState<unknown>(null);

  // ─── Auto Session Continuity ────────────────────────────
  // 분모는 모델별 동적 (currentModelMaxTokens — Claude default = 1M, 그 외 = 200K). 90% 트리거.
  // (이전엔 200K 고정이었으나 Phase 12 — Context Meter v2 로 모델별 분리.)
  const CONTEXT_THRESHOLD = 0.9; // 90% (이전: 80%)
  const [sessionSummary, setSessionSummary] = useState<string | null>(null);
  const [sessionRefreshToast, setSessionRefreshToast] = useState(false);
  // dev rebuild 등으로 앱이 순간 종료됐다 복구된 경우를 감지해 표시
  const [recentRestartInfo, setRecentRestartInfo] = useState<string | null>(null);
  const isRefreshingSessionRef = useRef(false);
  const [isCompressing, setIsCompressing] = useState(false);

  // ─── 중단된 턴 같은 질문 재시도 ────────────────────────────────
  // 마지막 메시지가 user 인데 assistant 응답이 없으면 release rebuild / 강제 종료로
  // 턴이 끊긴 것으로 간주. 사용자가 [같은 질문 재시도] 클릭하면 같은 user 텍스트로 재요청.
  // (API 비용은 1턴 다시 듦 — 대신 K 가 같은 질문 재타이핑할 필요 없음)
  // 단, 현재는 끊긴 턴의 partial 응답/도구 호출 정보가 prior_conversation 에 합류해서
  // 모델이 "어디까지 했는지" 인지하므로 같은 도구 중복 호출은 줄어들지만,
  // SDK 내부의 실제 turn 상태를 이어받는 것은 아니다 (그건 Step 3 영역).
  const [pendingResume, setPendingResume] = useState<{
    convId: string;
    userMessage: ChatMessage;
  } | null>(null);

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

  // 대화 컨텍스트 크기 추정 — 자동 갱신 임계치 + Context % 표시 공통 지표.
  //
  // 스코프는 sidecar 가 실제로 받는 양과 일치해야 한다:
  //   handleSendMessage / handleResumeInterrupted 모두
  //   `messages.filter(role in [user, assistant]).slice(-20)` 만 history 로 보낸다.
  // 즉 tool 메시지(base64 스크린샷 19MB 누적 등) 와 21번째 이전 메시지는
  // Claude 의 컨텍스트 윈도우에 들어가지 않으므로 추정에서도 빠져야 한다.
  //
  // 과거 버그: 모든 메시지의 toolOutput 까지 합산 → 1705-turn 대화에서 toolOutput 19MB
  // 누적이 5M 토큰으로 잡혀 화면 % 가 2527% 까지 부풀었음. 이번 수정으로 해결.
  //
  // baseline 20K = 시스템 프롬프트 + MCP 42개 도구 JSON 스키마 (실측 15-25K 중앙값).
  // 4자 ≈ 1 토큰 휴리스틱 — 영어 ±10%, 한글 ±20% 오차이지만 윈도우 점유율 추적용으로 충분.
  // Phase 35 (v0.5.23): base64 image / huge data 자동 short-circuit + 진단 로그.
  // - data:image/...;base64,... 같은 inline base64 가 content 안에 있으면 placeholder 길이로 치환
  // - PER_MESSAGE_CAP 을 200K → 50K 로 낮춤 (정상 user 메시지가 50K 토큰 = 200KB 텍스트는 거의 없음)
  // - 50K 넘는 메시지는 logger 로 기록 → K 가 reproduce 시 어떤 메시지가 폭발하는지 식별 가능
  function estimateConvTokens(msgs: ChatMessage[]): number {
    const baseline = 20_000;
    const recent = msgs
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-20);
    const PER_MESSAGE_CAP = 50_000;
    let total = baseline;
    for (let i = 0; i < recent.length; i++) {
      const m = recent[i];
      const raw = m.content ?? "";
      // base64 inline image (data:image/...) 자동 단축 — 모델한테 안 가는 UI-only 미리보기일 수 있음
      const sanitized = raw.replace(
        /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g,
        "[IMG]",
      );
      const tokens = Math.ceil(sanitized.length / 4);
      const capped = Math.min(tokens, PER_MESSAGE_CAP);
      total += capped;
      if (tokens > 50_000) {
        // 한 메시지가 50K (~200KB) 넘으면 진단 로그 — DevTools console + sidecar.log 양쪽
        logger.warn(
          `[estimate] huge message #${i} role=${m.role} rawLen=${raw.length} sanitizedLen=${sanitized.length} tokens=${tokens} → capped=${capped}`,
        );
      }
    }
    return total;
  }

  // 메시지 변경 시에만 재계산 — 현재 대화의 컨텍스트 윈도우 추정 점유량.
  // MetricsPanel 의 Context % 표시에도 같은 지표를 사용해 자동 갱신 트리거와 일치시킨다.
  // (raw cache_read 는 sub-agent / iterative tool 호출이 누적 합산되어 한 턴에 1M~4M 까지
  // 부풀어 윈도우 점유율로 부적절. estimateConvTokens 는 실제 메시지 길이 기반이라 안정적.)
  const estimatedContextTokens = useMemo(
    () => estimateConvTokens(messages),
    [messages]
  );

  // ─── 활성 provider/model 추적 (MetricsPanel 표시 + Settings 변경 즉시 반영) ───
  // localStorage 의 kda_active_provider / kda_active_model 가 진실 소스. Settings 가 저장하면
  // 같은 탭에서는 storage 이벤트가 안 오므로, App 안에서도 'kda-active-changed' custom 이벤트로
  // 알려주는 패턴 + 'storage' 이벤트(다른 탭/창 변경) 양쪽 모두 듣는다.
  const [activeProvider, setActiveProvider] = useState<string>(
    () => localStorage.getItem("kda_active_provider") || "claude"
  );
  const [activeModelId, setActiveModelId] = useState<string>(
    () => localStorage.getItem("kda_active_model") || "default"
  );
  useEffect(() => {
    function refreshActive() {
      setActiveProvider(localStorage.getItem("kda_active_provider") || "claude");
      setActiveModelId(localStorage.getItem("kda_active_model") || "default");
    }
    window.addEventListener("storage", refreshActive);
    window.addEventListener("kda-active-changed", refreshActive);
    return () => {
      window.removeEventListener("storage", refreshActive);
      window.removeEventListener("kda-active-changed", refreshActive);
    };
  }, []);

  // ─── Phase 18/20 — First-run 자동 감지 → Settings 자동 열기 ────────
  // ~/.kda/first-run-completed.flag 가 없으면 첫 실행으로 간주 → Settings 의
  // 시스템 탭 ("필수 도구" 섹션) 으로 자동 이동해서 K 가 의존성 셋업할 수 있게.
  //
  // Phase 20 (v0.5.6) 강화:
  //   - localStorage → sessionStorage 가드: KDA 프로세스가 살아있는 동안 한 번만,
  //     재시작하면 다시 시도. localStorage 였을 땐 K 가 한 번 닫고 KDA 재시작해도
  //     영구 봉인되어 마법사 다시 못 보는 함정 있었음 (K PC v0.5.3 시점 발견).
  //   - 1초 지연 + 명시적 console 로깅 으로 useEffect timing/silent throw 진단 가능.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        try {
          console.info("[first-run] is_first_run 호출 시작");
          const firstRun = await invoke<boolean>("is_first_run");
          console.info("[first-run] is_first_run 결과:", firstRun);
          if (cancelled) return;
          if (firstRun) {
            const seenKey = "kda_firstrun_wizard_seen_v2";
            if (!sessionStorage.getItem(seenKey)) {
              sessionStorage.setItem(seenKey, "1");
              try {
                localStorage.setItem("kda_active_settings_tab", "system");
              } catch {}
              console.info("[first-run] Settings 자동 오픈 (system 탭)");
              setSettingsOpen(true);
            } else {
              console.info("[first-run] sessionStorage 가드 — 이번 세션 이미 표시함, skip");
            }
          } else {
            console.info("[first-run] sentinel 박혀있음, skip");
          }
        } catch (e) {
          console.warn("[first-run] 감지 실패:", e);
        }
      })();
    }, 1000);  // 1초 지연 — sidecar 부팅 + db init 충돌 회피
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // provider/model → MetricsPanel 에 표시할 짧은 라벨.
  // claude(Max) 의 model="default" 는 OAuth 가 자동 선택하는 최신 Opus 5.7 / 1M ctx 모델.
  // 다른 provider/model 은 ID 그대로 (mono 폰트로 가독성 OK).
  const currentModelLabel = useMemo(() => {
    if (activeProvider === "claude" && (!activeModelId || activeModelId === "default")) {
      return "Opus 5.7 · 1M";
    }
    return activeModelId || "default";
  }, [activeProvider, activeModelId]);

  // 모델별 컨텍스트 윈도우 분모 — Context % 표시용.
  // - Claude Max default(Opus 5.7) : 1M
  // - Anthropic claude-* : 200K (Sonnet 4.5 등) — sonnet-4-5 도 1M 베타가 있으나 일반은 200K
  // - 기타 (OpenAI / Gemini / OpenRouter) : 200K 기본 (모델별 정확값은 Phase 13 이후)
  // Phase 35 (v0.5.23) — 모델별 정확한 context window lookup.
  // 종전 default 200K 가 GPT-5 family (실제 400K) 까지 200K 로 잡아 K 가 한 번 메시지 보내면
  // 100% 표시되는 가짜 만수 발생. 모델 ID 별로 정확한 spec 으로 분모 잡음.
  // Phase 46 (v0.5.34): 모델 ID 매칭 결과를 fallback 여부와 함께 노출 (tooltip 진단용).
  // K 보고: 다른 PC 에서 2개 질문만에 100%+ → 모델 ID 매칭 실패해서 200K fallback 가능성
  // 또는 큰 history/cache 누적의 정상 측정. tooltip 에 "fallback" 여부 표시해서 식별 가능하게.
  const currentModelMaxTokensInfo = useMemo(() => {
    const id = (activeModelId || "").toLowerCase();

    // 1M 모델 — 명시 시그널
    if (id.includes("1m")) return { tokens: 1_000_000, source: "1m 시그널" };
    if (id.includes("nano") && id.includes("gpt-5")) return { tokens: 1_000_000, source: "gpt-5-nano" };

    // Claude (Max OAuth default = Claude Opus 4.7 1M context)
    if (activeProvider === "claude" && (!activeModelId || id === "default")) {
      return { tokens: 1_000_000, source: "Claude Max default" };
    }

    // OpenAI GPT-5 family / Codex — 공식 400K input window (2025 spec)
    if (
      id.startsWith("gpt-5") ||
      id.includes("gpt-5") ||
      id.startsWith("codex") ||
      id.includes("codex-1")
    ) {
      return { tokens: 400_000, source: "GPT-5/codex 400K" };
    }

    // OpenAI O1 / O3 series — 200K
    if (id.startsWith("o1") || id.startsWith("o3")) return { tokens: 200_000, source: "O1/O3 200K" };

    // Claude 모델 (3.5, 3.7, 4 등) — 200K (1M 베타는 위에서 catch)
    if (id.includes("claude")) return { tokens: 200_000, source: "Claude 200K" };

    // Gemini — 1M+ 지만 모델별 다름. 기본 1M
    if (id.includes("gemini")) return { tokens: 1_000_000, source: "Gemini 1M" };

    // 안전 fallback ⚠ — K 의 다른 PC 가 여기 떨어지면 비정상 부풀음
    return { tokens: 200_000, source: `⚠ 매칭 실패 (model="${activeModelId || "unset"}") → 200K fallback` };
  }, [activeProvider, activeModelId]);
  const currentModelMaxTokens = currentModelMaxTokensInfo.tokens;

  // ─── Phase 15.5 — Codex usage polling ────────────────────
  // Phase 29 (v0.5.17): provider 무관 polling + fail 사유 UI 노출.
  //   - 옛 design: provider="codex" 일 때만 polling → Claude 메인이면 Codex 카드 영원히 빈 상태
  //   - 옛 design: catch 가 logger.warn 만 → K 가 다른 PC 에서 표시 안 되는 이유 디버깅 불가
  //   - 새 design: 매 5분 polling. auth.json 없음 (정상 — 미로그인) 만 silent skip,
  //     그 외 (401 만료 / 네트워크 / API 변경) 는 codexUsageError state 에 박아 UI 에 표시.
  // Anthropic 은 sidecar 가 매 turn rate_limit_event 로 자동 emit 하므로 polling 불필요.
  const pollCodexUsage = useStableCallback(async () => {
    try {
      const json = await invoke<unknown>("codex_fetch_usage");
      const info = normalizeRateLimit("codex", json, Date.now());
      if (info) {
        setRateLimitCodex(info);
        setCodexUsageError(null);
        setCodexUsageRawPayload(null);
        try { localStorage.setItem("kda_rate_limit_codex", JSON.stringify(info)); } catch {}
        logger.log(
          `[codex_usage] OK primary=${info.primary?.used_pct?.toFixed(1)}% secondary=${info.secondary?.used_pct?.toFixed(1)}%`
        );
      } else {
        // Phase 31 (v0.5.19): top-level keys 를 사유에 포함 + raw payload state 에 저장
        const topKeys =
          json && typeof json === "object" ? Object.keys(json as object).slice(0, 8).join(", ") : "(non-object)";
        const reason = `응답 schema 인식 못 함 — top-level keys: [${topKeys}]. [Raw 보기] 클릭`;
        setCodexUsageError(reason);
        setCodexUsageRawPayload(json);
        logger.warn("[codex_usage] normalize 실패 — raw:", json);
      }
    } catch (e) {
      const errStr = String(e);
      // auth.json 없음 = 정상 (Codex 미로그인) → silent
      if (errStr.includes("auth.json 없음") || errStr.includes("auth.json 안 access_token 없음")) {
        setCodexUsageError(null);
        logger.log("[codex_usage] codex 미로그인 — skip");
        return;
      }
      // 그 외 (HTTP 401 / 네트워크 / parsing) 는 UI 에 표시
      let userMsg = errStr;
      if (errStr.includes("HTTP 401")) {
        userMsg = "로그인 만료 — [Codex 로그인] 다시 필요";
      } else if (errStr.includes("HTTP 403")) {
        userMsg = "접근 거부 — Codex 정액제 가입 상태 확인 필요";
      } else if (errStr.includes("HTTP 429")) {
        userMsg = "rate limit — 잠시 후 자동 재시도";
      } else if (errStr.includes("HTTP 5") || errStr.includes("HTTP 응답") || errStr.includes("HTTP 요청 실패")) {
        userMsg = `Codex API 일시 오류: ${errStr.split(" — ")[0]}`;
      } else if (errStr.includes("응답 JSON 파싱 실패")) {
        userMsg = "Codex API 응답 형식 변경 (KDA 업데이트 필요할 수 있음)";
      }
      setCodexUsageError(userMsg);
      logger.warn("[codex_usage] fetch 실패:", errStr);
    }
  });
  useEffect(() => {
    pollCodexUsage();
    const handle = window.setInterval(pollCodexUsage, 300_000);
    return () => window.clearInterval(handle);
  }, [pollCodexUsage]);

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
        const [convs, fols] = await Promise.all([
          getAllConversations(),
          getAllFolders(),
        ]);
        setConversations(convs);
        setFolders(fols.map((f) => ({
          id: f.id,
          name: f.name,
          parentId: f.parentId,
          color: f.color,
          icon: f.icon,
          position: f.position,
          createdAt: f.createdAt,
        })));
        setDbReady(true);
        logger.log("[App] DB 초기화 완료, 대화 수:", convs.length, ", 폴더 수:", fols.length);
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

      case "rate_limit": {
        // Phase 15.5 — provider 의 5h primary + 7d secondary 한도.
        // payload 구조가 provider 마다 달라 normalize 필요. raw 도 보관 (디버깅).
        const info = normalizeRateLimit(ev.provider, ev.payload, ev.receivedAt);
        if (info) {
          if (ev.provider === "anthropic") {
            setRateLimitAnthropic(info);
            try { localStorage.setItem("kda_rate_limit_anthropic", JSON.stringify(info)); } catch {}
          } else if (ev.provider === "codex") {
            setRateLimitCodex(info);
            try { localStorage.setItem("kda_rate_limit_codex", JSON.stringify(info)); } catch {}
          }
          logger.log(`[rate_limit] ${ev.provider} primary=${info.primary?.used_pct?.toFixed(1)}% secondary=${info.secondary?.used_pct?.toFixed(1)}%`);
        } else {
          logger.warn(`[rate_limit] ${ev.provider} normalize 실패 — raw:`, ev.payload);
        }
        break;
      }

      case "assistant_delta": {
        // partial assistant 텍스트를 DB 에 incrementally 저장 — 강제 종료/재기동 시
        // 끊긴 시점까지의 응답이 휘발하지 않도록. queueMessageSave 가 300ms 디바운스라
        // 매 chunk 마다 DB write 부담은 없음 (같은 id 로 upsert).
        let savedMsg: ChatMessage | null = null;
        setMessages((prev) => {
          const existingIdx = prev.findIndex(
            (m) => m.id === ev.id && m.role === "assistant"
          );
          if (existingIdx >= 0) {
            const next = [...prev];
            const msg = next[existingIdx];
            if (msg.role === "assistant") {
              const updated = {
                ...msg,
                content: ev.text,
                streaming: true,
              };
              next[existingIdx] = updated;
              savedMsg = updated;
            }
            return next;
          }
          const created: ChatMessage = {
            id: ev.id,
            role: "assistant",
            content: ev.text,
            timestamp: Date.now(),
            streaming: true,
          };
          savedMsg = created;
          return [...prev, created];
        });
        if (savedMsg) queueMessageSave(savedMsg);
        break;
      }

      case "tool_use": {
        // 도구 호출 시점에도 즉시 DB 저장 — 도중에 끊겨도 "어떤 도구를 호출했는지" 가
        // history 에 남도록 (Resume 시 재호출 방지).
        const toolMsg: ChatMessage = {
          id: `${ev.id}-tool-${ev.tool_id}`,
          role: "tool",
          toolId: ev.tool_id,
          toolName: ev.name,
          toolInput: ev.input,
          content: "",
          status: "pending",
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, toolMsg]);
        queueMessageSave(toolMsg);
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
        // 도구 결과를 즉시 DB 저장 — 끊겨도 "이미 받은 결과" 가 history 에 실려
        // Resume 시 모델이 같은 도구 다시 호출 안 하고 이어서 답변 생성.
        let updatedToolMsg: ChatMessage | null = null;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.role === "tool" && m.id === `${ev.id}-tool-${ev.tool_id}`) {
              const next: ChatMessage = {
                ...m,
                toolOutput: ev.output,
                status: "success" as const,
              };
              updatedToolMsg = next;
              return next;
            }
            return m;
          })
        );
        if (updatedToolMsg) queueMessageSave(updatedToolMsg);
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

        // Phase 12 — Context Meter v2: turn 내 message_start 들의 최댓값.
        // sidecar 가 별도 필드로 전달. result.usage 의 누적 부풀음 회피한 정확한 윈도우 점유율.
        const maxTurn = ev.maxTurnUsage ?? null;
        const maxTurnCtxTokens = maxTurn?.total_context_tokens ?? 0;

        logger.log(
          `[Metrics] Turn IN: ${newInputTokens} (+cc:${cacheCreation} +cr:${cacheRead} = ctx:${turnContextTokens}), OUT: ${newOutputTokens}, displayCtx: ${maxTurnCtxTokens || "(none)"}`
        );

        setMetrics((m) => {
          const updatedMetrics = {
            ...m,
            turnCount: m.turnCount + 1,
            totalInputTokens: m.totalInputTokens + newInputTokens,
            totalOutputTokens: m.totalOutputTokens + newOutputTokens,
            // 마지막 턴 컨텍스트 점유량 (누적 아님, 그 턴 한 번)
            currentContextTokens: turnContextTokens > 0 ? turnContextTokens : m.currentContextTokens,
            // Phase 12 — turn 내 max(input + cc + cr). 이 값이 있으면 표시 % 의 우선 소스.
            // 0 인 turn (REST 경로 / sub-agent 없음 등) 에는 그대로 둬서 직전 값 유지.
            maxTurnContextTokens: maxTurnCtxTokens > 0 ? maxTurnCtxTokens : m.maxTurnContextTokens,
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

          // 2026-05-06: 대화 재진입 시 첫 query 전에 컨텍스트 % 를 정확히 표시하기 위해
          // 마지막 maxTurnUsage 를 conversation 별로 localStorage 에 영속.
          // (DB 스키마 변경 회피 — Phase 4 의 conversation 메트릭과 별도로 가벼운 cache)
          if (convIdForMetrics && maxTurnCtxTokens > 0 && maxTurn) {
            try {
              localStorage.setItem(
                `kda_max_ctx_${convIdForMetrics}`,
                JSON.stringify({
                  total: maxTurnCtxTokens,
                  input: maxTurn.input_tokens ?? 0,
                  cc: maxTurn.cache_creation_input_tokens ?? 0,
                  cr: maxTurn.cache_read_input_tokens ?? 0,
                  ts: Date.now(),
                }),
              );
            } catch {
              // localStorage 실패 — quota 등. 무시 (다음 turn 에 다시 시도)
            }
          }

          // 임계치 체크 — Phase 12 부터는 maxTurnContextTokens (sidecar message_start max)
          // 가 있으면 정확한 측정치라 그걸 우선 사용. 없으면 estimateConvTokens fallback.
          // 분모는 모델별 (Claude default = 1M, 그 외 = 200K) 동적 적용.
          const estimated = estimateConvTokens(messagesRef.current);
          const measured = maxTurnCtxTokens || updatedMetrics.maxTurnContextTokens || 0;
          const effectiveTokens = measured > 0
            ? measured
            : Math.max(0, estimated - refreshBaselineRef.current);
          const ctxDenominator = currentModelMaxTokens;
          const contextUsage = effectiveTokens / ctxDenominator;
          if (contextUsage >= CONTEXT_THRESHOLD && !isRefreshingSessionRef.current) {
            logger.log(`[Session] 컨텍스트 ${(contextUsage * 100).toFixed(1)}% (${effectiveTokens}/${ctxDenominator}, source=${measured > 0 ? "maxTurn" : "estimate"}) 도달 - 세션 자동 갱신 시작`);
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
        // Phase 17: --resume target 이 없어진 경우 자동 회복 — 해당 conversation 의
        // agent_id 를 클리어해 다음 메시지부터 신규 session 으로 시작.
        const errAny = ev as any;
        if (errAny.code === "resume_session_missing") {
          const convIdForErr = activeConversationIdRef.current;
          if (convIdForErr && dbReadyRef.current) {
            updateConversationAgentId(convIdForErr, null)
              .then(() => {
                setConversations((prev) =>
                  prev.map((c) =>
                    c.id === convIdForErr ? { ...c, agentId: null } : c
                  )
                );
              })
              .catch((e) =>
                console.error("[App] resume_session_missing 회복 — agentId 클리어 실패:", e),
              );
          }
          pushSystem(`⚠️ ${ev.message}`, "warn");
        } else {
          pushSystem(`Error: ${ev.message}`, "error");
        }
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

  // Phase 30 (v0.5.18): 메시지 큐 — streaming 중 K 가 Enter 치면 한 슬롯 보관.
  // streaming false 로 전환되면 useEffect 가 자동 비움. 두 번째 Enter 치면 마지막 입력으로 덮어씀.
  // Phase 34 (v0.5.22): UI 노출 + ref 동기화 + 진단 로그.
  type QueuedSend = { text: string; files?: FileAttachment[]; queuedAt: number };
  const [queuedSend, setQueuedSend] = useState<QueuedSend | null>(null);
  // Phase 34: useEffect race 진단용 ref. setQueuedSend 와 항상 동기 — flush 직전 ref 도 비움.
  const queuedSendRef = useRef<QueuedSend | null>(null);

  const handleCancelQueuedSend = useStableCallback(() => {
    logger.log("[Phase34] 큐 취소 — K 가 ✕ 클릭");
    queuedSendRef.current = null;
    setQueuedSend(null);
  });

  const handleSendMessage = useStableCallback(async (text: string, files?: FileAttachment[]) => {
    if (!text && (!files || files.length === 0)) return;
    // Phase 30: streaming 중이면 큐에 보관 후 return — useEffect 가 streaming 종료 시 자동 send
    if (isStreaming) {
      const slot: QueuedSend = { text, files, queuedAt: Date.now() };
      queuedSendRef.current = slot;
      setQueuedSend(slot);
      logger.log(`[Phase34] 큐 적재 — text 길이=${text.length}, files=${files?.length ?? 0}`);
      return;
    }

    // 새 메시지 시작 → 미완 턴 이어받기 배너는 더 이상 의미 없음
    setPendingResume(null);

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

    // 첨부 파일을 메시지 bubble 에 보존 — Message.tsx 가 미리보기 렌더링.
    // base64 는 화면 표시 (data URL) 용. preview (URL.createObjectURL) 는 Composer 가
    // unmount 되면서 revoke 될 수 있어 fallback 으로 base64 를 동시 보유.
    const messageAttachments = files?.map((f) => ({
      name: f.name,
      type: f.type,
      size: f.size,
      base64: f.base64,
      preview: f.preview,
    }));

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: displayContent,
      timestamp: Date.now(),
      attachments: messageAttachments,
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

  // Phase 46 (v0.5.34): "모두 중단" — 현재 turn 뿐 아니라 큐, 자동 세션 갱신, pending resume 까지 abort.
  // K 보고: STOP 눌러도 큐가 다음 메시지 자동 전송해서 "계속 진행" 으로 보임 → 진짜 멈추는 버튼 추가.
  const handleHardStop = useStableCallback(async () => {
    logger.log("[HardStop] 모두 중단 — turn + 큐 + 자동갱신 abort");
    // 1. 현재 turn interrupt
    if (currentTurnId) {
      try {
        await invoke("interrupt", { id: currentTurnId });
      } catch (err) {
        console.error("[HardStop] interrupt failed:", err);
      }
    }
    // 2. 큐 비우기 (다음 자동 전송 차단)
    queuedSendRef.current = null;
    setQueuedSend(null);
    // 3. 자동 세션 갱신 차단
    isRefreshingSessionRef.current = false;
    // 4. pending resume (중단된 turn 같은 질문 재시도) 차단
    setPendingResume(null);
    // 5. UI 정리
    setTimeout(() => {
      setIsStreaming(false);
      setCurrentTurnId(null);
      setMessages((prev) =>
        prev.map((m) =>
          m.role === "assistant" && (m as any).streaming
            ? { ...m, streaming: false }
            : m
        )
      );
    }, 300);
    pushSystem("🛑 모두 중단 — 진행 중 작업 + 예약 메시지 + 자동 갱신 전부 정지.", "info");
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
      // 새 대화 만들면 이전 대화의 이어받기 배너는 숨김
      setPendingResume(null);
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
    // 다른 대화로 넘어가면 이전 대화의 이어받기 배너는 숨김
    setPendingResume(null);

    // DB에서 메시지와 메트릭 로드
    try {
      const [msgs, savedMetrics] = await Promise.all([
        getMessages(id),
        getConversationMetrics(id),
      ]);
      setMessages(msgs);

      // 마지막 메시지가 user 면 → 이전 턴이 미완 (assistant 응답이 저장된 적 없음)
      // = release rebuild / 프로세스 강제 종료로 끊긴 턴. 배너로 이어받기 제안.
      const last = msgs[msgs.length - 1];
      if (last && last.role === "user") {
        setPendingResume({ convId: id, userMessage: last });
        logger.log(`[Resume] 미완 턴 감지: ${last.content.slice(0, 40)}...`);
      }

      // 2026-05-06: 마지막 maxTurnUsage 복원 — 대화 재진입 시 첫 query 전부터 정확한 % 표시.
      // localStorage 에서 conversation 별로 읽음 (done 이벤트에서 저장).
      let restoredMaxCtx = 0;
      try {
        const stored = localStorage.getItem(`kda_max_ctx_${id}`);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (typeof parsed?.total === "number" && parsed.total > 0) {
            restoredMaxCtx = parsed.total;
            logger.log(`[App] maxTurnContext 복원: ${restoredMaxCtx} (대화 ${id.slice(0, 8)})`);
          }
        }
      } catch {
        // 파싱 실패 — 무시
      }

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
          // Phase 12 — 마지막 turn 의 maxTurnContextTokens 복원 → 첫 표시부터 정확한 %.
          maxTurnContextTokens: restoredMaxCtx,
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
          maxTurnContextTokens: restoredMaxCtx,
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
        setPendingResume(null);
      }
    } catch (err) {
      console.error("[App] 대화 삭제 실패:", err);
      pushSystem("대화 삭제에 실패했습니다.", "error");
    }
  });

  // Phase 27 (v0.5.15): 대화 제목 직접 변경 (Sidebar 의 더블클릭 / ✎ 버튼)
  const handleRenameConversation = useStableCallback(async (id: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    try {
      await updateConversationTitle(id, trimmed);
      // 메모리상 conversations 즉시 업데이트 (UI 반영 빠르게)
      setConversations((prev) =>
        prev.map((c) =>
          c.id === id ? { ...c, title: trimmed, lastActive: Date.now() } : c,
        ),
      );
    } catch (err) {
      console.error("[App] 대화 제목 변경 실패:", err);
      pushSystem("대화 제목을 변경하지 못했습니다.", "error");
    }
  });

  // ─── Phase 32 (v0.5.20) — Folder Tree + DnD + Favorites + Color/Icon ───
  const refreshFolders = useStableCallback(async () => {
    try {
      const fols = await getAllFolders();
      setFolders(fols.map((f) => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        color: f.color,
        icon: f.icon,
        position: f.position,
        createdAt: f.createdAt,
      })));
    } catch (e) {
      console.error("[App] folders 로드 실패:", e);
    }
  });

  const handleCreateFolder = useStableCallback(
    async (name: string, parentId: string | null = null) => {
      try {
        const f = await createFolder(name, parentId);
        setFolders((prev) => [
          ...prev,
          {
            id: f.id,
            name: f.name,
            parentId: f.parentId,
            color: f.color,
            icon: f.icon,
            position: f.position,
            createdAt: f.createdAt,
          },
        ]);
      } catch (e) {
        console.error("[App] 폴더 생성 실패:", e);
        pushSystem("폴더를 생성하지 못했습니다.", "error");
      }
    },
  );

  const handleRenameFolder = useStableCallback(async (id: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      await renameFolder(id, trimmed);
      setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name: trimmed } : f)));
    } catch (e) {
      console.error("[App] 폴더 이름 변경 실패:", e);
      pushSystem("폴더 이름을 변경하지 못했습니다.", "error");
    }
  });

  const handleDeleteFolder = useStableCallback(
    async (id: string, mode: "moveToParent" | "deleteAll" = "moveToParent") => {
      try {
        await deleteFolder(id, mode);
        await refreshFolders();
        // 대화도 부모로 옮겨졌거나 삭제됐으니 다시 불러오기
        const convs = await getAllConversations();
        setConversations(convs);
        // 활성 대화가 삭제됐으면 초기화
        if (
          mode === "deleteAll" &&
          activeConversationId &&
          !convs.find((c) => c.id === activeConversationId)
        ) {
          setActiveConversationId(null);
          setMessages([]);
        }
      } catch (e) {
        console.error("[App] 폴더 삭제 실패:", e);
        pushSystem("폴더를 삭제하지 못했습니다.", "error");
      }
    },
  );

  const handleMoveFolder = useStableCallback(
    async (id: string, newParentId: string | null, newPosition: number) => {
      try {
        await moveFolder(id, newParentId, newPosition);
        setFolders((prev) =>
          prev.map((f) =>
            f.id === id ? { ...f, parentId: newParentId, position: newPosition } : f,
          ),
        );
      } catch (e) {
        console.error("[App] 폴더 이동 실패:", e);
        pushSystem(
          (e as Error)?.message ?? "폴더를 이동하지 못했습니다.",
          "error",
        );
      }
    },
  );

  const handleSetFolderColor = useStableCallback(async (id: string, color: string | null) => {
    try {
      await setFolderColor(id, color);
      setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, color } : f)));
    } catch (e) {
      console.error("[App] 폴더 색상 변경 실패:", e);
    }
  });

  const handleSetFolderIcon = useStableCallback(async (id: string, icon: string | null) => {
    try {
      await setFolderIcon(id, icon);
      setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, icon } : f)));
    } catch (e) {
      console.error("[App] 폴더 아이콘 변경 실패:", e);
    }
  });

  const handleMoveConversationToFolder = useStableCallback(
    async (convId: string, folderId: string | null, position: number = 0) => {
      try {
        await moveConversationToFolder(convId, folderId, position);
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? { ...c, folderId, position } : c)),
        );
      } catch (e) {
        console.error("[App] 대화 이동 실패:", e);
        pushSystem("대화를 이동하지 못했습니다.", "error");
      }
    },
  );

  const handleToggleFavorite = useStableCallback(async (id: string) => {
    try {
      const next = await toggleConversationFavorite(id);
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, isFavorite: next } : c)),
      );
    } catch (e) {
      console.error("[App] 즐겨찾기 토글 실패:", e);
    }
  });

  const handleSetConversationColor = useStableCallback(
    async (id: string, color: string | null) => {
      try {
        await setConversationColor(id, color);
        setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, color } : c)));
      } catch (e) {
        console.error("[App] 대화 색상 변경 실패:", e);
      }
    },
  );

  const handleSetConversationIcon = useStableCallback(
    async (id: string, icon: string | null) => {
      try {
        await setConversationIcon(id, icon);
        setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, icon } : c)));
      } catch (e) {
        console.error("[App] 대화 아이콘 변경 실패:", e);
      }
    },
  );

  const handleSearchConversations = useStableCallback(
    async (query: string): Promise<Set<string>> => {
      try {
        return await searchConversations(query);
      } catch (e) {
        console.error("[App] 대화 검색 실패:", e);
        return new Set<string>();
      }
    },
  );

  // ─── Phase 30 (v0.5.18) / Phase 34 (v0.5.22) — 메시지 큐 자동 비우기 ───────────────
  // streaming false 로 전환되는 순간 큐에 보관된 메시지 하나를 자동 send.
  // K 가 답변 받는 동안 Enter 친 것이 있으면 답변 끝난 직후 즉시 다음 turn 시작.
  // Phase 34: ref 동기화 + 진단 로그 + 빈 시점 robustness (state vs ref 불일치 발견 시 ref 우선).
  useEffect(() => {
    logger.log(
      `[Phase34] flush effect fire — isStreaming=${isStreaming}, queuedSend=${queuedSend ? `len=${queuedSend.text.length}` : "null"}, ref=${queuedSendRef.current ? "set" : "null"}`,
    );
    if (isStreaming) return;
    // state 와 ref 둘 다 확인 — 어느 한쪽만 set 이라면 그게 진짜 큐
    const next = queuedSend ?? queuedSendRef.current;
    if (!next) return;
    logger.log(`[Phase34] flush 시작 — text 첫50자="${next.text.slice(0, 50)}"`);
    queuedSendRef.current = null;
    setQueuedSend(null);
    // setTimeout(0) — setState batch 끝난 후 send (race 방어)
    const t = window.setTimeout(() => {
      logger.log(`[Phase34] flush 실행 — handleSendMessage 호출`);
      void handleSendMessage(next.text, next.files);
    }, 0);
    return () => window.clearTimeout(t);
  }, [isStreaming, queuedSend, handleSendMessage]);

  // ─── 중단된 턴 같은 질문 재시도 ─────────────────────────────────
  // pendingResume.userMessage 텍스트를 그대로 재전송. user 메시지는 이미 DB/UI 에 있으니
  // 새로 추가하지 않고, history 에서도 마지막 user 만 제외하고 보낸다 (sidecar 가 current_message
  // 로 따로 받기 때문). agentId 는 마지막 완료된 턴의 것 (--resume) 또는 null (신규).
  // 끊겼던 턴의 partial assistant text + tool 호출은 streaming 중 incrementally DB 에 저장돼 있어
  // history 에 같이 실리므로 모델이 "이미 한 일" 을 인지한다 (Step 2).
  const handleResumeInterrupted = useStableCallback(async () => {
    if (!pendingResume) return;
    if (isStreaming) return;
    const { convId, userMessage } = pendingResume;
    if (convId !== activeConversationIdRef.current) {
      // 사용자가 다른 대화로 옮겨갔으면 무시
      setPendingResume(null);
      return;
    }

    // 배너 닫기 (재시도 클릭은 한 번만)
    setPendingResume(null);

    const turnId = crypto.randomUUID();
    setCurrentTurnId(turnId);
    setIsStreaming(true);

    try {
      // resume agentId — 마지막 완료된 턴의 것 (DB 에 저장됨). 없으면 신규 세션.
      let agentId: string | undefined;
      if (dbReady) {
        const existingAgentId = await getConversationAgentId(convId);
        if (existingAgentId) agentId = existingAgentId;
      }

      // history — 마지막 user 메시지(=재전송 대상) 빼고 직전 30개. tool 메시지도 포함.
      // 마지막이 userMessage 와 일치하지 않을 수도 있으니 id 로도 확인.
      // tool 메시지를 같이 보내야 모델이 "끊기 전에 이미 호출한 도구와 결과" 를 인지하고
      // 같은 도구 중복 호출을 회피한다 (Step 2 핵심).
      // 단, base64 출력 / 거대 파일 결과로 컨텍스트 폭발하는 걸 막기 위해 sidecar 의
      // summarizeToolItem 이 toolInput 800자 / toolOutput 1500자로 절단.
      const allMessages = messagesRef.current;
      const trimmed = allMessages[allMessages.length - 1]?.id === userMessage.id
        ? allMessages.slice(0, -1)
        : allMessages;
      const history = trimmed
        .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
        .slice(-30)
        .map((m) => {
          if (m.role === "tool") {
            return {
              role: "tool" as const,
              toolName: m.toolName,
              toolInput: m.toolInput,
              toolOutput: m.toolOutput,
            };
          }
          return { role: m.role, content: m.content };
        });

      // provider / model / API key — handleSendMessage 와 동일 로직
      let provider: string | undefined;
      let model: string | undefined;
      let apiKey: string | undefined;
      try {
        provider = localStorage.getItem("kda_active_provider") || "claude";
        model = localStorage.getItem("kda_active_model") || undefined;
        if (provider !== "claude") {
          const storedKeys = localStorage.getItem("kda_api_keys");
          if (storedKeys) {
            const keys = JSON.parse(storedKeys);
            apiKey = keys[provider];
          }
        }
      } catch (e) {
        console.warn("[Resume] provider/model 로드 실패:", e);
        provider = "claude";
      }

      // permissions / lockedTools — handleSendMessage 와 동일
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
        console.warn("[Resume] permissions 로드 실패:", e);
      }

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
        console.warn("[Resume] lockedTools 로드 실패:", e);
      }

      pushSystem("↻ 같은 질문 재시도 중... (이전 도구 결과를 컨텍스트에 포함)", "info");
      logger.log(`[Resume] 재전송: turnId=${turnId}, agentId=${agentId ?? "(신규)"}`);

      await invoke("send_message", {
        message: userMessage.content,
        id: turnId,
        agentId,
        history: history.length > 0 ? history : undefined,
        // 첨부파일은 DB 에 base64 저장 안 함 → 재기동 후 복원 불가 (텍스트만 재전송)
        attachments: undefined,
        apiKey,
        provider,
        model,
        permissions,
        lockedTools,
      });
    } catch (err) {
      setIsStreaming(false);
      setCurrentTurnId(null);
      pushSystem(`재시도 실패: ${String(err)}`, "error");
    }
  });

  const handleDismissResume = useStableCallback(() => {
    setPendingResume(null);
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
  // Phase 44 (v0.5.32): toast 메시지 동적 % + source — hardcode "80% 도달" 이 K 에게 오해 부름.
  // 실제 트리거는 CONTEXT_THRESHOLD (현재 90%) 이지만 메시지는 80% 라 적혀있었음.
  const triggerSessionRefresh = useStableCallback(async () => {
    logger.log("[Session] 세션 갱신 시작...");

    const convId = activeConversationIdRef.current;
    if (!convId) {
      isRefreshingSessionRef.current = false;
      return;
    }

    // 갱신 시점의 실제 컨텍스트 % + source 캡처 — toast 에 정확히 표시
    const refreshContextSnapshot = (() => {
      const measured = metrics.maxTurnContextTokens ?? 0;
      const estimated = estimateConvTokens(messagesRef.current);
      const effective = measured > 0 ? measured : Math.max(0, estimated - refreshBaselineRef.current);
      const pct = currentModelMaxTokens > 0 ? (effective / currentModelMaxTokens) * 100 : 0;
      return {
        pct: Math.round(pct),
        source: measured > 0 ? "실측" : "추정",
        tokens: effective,
        max: currentModelMaxTokens,
      };
    })();

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

      // 5. 시스템 메시지로 알림 — Phase 44: 실제 % + source 명시 (toast 도 동일 메시지 base 로)
      const pctMsg = `${refreshContextSnapshot.pct}% (${refreshContextSnapshot.source})`;
      pushSystem(
        `🔄 세션 갱신됨 (${pctMsg} 도달). 대화 맥락 유지됩니다.`,
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
      {/* Phase 38 (v0.5.26) — 사이드바 폭 조절 handle. Sidebar 우측 가장자리, drag 로 200~600px */}
      <SidebarResizer width={sidebarWidth} onChange={setSidebarWidth} />

      <Sidebar
        conversations={conversations}
        folders={folders}
        activeConversationId={activeConversationId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onDeleteConversation={handleDeleteConversation}
        onRenameConversation={handleRenameConversation}
        onRefreshConversations={refreshConversations}
        // Phase 32 — folder tree
        onCreateFolder={handleCreateFolder}
        onRenameFolder={handleRenameFolder}
        onDeleteFolder={handleDeleteFolder}
        onMoveFolder={handleMoveFolder}
        onSetFolderColor={handleSetFolderColor}
        onSetFolderIcon={handleSetFolderIcon}
        onMoveConversationToFolder={handleMoveConversationToFolder}
        onToggleFavorite={handleToggleFavorite}
        onSetConversationColor={handleSetConversationColor}
        onSetConversationIcon={handleSetConversationIcon}
        onSearchConversations={handleSearchConversations}
        onRefreshFolders={refreshFolders}
        mcpConnected={mcpState.connected}
        onOpenSettings={openSettings}
      />

      <MainChat
        messages={messages}
        status={status}
        isStreaming={isStreaming}
        onSendMessage={handleSendMessage}
        onInterrupt={handleInterrupt}
        onHardStop={handleHardStop}
        // Phase 34 (v0.5.22) — 큐 미리보기 + 취소
        queuedSend={
          queuedSend
            ? { text: queuedSend.text, fileCount: queuedSend.files?.length ?? 0, queuedAt: queuedSend.queuedAt }
            : null
        }
        onCancelQueuedSend={handleCancelQueuedSend}
        // Phase 44 (v0.5.32) — link/file click → SidePanel
        onPreviewRequest={handlePreviewRequest}
      />

      <MetricsPanel
        metrics={metrics}
        mcpConnected={mcpState.connected}
        currentModel={currentModelLabel}
        maxContextTokens={currentModelMaxTokens}
        maxContextSource={currentModelMaxTokensInfo.source}
        estimatedContextTokens={estimatedContextTokens}
        onManualRefresh={triggerSessionRefresh}
        onCompressContext={handleCompressContext}
        isCompressing={isCompressing}
        rateLimit={
          activeProvider === "codex"
            ? rateLimitCodex
            : activeProvider === "claude"
              ? rateLimitAnthropic
              : null
        }
        codexUsageError={activeProvider === "codex" ? codexUsageError : null}
        codexUsageRawPayload={activeProvider === "codex" ? codexUsageRawPayload : null}
        onRetryCodexUsage={pollCodexUsage}
      />

      {/* Phase 44 (v0.5.32) — 우측 SidePanel (대화 안 link/file → 미리보기) */}
      <SidePanel
        open={sidePanelOpen}
        onOpenChange={setSidePanelOpen}
        item={sidePanelItem}
        onClose={handleSidePanelClose}
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

      {/* 중단된 턴 같은 질문 재시도 배너 — 재기동/강제종료로 assistant 응답 못 받은 user 메시지 감지 시 */}
      {pendingResume && !isStreaming && (
        <div className="resume-banner" role="alert">
          <div className="resume-banner-icon">↻</div>
          <div className="resume-banner-body">
            <div className="resume-banner-title">이전 응답이 중단되었습니다</div>
            <div className="resume-banner-preview">
              {pendingResume.userMessage.content.length > 120
                ? pendingResume.userMessage.content.slice(0, 120) + "…"
                : pendingResume.userMessage.content}
            </div>
          </div>
          <div className="resume-banner-actions">
            <button
              className="resume-btn-primary"
              onClick={handleResumeInterrupted}
              title="같은 질문으로 다시 요청합니다. 끊기 전 partial 응답/도구 결과는 컨텍스트에 포함됩니다 (1턴 토큰 재소모)"
            >
              ↻ 같은 질문 재시도
            </button>
            <button
              className="resume-btn-dismiss"
              onClick={handleDismissResume}
              title="배너 닫기 (대화 자체는 보존됩니다)"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
