// ═══════════════════════════════════════════════════════════════
// 공유 타입 정의
// ═══════════════════════════════════════════════════════════════

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface BaseMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
}

export interface UserMessage extends BaseMessage {
  role: "user";
  // 사용자가 첨부한 파일 — 메시지 bubble 에 미리보기 렌더링용.
  // base64 는 화면 표시 (data URL) 용으로 보유. 큰 파일은 메모리 부담 — 50MB 제한이 Composer 에 있음.
  // 대화 DB 에는 저장 안 함 (resume 시 첨부는 복원 X — sidecar/index.ts 의 attachments=undefined 정책과 일치).
  attachments?: Array<{
    name: string;
    type: string;
    size: number;
    base64?: string;
    preview?: string;
  }>;
}

export interface AssistantMessage extends BaseMessage {
  role: "assistant";
  streaming?: boolean;
}

export interface SystemMessage extends BaseMessage {
  role: "system";
  level?: "info" | "warn" | "error";
}

export interface ToolMessage extends BaseMessage {
  role: "tool";
  toolId: string;
  toolName: string;
  toolInput?: unknown;
  toolOutput?: string;
  // Phase 98 — MCP 도구가 반환한 image content (base64 data URL 배열).
  // sidecar 가 tool_result block 의 image part 를 분리해 emit. ToolMessageView 가
  // 썸네일 그리드로 렌더링. 이전엔 normalizeToolOutput 이 JSON.stringify 로 덤프해
  // K 화면에 거대한 base64 문자열만 보였음.
  images?: string[];
  status: "pending" | "success" | "error";
  // Phase 85 (v0.6.28) — Connector/Tool Safety Layer 의 후속.
  // sidecar 가 tool_use emit 시 함께 박은 위험도 메타. 없으면 sidecar 가 분류 못 한 도구.
  risk?: {
    level: "low" | "medium" | "high" | "critical";
    categoryId: string | null;
    summary: string;
  };
}

export type ChatMessage =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ToolMessage;

// ─── Sidecar 이벤트 (Rust → Frontend) ─────────────────────────

