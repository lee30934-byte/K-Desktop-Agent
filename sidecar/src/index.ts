/**
 * K Desktop Agent — Node Sidecar (Phase 3: K-Personal MCP 통합)
 *
 * Rust ↔ Sidecar 프로토콜은 Phase 1과 동일.
 * 변경점: mcpServers 설정에 K-Personal 추가, MCP 헬스 체크 및 mcp_status 이벤트.
 */

import process from "node:process";
import readline from "node:readline";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";

// ─── 설정 ─────────────────────────────────────────────

/**
 * K-Personal MCP 서버 경로.
 * 환경변수 K_PERSONAL_MCP_PATH 가 있으면 그걸 사용, 없으면 기본값.
 */
const K_PERSONAL_PATH =
  process.env.K_PERSONAL_MCP_PATH ??
  "C:/Users/user/Documents/K-Personal-MCP/server.py";

/**
 * Python 실행 파일. 환경변수 PYTHON_EXE 로 덮어쓸 수 있음.
 * Windows에선 python.exe가 PATH에 있으면 그냥 "python"으로 찾아짐.
 */
const PYTHON_EXE = process.env.PYTHON_EXE ?? "python";

const SYSTEM_PROMPT = `당신은 K님의 개인 Windows 컴퓨터를 자동화하는 조수입니다.

[원칙]
- K님이 한국어로 자연스럽게 명령하면, 적절한 도구를 선택해 실행하고 결과를 간결히 보고합니다.
- 불확실하면 먼저 질문합니다.
- 파괴적인 작업(파일 삭제, 덮어쓰기, 이동)은 반드시 dry_run 모드나 확인 질문으로 먼저 시뮬레이션합니다.
- 한 번에 여러 도구를 병렬로 호출할 수 있으면 그렇게 합니다.

[사용 가능한 도구 (k-personal MCP)]
- 화면: 스크린샷(전체/영역), 마우스 클릭/드래그/이동, 키보드 타이핑/단축키
- 창: 실행 중 창 목록, 특정 창 활성화, 화면 크기
- 파일: 폴더 탐색, 검색, 최근 수정 파일, 이동/복사, 확장자별 자동 정리
- 앱: 실행/종료, URL 열기, 별명 등록한 앱 실행, 프리셋 실행
- 클립보드: 읽기/쓰기/붙여넣기, 스니펫 관리
- 개인 DB: 할 일 CRUD, 메모, 습관 체크

[출력 스타일]
- 한국어로, 간결하게.
- 도구 결과가 길면 핵심만 요약.
- 에러가 나면 그대로 보고하고 해결책 제안.

[이전 대화 컨텍스트]
사용자 메시지에 <prior_conversation>...</prior_conversation> 블록이 있으면 그건 지금 진행 중인 대화의 과거 턴 기록입니다. 이를 참고해서 자연스럽게 이어서 답하세요. 실제로 처리해야 할 새 질문은 <current_message>...</current_message> 블록 안에 있습니다. 블록 태그 자체는 사용자에게 언급하지 마세요.`;

// ─── MCP 설정 및 헬스체크 ──────────────────────────────

interface MCPStatus {
  configured: boolean;
  serverPathExists: boolean;
  pythonAvailable: boolean;
  error?: string;
}

function checkMCPHealth(): MCPStatus {
  const serverPathExists = existsSync(K_PERSONAL_PATH);

  let pythonAvailable = false;
  try {
    const result = spawnSync(PYTHON_EXE, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      shell: true, // Windows에서 python.bat 등도 잡히게
    });
    pythonAvailable = result.status === 0;
  } catch {
    pythonAvailable = false;
  }

  return {
    configured: serverPathExists && pythonAvailable,
    serverPathExists,
    pythonAvailable,
    error: !serverPathExists
      ? `K-Personal 서버 없음: ${K_PERSONAL_PATH}`
      : !pythonAvailable
        ? `Python 실행 안 됨: ${PYTHON_EXE}`
        : undefined,
  };
}

