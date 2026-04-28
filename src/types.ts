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
  status: "pending" | "success" | "error";
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
    }
  | { type: "tool_result"; id: string; tool_id: string; output: string }
  | { type: "done"; id: string; usage?: TokenUsage | null; computed_usage?: TokenUsage | null; agentId?: string | null }
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
    };

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ─── 세션 상태 ───────────────────────────────────────────────

export interface SessionMetrics {
  totalInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
  toolCallCount: number;
  startedAt: number;
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
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

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