export type SidecarEvent =
  | { type: "ready"; version: string }
  | { type: "assistant_delta"; id: string; text: string }
  | {
      type: "tool_use";
      id: string;
      tool_id: string;
      name: string;
      input: unknown;
      // Phase 85 (v0.6.28) — sidecar 가 toolSafety 로 분류한 위험도. UI 에서 배지 표시 + 강조.
      risk?: {
        level: "low" | "medium" | "high" | "critical";
        categoryId: string | null;
        summary: string;
      };
    }
  | { type: "tool_result"; id: string; tool_id: string; output: string; images?: string[] }
  | { type: "done"; id: string; usage?: TokenUsage | null; computed_usage?: TokenUsage | null; maxTurnUsage?: MaxTurnUsage | null; agentId?: string | null }
  | { type: "error"; id?: string; message: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "pong" }
  | {
      type: "mcp_status";
      connected: boolean;
      server: string;
      error?: string;
      details?: {
        path?: string;
        pathExists?: boolean;
        pythonAvailable?: boolean;
      };
    }
  | {
      // Phase 67a (v0.6.2) — list_mcp_tools 응답.
      // Settings 의 "MCP 도구" 탭이 받아 카드 list 렌더. tools 비어 있으면 빈 상태 표시.
      //
      // Phase 68 (v0.6.12) — Settings 가 mount 전이라도 sidecar 가 ping 시점에 자발적
      // emit (cause=auto). + serverName/serverVersion 박아 UI tooltip 의 source 표시.
      // cause: "request" (list_mcp_tools handler), "auto" (ping 시점 자발적).
      type: "mcp_tools";
      server: string;
      tools: Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }>;
      error?: string;
      serverName?: string;
      serverVersion?: string;
      cause?: "request" | "auto";
    }
  | {
      type: "elicitation_request";
      id: string;
      turn_id: string;
      tool_name: string;
      tool_input: unknown;
      title: string;
      message: string;
      severity: "info" | "warn" | "danger";
      confirm_label: string;
      cancel_label: string;
    }
  | {
      // Phase 85 (v0.6.28) — Tool Safety Layer 가시성. SafeMode 가 balanced/strict 일 때
      // high/critical 도구가 dispatch 되는 시점에 sidecar 가 자발적 emit.
      // App.tsx 가 채팅에 visible system message 로 박아 K 에게 "이 도구가 돌았다" 즉시 인식.
      // CLI 모드에선 진정한 blocking 은 아직 불가 — 다음 phase 후보.
      type: "safety_alert";
      id: string;
      tool_name: string;
      source: string;
      level: "high" | "critical";
      category_id: string | null;
      summary: string;
      safe_mode: "balanced" | "strict";
    }
  | {
      // Phase 87 (v0.6.30) — Git Memory Sync 결과 알림.
      // kind="ok" / "error" / "conflict". conflict 시 conflicted_files 있음 →
      // Settings UI 가 ElicitationDialog 로 K 결정 받음 ("local" 또는 "remote" keep).
      // Phase 89 (v0.6.31) — target: "personal" | "team" 으로 어느 SyncTarget 인지 표시.
      type: "git_sync_event";
      kind: "ok" | "error" | "conflict";
      message: string;
      reason: "startup" | "interval" | "manual";
      action?: string;
      conflicted_files?: string[];
      target?: "personal" | "team";
    }
  | {
      // Phase 91 (v0.6.33) — Memory Sync commit history viewer 응답.
      type: "git_sync_log_response";
      target: "personal" | "team";
      ok: boolean;
      message: string;
      commits: Array<{
        hash: string;
        date: string;
        author: string;
        subject: string;
      }>;
    }
  | {
      // Phase 90 (v0.6.32) — SafeMode 주간 통계.
      // Settings 의 "🛡️ SafeMode 주간 통계" 카드가 listen 해서 표시.
      type: "safety_stats_response";
      total_alerts: number;
      total_blocks: number;
      last7_alerts: number;
      last7_blocks: number;
      by_mode: { off: number; balanced: number; strict: number };
      buckets: Array<{
        date: string;
        alerts: number;
        blocks: number;
        byMode: { off: number; balanced: number; strict: number };
        // Phase 91 (v0.6.33) — 도구별 alert 분포 (UI mini chart 클릭 시 펼침)
        byTool?: Record<string, number>;
      }>;
      since_at: number;
      last_updated_at: number;
    }
  | {
      // Phase 87 — git_sync_status_request 의 응답.
      // Phase 89 — personal + team 둘 다 상태 박힘.
      type: "git_sync_status";
      git_installed: boolean;
      git_version: string | null;
      // Personal
      initialized: boolean;
      has_remote: boolean;
      local_changes: number;
      branch: string | null;
      // Phase 89 — Team (선택, teamRepoUrl 미설정이면 전부 false/0/null)
      team_initialized: boolean;
      team_has_remote: boolean;
      team_local_changes: number;
      team_branch: string | null;
      last_sync_at: number;
      last_sync_status: string;
      enabled: boolean;
      repo_url: string;
      team_repo_url: string;
    }
  | {
      // Phase 52 (v0.5.40) — Codex 런타임이 token_count event 의 model_context_window 로
      // 실제 model 한도를 보고함. K-Desktop-Agent 의 hardcode lookup (gpt-5* → 400K) 과 어긋나는
      // 케이스 (예: gpt-5.5 실제 보고 258400) 가 있어 % 가 모델 실제 한도와 안 맞음. frontend 가
      // 이걸 받으면 currentModelMaxTokens 를 동적으로 override.
      type: "model_context_window";
      provider: "claude" | "codex" | string;
      contextWindow: number;
      source: string;            // "codex token_count" / "claude rate_limit" 등 — UI tooltip 에 표시
    }
  | {
      // Phase 79 (v0.6.22) — Task State Manager. sidecar 가 long-running 작업 (Codex spawn,
      // 큰 tool call 등) lifecycle 을 emit → App.tsx 가 long_tasks DB 테이블 갱신. KDA 재시작
      // / OS reboot / sidecar crash 시 RecoveryBanner 가 끊긴 작업 알림 → 작업 중단 ≠ 끊김.
      type: "long_task_started";
      taskId: string;
      kind: string;              // "codex" | "claude" | "tool_call" 등
      title?: string;
      manifest?: Record<string, unknown> | null;
    }
  | {
      type: "long_task_evidence";
      taskId: string;
      manifest?: Record<string, unknown> | null;
    }
  | {
      type: "long_task_done";
      taskId: string;
      status: "completed" | "failed" | "abandoned";
      handoffMd?: string | null;
    }
  | {
      // Phase 83 (v0.6.26) — Session Recovery Hook. sidecar 의 Codex reconnect path 에서
      // 5/5 timeout 또는 partial (2-4/5) 감지 시 emit. App.tsx 가 받아서 RecoveryBanner 즉시
      // 재스캔 + K 에게 알림 — 끊긴 작업이 작업 중단으로 이어지지 않게.
      type: "session_recovery_triggered";
      reason: "codex_reconnect_5_5" | "codex_reconnect_partial" | string;
      agentId?: string | null;
      taskId?: string | null;
    }
  | {
      // Phase 50 — 모델이 AskUserQuestion tool 호출 시 sidecar 가 가로채서 KDA UI 로 라우팅.
      // questions[].options 가 라디오/방향키 선택 가능한 옵션 리스트로 띄워짐.
      type: "ask_user_question";
      id: string;            // turn id (msg.id)
      tool_use_id: string;   // Anthropic 의 tool_use.id (재추적용)
      // Phase 95 (v0.6.37) — App.tsx 가 ToolMessage 를 즉시 박을 수 있도록 sidecar 가 명시.
      // 이전엔 별도 tool_use event 가 박는 ToolMessage 의 id 와 patchAskToolMessageOutput 의
      // targetId 가 race / mismatch 로 7회 모두 fail (sidecar.log 확인) → text-prefix fallback 만
      // 동작. 이제 명시 전달로 race window 0.
      tool_msg_id?: string;  // `${id}-tool-${tool_use_id}` 형식
      questions: Array<{
        question: string;
        header: string;
        multiSelect?: boolean;
        options: Array<{
          label: string;
          description: string;
        }>;
      }>;
    }
  | {
      // Phase 15.5 — provider 의 5h/주간 한도 정보 (rate_limit_event 또는 polling 결과)
      type: "rate_limit";
      provider: "anthropic" | "codex";
      payload: unknown;       // 첫 빌드 검증용 — 실제 필드 확인 후 RateLimitInfo 로 정형화
      receivedAt: number;     // epoch ms — 클라이언트가 reset countdown 계산할 때 기준
    };

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Phase 12 — Context Meter v2.
 *
 * 한 turn 안에서 sub-agent / iterative tool 호출로 model call 이 N번 일어나는 경우,
 * 각 호출 시점의 SSE message_start usage 의 최댓값. result.usage 의 누적 합산이
 * 1M~4M 까지 부풀어 윈도우 점유율로 부적절했던 문제의 직접 해결책.
 *
 * total_context_tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * 의 turn 내 최댓값. "그 turn 의 가장 큰 단일 model call 이 본 컨텍스트 크기".
 */