/**
 * Claude Agent SDK에 전달할 MCP 서버 설정.
 * K-Personal이 사용 가능하면 등록, 아니면 빈 객체.
 */
function buildMCPServers(health: MCPStatus): Record<string, McpStdioServerConfig> {
  if (!health.configured) {
    return {};
  }

  return {
    "k-personal": {
      type: "stdio",
      command: PYTHON_EXE,
      args: [K_PERSONAL_PATH],
      env: {},
    },
  };
}

// ─── I/O 헬퍼 ──────────────────────────────────────────

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(level: "info" | "warn" | "error", message: string): void {
  emit({ type: "log", level, message });
}

// ─── Elicitation (사용자 확인 요청) ─────────────────────

/**
 * 위험한 도구 목록 — 실행 전 사용자 확인 필요
 */
const DANGEROUS_TOOLS: Record<string, { action: string; severity: "warn" | "danger" }> = {
  // 파일 이동/삭제
  "fm_move_file": { action: "파일을 이동합니다", severity: "warn" },
  "fm_copy_file": { action: "파일을 복사합니다", severity: "warn" },
  "fm_organize_folder": { action: "폴더를 정리합니다", severity: "warn" },
  // 앱 종료
  "app_kill": { action: "프로세스를 종료합니다", severity: "danger" },
  // 마우스/키보드 자동화 (민감한 작업)
  "cc_mouse_click": { action: "마우스 클릭을 수행합니다", severity: "warn" },
  "cc_keyboard_type": { action: "키보드 입력을 수행합니다", severity: "warn" },
  "cc_keyboard_hotkey": { action: "단축키를 입력합니다", severity: "warn" },
};

/**
 * 현재 대기 중인 elicitation 요청들
 */
const pendingElicitations = new Map<string, {
  resolve: (confirmed: boolean) => void;
  toolName: string;
  toolInput: unknown;
}>();

/**
 * Elicitation 응답 처리
 */
function handleElicitationResponse(id: string, confirmed: boolean): void {
  const pending = pendingElicitations.get(id);
  if (pending) {
    pending.resolve(confirmed);
    pendingElicitations.delete(id);
  }
}

/**
 * 위험한 도구 실행 전 사용자 확인 요청
 */
async function requestElicitation(
  turnId: string,
  toolName: string,
  toolInput: unknown,
): Promise<boolean> {
  // dry_run 모드면 확인 없이 바로 실행
  if (typeof toolInput === "object" && toolInput !== null && (toolInput as any).dry_run === true) {
    return true;
  }

  const dangerousInfo = DANGEROUS_TOOLS[toolName];
  if (!dangerousInfo) {
    return true; // 위험하지 않은 도구는 바로 실행
  }

  const elicitationId = `elicit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 도구 입력을 사람이 읽기 쉽게 포맷
  const inputSummary = formatToolInput(toolName, toolInput);

  // Frontend로 확인 요청 전송
  emit({
    type: "elicitation_request",
    id: elicitationId,
    turn_id: turnId,
    tool_name: toolName,
    tool_input: toolInput,
    title: `🔧 ${toolName}`,
    message: `${dangerousInfo.action}\n\n${inputSummary}`,
    severity: dangerousInfo.severity,
    confirm_label: "실행",
    cancel_label: "취소",
  });

  // 응답 대기 (Promise)
  return new Promise((resolve) => {
    pendingElicitations.set(elicitationId, {
      resolve,
      toolName,
      toolInput,
    });

    // 60초 타임아웃 — 응답 없으면 취소로 처리
    setTimeout(() => {
      if (pendingElicitations.has(elicitationId)) {
        pendingElicitations.delete(elicitationId);
        resolve(false);
        log("warn", `Elicitation timeout for ${toolName}`);
      }
    }, 60000);
  });
}

/**
 * 도구 입력을 사람이 읽기 쉽게 포맷
 */
function formatToolInput(toolName: string, input: unknown): string {
  if (typeof input !== "object" || input === null) {
    return String(input);
  }

  const obj = input as Record<string, unknown>;
  const lines: string[] = [];

  switch (toolName) {
    case "fm_move_file":
    case "fm_copy_file":
      if (obj.src) lines.push(`📄 원본: ${obj.src}`);
      if (obj.dst) lines.push(`📁 대상: ${obj.dst}`);
      break;
    case "fm_organize_folder":
      if (obj.path) lines.push(`📁 폴더: ${obj.path}`);
      if (obj.dry_run) lines.push(`🔍 미리보기 모드`);
      break;
    case "app_kill":
      if (obj.process_name) lines.push(`💀 프로세스: ${obj.process_name}`);
      break;
    case "cc_mouse_click":
      lines.push(`🖱️ 클릭 위치: (${obj.x ?? "현재"}, ${obj.y ?? "현재"})`);
      if (obj.button) lines.push(`버튼: ${obj.button}`);
      break;
    case "cc_keyboard_type":
      if (obj.text) lines.push(`⌨️ 입력: "${obj.text}"`);
      break;
    case "cc_keyboard_hotkey":
      if (Array.isArray(obj.keys)) lines.push(`⌨️ 단축키: ${obj.keys.join("+")}`);
      break;
    default:
      // 기본: JSON 형태로 표시 (최대 200자)
      const json = JSON.stringify(obj, null, 2);
      lines.push(json.length > 200 ? json.slice(0, 200) + "..." : json);
  }

  return lines.join("\n");
}

// ─── 턴 관리 ───────────────────────────────────────────

type UserMessage = {
  type: "user_message";
  id: string;
  content: string;
  agent_id?: string;  // resume 지원용 (기존 대화 이어가기)
  history?: Array<{ role: "user" | "assistant"; content: string }>;
};

function buildPromptWithHistory(
  content: string,
  history?: Array<{ role: "user" | "assistant"; content: string }>
): string {
  if (!history || history.length === 0) return content;

  const lines: string[] = ["<prior_conversation>"];
  for (const m of history) {
    const label = m.role === "user" ? "User" : "Assistant";
    // 너무 긴 assistant 메시지는 2000자에서 절단 (컨텍스트 보호)
    const text = m.content.length > 2000 ? m.content.slice(0, 2000) + "…(truncated)" : m.content;
    lines.push(`[${label}] ${text}`);
  }
  lines.push("</prior_conversation>");
  lines.push("");
  lines.push("<current_message>");
  lines.push(content);
  lines.push("</current_message>");
  return lines.join("\n");
}

const activeTurns = new Map<string, AbortController>();
let cachedMCPHealth: MCPStatus = { configured: false, serverPathExists: false, pythonAvailable: false };

async function handleUserMessage(msg: UserMessage): Promise<void> {
  const abort = new AbortController();
  activeTurns.set(msg.id, abort);

  const mcpServers = buildMCPServers(cachedMCPHealth);

  try {
    const promptWithHistory = buildPromptWithHistory(msg.content, msg.history);
    const stream = query({
      prompt: promptWithHistory,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        mcpServers,
        abortController: abort,
        permissionMode: "bypassPermissions",
        ...(msg.agent_id ? { resume: msg.agent_id } : {}),
      },
    });

    let sawResult = false;
    for await (const event of stream as AsyncIterable<any>) {
      switch (event.type) {
        case "assistant": {
          const blocks = event.message?.content ?? [];
          for (const block of blocks) {
            if (block.type === "text") {
              emit({
                type: "assistant_delta",
                id: msg.id,
                text: block.text,
              });
            } else if (block.type === "tool_use") {
              emit({
                type: "tool_use",
                id: msg.id,
                tool_id: block.id,
                name: block.name,
                input: block.input,
              });
            }
          }
          break;
        }
        case "user": {
          const blocks = event.message?.content ?? [];
          for (const block of blocks) {
            if (block.type === "tool_result") {
              emit({
                type: "tool_result",
                id: msg.id,
                tool_id: block.tool_use_id,
                output: normalizeToolOutput(block.content),
              });
            }
          }
          break;
        }
        case "result": {
          sawResult = true;
          // usage 디버깅 로그 - 상세 출력
          log("info", `[usage] raw: ${JSON.stringify(event.usage)}`);
          log("info", `[usage] modelUsage: ${JSON.stringify(event.modelUsage)}`);

          // modelUsage에서 총 토큰 계산 (input_tokens가 없을 수 있음)
          let totalInputTokens = 0;
          let totalOutputTokens = 0;
          if (event.modelUsage) {
            for (const model of Object.values(event.modelUsage)) {
              totalInputTokens += (model as any).inputTokens ?? 0;
              totalOutputTokens += (model as any).outputTokens ?? 0;
            }
          }

          emit({
            type: "done",
            id: msg.id,
            usage: event.usage ?? null,
            // 계산된 토큰도 함께 전송
            computed_usage: {
              input_tokens: totalInputTokens,
              output_tokens: totalOutputTokens,
            },
            // SDK는 session_id 필드로 보냄 — 프런트에서는 기존대로 agentId 로 소비
            agentId: event.session_id ?? null,
          });
          break;
        }
        default: {
          log("info", `unhandled SDK event: ${JSON.stringify(event.type)}`);
        }
      }
    }

    // result 이벤트가 없었을 때만 fallback done 보냄 (중복 방지)
    if (!sawResult && activeTurns.has(msg.id)) {
      emit({ type: "done", id: msg.id });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "error", id: msg.id, message });
  } finally {
    activeTurns.delete(msg.id);
  }
}

function normalizeToolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === "text" ? c.text : JSON.stringify(c)))
      .join("\n");
  }
  return JSON.stringify(content);
}

// ─── stdin 라인 리더 ───────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    emit({
      type: "error",
      message: `Invalid JSON on stdin: ${String(err)}`,
    });
    return;
  }

  switch (msg.type) {
    case "user_message":
      void handleUserMessage(msg as UserMessage);
      break;
    case "interrupt": {
      const ac = activeTurns.get(msg.id);
      if (ac) {
        ac.abort();
        log("info", `interrupted turn ${msg.id}`);
      }
      break;
    }
    case "ping":
      emit({ type: "pong" });
      emit({
        type: "mcp_status",
        connected: cachedMCPHealth.configured,
        server: "k-personal",
        error: cachedMCPHealth.error,
      });
      break;
    case "recheck_mcp": {
      cachedMCPHealth = checkMCPHealth();
      emit({
        type: "mcp_status",
        connected: cachedMCPHealth.configured,
        server: "k-personal",
        error: cachedMCPHealth.error,
      });
      break;
    }
    case "elicitation_response": {
      // Frontend에서 확인/취소 응답
      handleElicitationResponse(msg.id, msg.confirmed === true);
      break;
    }
    default:
      emit({
        type: "error",
        message: `Unknown stdin message type: ${msg.type}`,
      });
  }
});

rl.on("close", () => {
  log("info", "stdin closed, exiting");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  emit({
    type: "error",
    message: `uncaughtException: ${err.message}`,
  });
});

process.on("unhandledRejection", (reason) => {
  emit({
    type: "error",
    message: `unhandledRejection: ${String(reason)}`,
  });
});

// ─── 기동 ──────────────────────────────────────────────

cachedMCPHealth = checkMCPHealth();

emit({ type: "ready", version: "0.3.0" });

emit({
  type: "mcp_status",
  connected: cachedMCPHealth.configured,
  server: "k-personal",
  error: cachedMCPHealth.error,
  details: {
    path: K_PERSONAL_PATH,
    pathExists: cachedMCPHealth.serverPathExists,
    pythonAvailable: cachedMCPHealth.pythonAvailable,
  },
});

log(
  "info",
  `sidecar ready (MCP ${cachedMCPHealth.configured ? "configured" : "NOT configured: " + cachedMCPHealth.error})`
);