export interface MaxTurnUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_context_tokens: number;
}

// ─── 세션 상태 ───────────────────────────────────────────────

export interface SessionMetrics {
  totalInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
  toolCallCount: number;
  startedAt: number;
  // 마지막 턴에서 모델이 본 전체 컨텍스트 (input + cache_creation + cache_read).
  // 누적 totalInputTokens 와 달리 "현재 컨텍스트 윈도우 점유율" 의미.
  // 주의: result.usage 기반이라 sub-agent / iterative tool 호출이 있으면 누적 합산되어
  // 1M~4M 까지 부풀 수 있음 (billing 용 raw 측정치). 윈도우 점유율 표시는 maxTurnContextTokens
  // 를 우선 사용하고 이 값은 raw 비교용으로만 노출.
  currentContextTokens?: number;
  // Phase 12 — Context Meter v2.
  // turn 안 message_start 들의 (input + cc + cr) 최댓값. sub-agent 누적 부풀음 회피한,
  // 윈도우 점유율의 정확한 측정치. 미수신 turn 에는 undefined → estimate 로 fallback.
  maxTurnContextTokens?: number;
}

export interface Conversation {
  id: string;
  title: string;
  lastActive: number;
  messageCount: number;
  agentId?: string | null;  // Claude Agent SDK resume용
  // 대화별 메트릭 (컨텍스트 추적용)
  totalInputTokens?: number;
  totalOutputTokens?: number;
  turnCount?: number;
  toolCallCount?: number;
  // Phase 32 — 폴더 트리 + 즐겨찾기 + 색상/아이콘
  folderId?: string | null;
  position?: number;
  isFavorite?: boolean;
  color?: string | null;
  icon?: string | null;
}

// Phase 32 — 폴더 (N단계 중첩 가능)
// Phase 107 (v0.6.56) — 폴더별 프로젝트 지침 + 첨부 reference 추가.
//   systemPrompt: 새 대화 첫 message 송신 시 sidecar 가 시스템 프롬프트에 prepend.
//   attachments: 새 대화 첫 message 송신 시 자동 attach. msg.attachments 와 동일 schema.
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  color?: string | null;
  icon?: string | null;
  position: number;
  createdAt: number;
  systemPrompt?: string | null;
  attachments?: FolderAttachment[];
}

// Phase 107 — 폴더에 등록된 참고 파일 reference.
// path 는 K PC 의 절대 경로 — sidecar 가 첫 message 송신 시 읽어서 흡수.
// 폴더 자체에 파일을 복사하지 않고 reference 만 보관 (K 가 옮기면 깨질 수 있다는 trade-off,
// 다음 phase 후보: vault 폴더에 자동 사본 보관).
export interface FolderAttachment {
  name: string;
  path: string;
  size?: number;
  mimeType?: string;
  addedAt: number;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

// ─── Rate Limit Info (Phase 15.5) ────────────────────────────
// Anthropic Max 의 rate_limit_event SSE payload + Codex 의 /backend-api/codex/usage
// 응답을 정규화한 형태. provider 마다 raw 페이로드 구조가 다르므로 sidecar/App 에서
// 한 번 normalize 한 뒤 이 타입으로 저장 → MetricsPanel 이 이걸 읽음.
//
// 두 provider 다 동일한 5h primary + 7d (weekly) secondary 시스템.
//   - used_pct: 0~100 (사용률 백분율). 100 도달 시 한도 초과 → 다음 reset 까지 대기.
//   - reset_at: epoch ms. 이 시점이 지나면 윈도우가 reset.
//   - 둘 중 하나만 데이터 있을 수 있음 (예: 첫 turn 직후엔 secondary 정보 없을 수도).
export interface RateLimitWindow {
  // used_pct 가 undefined = 한도 자체를 모름 (Anthropic 이 정액 구독자한텐 한도 % 안 공개).
  // ccusage path 에서 자주 발생 — 그 때 UI 는 time_pct (시간 진행률) 또는 used_tokens 만 표시.
  used_pct?: number;
  reset_at: number;
  // 가능하면 raw 토큰/메시지 카운트도 표시 — provider 가 노출하면 채움.
  used_tokens?: number;
  limit_tokens?: number;
  // Phase 15.5 — 시간 진행률 (block 시작 ~ 끝 사이 현재 위치, 0~100).
  // ccusage path 에서 used_pct 못 받을 때 fallback bar 로 표시. 한도 % 의미는 아님.
  time_pct?: number;
  // burn rate (분당 토큰) — 툴팁에 "이 페이스면 X분 후 한도" 표시용
  burn_rate_per_min?: number;
  // ccusage projection.remainingMinutes — 현재 burn rate 로 한도 도달까지 남은 분.
  // block 의 남은 시간보다 작으면 한도 위험.
  projection_remaining_min?: number;
}

export interface RateLimitInfo {
  provider: "anthropic" | "codex";
  primary?: RateLimitWindow;    // 5시간 윈도우 (또는 hourly)
  secondary?: RateLimitWindow;  // 7일 (주간) 윈도우
  receivedAt: number;
  rawPayload?: unknown;          // 디버깅/검증용 — 첫 빌드 후 필드 확정되면 제거 가능
}

// ─── Provider (Phase 15) ─────────────────────────────────────
// 채팅에 사용되는 LLM provider 식별자. sidecar/src/index.ts 의 provider 분기와 동기화.
//   - "claude"     : Claude Code CLI (Max OAuth) — 기본
//   - "anthropic"  : Anthropic API (REST 직접)
//   - "openai"     : OpenAI API (REST 직접)
//   - "gemini"     : Google Gemini API
//   - "openrouter" : OpenRouter (멀티 모델 라우팅)
//   - "codex"      : OpenAI Codex CLI (ChatGPT Plus/Pro OAuth) — `codex exec --json` spawn
export type ProviderId = "claude" | "anthropic" | "openai" | "gemini" | "openrouter" | "codex";

export interface MCPState {
  connected: boolean;
  server: string;
  error?: string;
}

// ─── 파일 첨부 ───────────────────────────────────────────────

export interface FileAttachment {
  id: string;
  name: string;
  type: string;        // MIME type (image/png, application/zip, etc.)
  size: number;        // bytes
  path?: string;       // 로컬 경로 (Tauri용)
  base64?: string;     // base64 인코딩 데이터
  preview?: string;    // 이미지 미리보기 URL
}

export type SupportedFileType =
  | "image"            // png, jpg, gif, webp, svg
  | "document"         // pdf, doc, docx, txt, md
  | "archive"          // zip, rar, 7z, tar, gz
  | "code"             // js, ts, py, java, etc.
  | "data"             // json, xml, csv, yaml
  | "other";

// ─── Prompts (템플릿) ─────────────────────────────────────────

export interface PromptTemplate {
  id: string;
  name: string;           // 표시 이름
  description: string;    // 설명
  command: string;        // 슬래시 커맨드 (예: cleanup-downloads)
  template: string;       // 실제 프롬프트 내용
  icon?: string;          // 이모지 아이콘
  category?: string;      // 카테고리 (files, system, productivity 등)
}

// ─── Elicitation (확인 UI) ────────────────────────────────────

export type ElicitationType = "confirm" | "choice" | "input" | "preview";

export interface ElicitationOption {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  danger?: boolean;       // 위험한 옵션 (빨간색 강조)
}

export interface ElicitationRequest {
  id: string;
  type: ElicitationType;
  title: string;
  message: string;
  icon?: string;          // 이모지 아이콘
  severity?: "info" | "warn" | "danger";

  // confirm 타입
  confirmLabel?: string;
  cancelLabel?: string;

  // choice 타입
  options?: ElicitationOption[];

  // input 타입
  inputPlaceholder?: string;
  inputDefault?: string;

  // preview 타입 (파일 목록, 변경 사항 등 미리보기)
  previewItems?: string[];
  previewType?: "files" | "changes" | "list";
}

export interface ElicitationResponse {
  id: string;
  confirmed: boolean;
  selectedOption?: string;  // choice 타입에서 선택된 옵션 ID
  inputValue?: string;      // input 타입에서 입력된 값
}

// ─── Resources (파일 시스템 감시) ──────────────────────────────

export interface WatchedFolder {
  path: string;
  recursive: boolean;
  enabled: boolean;
}

export interface FileChangeEvent {
  kind: "create" | "modify" | "remove" | "rename";
  paths: string[];
  timestamp: number;
}
