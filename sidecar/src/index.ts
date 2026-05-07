/**
 * K Desktop Agent — Node Sidecar (Phase 4: Claude Code CLI 연동)
 *
 * Claude Agent SDK 대신 Claude Code CLI를 subprocess로 호출하여
 * Max 계정 인증을 활용합니다.
 */

import process from "node:process";
import readline from "node:readline";
import {
  existsSync,
  createWriteStream,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  rmSync,
  readdirSync,
  readFileSync,
  type WriteStream,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

// Phase 11 G1 — MCP-via-REST: lets non-Claude providers reach K-Personal MCP tools.
import {
  getKPersonalMCPClient,
  type MCPClient,
  type MCPTool,
} from "./mcpClient.js";
import {
  toOpenAITools,
  toGeminiFunctionDeclarations,
  namespacedToolName,
  dispatchModelToolCall,
} from "./toolSchema.js";
import {
  runOpenAIChatRound,
  runGeminiRound,
  buildOpenAIAssistantToolMessage,
  buildOpenAIToolResultMessage,
  buildGeminiModelToolCallContent,
  buildGeminiToolResponseContent,
  type OpenAIMessage,
  type GeminiContent,
} from "./restTools.js";
import { STATUSLINE_SOURCE } from "./statusLineSource.js";
import { statSync, renameSync } from "node:fs";

// ─── 파일 로거 ─────────────────────────────────────────
// release 모드에서는 sidecar 의 stderr 가 소실되므로 `logs/sidecar.log` 에 직접 append.
// path: <project-root>/logs/sidecar.log — __filename 이 sidecar/src 또는 sidecar/dist 안에 있어서 2단계 위로.
const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = path.dirname(__filename_local);
const LOG_DIR = path.resolve(__dirname_local, "..", "..", "logs");
let fileLogStream: WriteStream | null = null;
try {
  mkdirSync(LOG_DIR, { recursive: true });
  fileLogStream = createWriteStream(path.join(LOG_DIR, "sidecar.log"), { flags: "a" });
} catch {
  // 로깅 실패가 sidecar 동작을 막으면 안 됨
}

function logToFile(level: string, message: string): void {
  if (!fileLogStream) return;
  const ts = Math.floor(Date.now() / 1000);
  try {
    fileLogStream.write(`[epoch=${ts}] ${level}: ${message}\n`);
  } catch {
    // ignore
  }
}

// 크래시 로그: uncaught 예외/거부를 sidecar.log 에 남김 (release 에서도 원인 추적 가능)
process.on("uncaughtException", (err) => {
  logToFile("fatal", `uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
});
process.on("unhandledRejection", (reason) => {
  logToFile("fatal", `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

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

/**
 * Claude Code CLI 실행 파일.
 *
 * 환경변수 CLAUDE_CLI 가 있으면 그걸 우선 사용. 없으면 후보 경로들을
 * 순차적으로 `--version` 으로 검사해 처음 0 리턴 나오는 걸 채택.
 *
 * 후보 우선순위:
 *   1. %APPDATA%\npm\claude.cmd  (npm i -g 글로벌 기본 경로)
 *   2. claude.cmd                (PATH 의 npm 글로벌 디렉토리)
 *   3. claude                    (마지막 폴백)
 *
 * 시도한 경로 목록은 진단용으로 보존 (헬스체크 에러 메시지에 포함).
 */
function getClaudeCliCandidates(): string[] {
  if (process.env.CLAUDE_CLI) {
    return [process.env.CLAUDE_CLI];
  }
  const list: string[] = [];
  const appdata = process.env.APPDATA;
  if (appdata) {
    list.push(path.join(appdata, "npm", "claude.cmd"));
  }
  list.push("claude.cmd", "claude");
  return list;
}

function probeClaudeCli(exe: string): boolean {
  try {
    const result = spawnSync(exe, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      shell: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function resolveClaudeCli(): { resolved: string | null; tried: string[] } {
  const tried: string[] = [];
  for (const candidate of getClaudeCliCandidates()) {
    tried.push(candidate);
    if (probeClaudeCli(candidate)) {
      return { resolved: candidate, tried };
    }
  }
  return { resolved: null, tried };
}

const claudeCliResolution = resolveClaudeCli();
const CLAUDE_CLI = claudeCliResolution.resolved ?? "claude";

/**
 * Codex CLI 실행 파일 (Phase 15).
 *
 * 환경변수 CODEX_CLI 가 있으면 그걸 우선 사용. 없으면 후보 경로들을
 * 순차적으로 `--version` 으로 검사.
 *
 * 후보 우선순위 (Claude CLI 와 동일 패턴):
 *   1. %APPDATA%\npm\codex.cmd
 *   2. codex.cmd
 *   3. codex
 */
function getCodexCliCandidates(): string[] {
  if (process.env.CODEX_CLI) {
    return [process.env.CODEX_CLI];
  }
  const list: string[] = [];
  const appdata = process.env.APPDATA;
  if (appdata) {
    list.push(path.join(appdata, "npm", "codex.cmd"));
  }
  list.push("codex.cmd", "codex");
  return list;
}

function probeCodexCli(exe: string): boolean {
  try {
    const result = spawnSync(exe, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      shell: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function resolveCodexCli(): { resolved: string | null; tried: string[] } {
  const tried: string[] = [];
  for (const candidate of getCodexCliCandidates()) {
    tried.push(candidate);
    if (probeCodexCli(candidate)) {
      return { resolved: candidate, tried };
    }
  }
  return { resolved: null, tried };
}

const codexCliResolution = resolveCodexCli();
const CODEX_CLI = codexCliResolution.resolved ?? "codex";

// ─── 누적 메모리 자동 로딩 (Phase 9 step 1) ─────────────────────
// `~/.claude/projects/<key>/memory/` 의 모든 .md 파일을 system prompt 끝에 주입.
// K 가 명시한 선호(feedback_*), 회피해야 할 함정(pitfall_*), 잘 먹힌 패턴(pattern_*) 을
// 매 턴마다 자동 로드해 같은 실수 반복 / 같은 선호 재설명 부담을 줄인다.
//
// 디렉토리 결정 우선순위:
//   1. KDA_MEMORY_DIR 환경변수 (수동 오버라이드)
//   2. 추론한 프로젝트 루트 (dev 모드 — sidecar/src 또는 sidecar/dist 의 2단계 위)
//      → Claude 키 규약 변환: C:\Users\user\Documents\K-Desktop-Agent
//        → C--Users-user-Documents-K-Desktop-Agent (`:`, `\\` → `-`)
//      → 그 결과 디렉토리에 memory/ 가 실제 존재하면 채택
//   3. release 폴백: 하드코드된 K-Desktop-Agent 의 프로젝트 키
//      (release 에서는 sidecar 가 install 디렉토리에서 실행돼 추론이 틀리므로 필요)
const HARDCODED_MEMORY_KEY = "C--Users-user-Documents-K-Desktop-Agent";

function getMemoryDir(): string {
  const envOverride = process.env.KDA_MEMORY_DIR;
  if (envOverride && existsSync(envOverride)) return envOverride;

  const inferredRoot = path.resolve(__dirname_local, "..", "..");
  const inferredKey = inferredRoot.replace(/[:\\]/g, "-");
  const inferredPath = path.join(
    os.homedir(),
    ".claude",
    "projects",
    inferredKey,
    "memory",
  );
  if (existsSync(inferredPath)) return inferredPath;

  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    HARDCODED_MEMORY_KEY,
    "memory",
  );
}

interface MemoryContext {
  count: number;
  bytes: number;
  content: string;
  dir: string;
}

function loadMemoryContext(): MemoryContext {
  const dir = getMemoryDir();
  try {
    if (!existsSync(dir)) {
      return { count: 0, bytes: 0, content: "", dir };
    }
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    if (files.length === 0) {
      return { count: 0, bytes: 0, content: "", dir };
    }
    const sections: string[] = [];
    let bytes = 0;
    for (const f of files) {
      try {
        const body = readFileSync(path.join(dir, f), "utf-8");
        sections.push(`### ${f}\n${body.trim()}`);
        bytes += body.length;
      } catch (e) {
        logToFile(
          "warn",
          `memory file read 실패 ${f}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (sections.length === 0) {
      return { count: 0, bytes: 0, content: "", dir };
    }
    const content = [
      "",
      "",
      "## K님의 누적 메모리 (memory/)",
      "",
      "다음은 이전 세션들에서 K님과 합의했거나 기록한 선호·함정·패턴입니다.",
      "매 응답에서 자연스럽게 반영하세요. 특히 `pitfall_*` 항목은 동일 패턴을 반복하지 마세요.",
      "",
      sections.join("\n\n"),
    ].join("\n");
    return { count: sections.length, bytes, content, dir };
  } catch (e) {
    logToFile(
      "warn",
      `memory load 실패: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { count: 0, bytes: 0, content: "", dir };
  }
}

const SYSTEM_PROMPT = `당신은 K님의 개인 Windows 컴퓨터를 자동화하는 조수입니다.

[원칙]
- K님이 한국어로 자연스럽게 명령하면, 적절한 도구를 선택해 실행하고 결과를 간결히 보고합니다.
- 불확실하면 먼저 질문합니다.
- 파괴적인 작업(파일 삭제, 덮어쓰기, 이동)은 반드시 dry_run 모드나 확인 질문으로 먼저 시뮬레이션합니다.
- 한 번에 여러 도구를 병렬로 호출할 수 있으면 그렇게 합니다.

[사용 가능한 도구 (k-personal MCP)]
- UI 자동화 (ui_*) ⭐ 우선 사용: dump_tree / find / click_by_name / set_text / focus / invoke / list_windows
  → 데스크톱 앱 제어 시 K님 마우스/키보드/화면을 안 건드림. 백그라운드 창에도 작동.
- 웹 자동화 (web_*) ⭐ 우선 사용: open / snapshot / click / fill / get_text / evaluate / url / close
  → 헤드리스 브라우저로 K님 화면 밖에서 작동. accessibility tree 가 텍스트로 제공돼 정확.
- 화면 (cc_*, 마지막 수단): 스크린샷, 마우스 클릭, 키보드 타이핑 — K님 마우스/키보드를 점유하므로 ui_/web_ 으로 안 풀릴 때만.
- 창: 실행 중 창 목록, 특정 창 활성화, 화면 크기
- 파일: 폴더 탐색, 검색, 최근 수정 파일, 이동/복사, 확장자별 자동 정리
- 앱: 실행/종료, URL 열기, 별명 등록한 앱 실행, 프리셋 실행
- 클립보드: 읽기/쓰기/붙여넣기, 스니펫 관리
- 개인 DB: 할 일 CRUD, 메모, 습관 체크

[자동화 우선순위 — Phase 13]
1. 웹 작업 → web_open + web_snapshot + web_click/fill (스크린샷 X, 항상 헤드리스)
2. 데스크톱 앱 → ui_dump_tree → ui_click_by_name / ui_set_text (스크린샷 X)
3. 위 둘이 안 먹는 캔버스/게임/DRM 화면 → cc_screenshot + cc_mouse_click (K님 입력 점유)
   ※ K님이 같은 PC 를 동시에 쓰는 중일 수 있으므로 cc_* 호출 전엔 한 줄 고지.

[출력 스타일]
- 한국어로, 간결하게.
- 도구 결과가 길면 핵심만 요약.
- 에러가 나면 그대로 보고하고 해결책 제안.

[이전 대화 컨텍스트]
사용자 메시지에 <prior_conversation>...</prior_conversation> 블록이 있으면 그건 지금 진행 중인 대화의 과거 턴 기록입니다. 이를 참고해서 자연스럽게 이어서 답하세요. 실제로 처리해야 할 새 질문은 <current_message>...</current_message> 블록 안에 있습니다. 블록 태그 자체는 사용자에게 언급하지 마세요.

[누적 메모리]
사용자 메시지에 <memory_context>...</memory_context> 블록이 있으면 그건 이전 세션들에서 K님과 합의했거나 기록한 선호·함정·패턴입니다. 시스템 컨텍스트로 취급하고 매 응답에 자연스럽게 반영하세요. 특히 \`pitfall_*\` 항목은 동일 패턴을 반복하지 마세요. 블록 자체는 사용자에게 언급하지 마세요.`;

// ─── MCP 설정 및 헬스체크 ──────────────────────────────

interface MCPStatus {
  configured: boolean;
  serverPathExists: boolean;
  pythonAvailable: boolean;
  claudeCliAvailable: boolean;
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

  // Claude CLI 사용 가능 여부 확인.
  // 모듈 로드 시 resolveClaudeCli() 가 한 번 돌아 후보를 검증했으므로,
  // resolved 가 null 이 아니면 사용 가능.
  // (재호출도 가능하지만 여기선 모듈 초기화 결과를 신뢰 — 헬스체크가
  //  spawnSync 5초 timeout × N 후보로 늘어나면 UX 가 나빠짐.)
  const claudeCliAvailable = claudeCliResolution.resolved !== null;

  const claudeCliError = !claudeCliAvailable
    ? `Claude CLI 실행 안 됨. 시도한 경로: [${claudeCliResolution.tried.join(", ")}]. ` +
      `설치 확인: 'npm i -g @anthropic-ai/claude-code' 후 앱 재시작.`
    : undefined;

  return {
    configured: serverPathExists && pythonAvailable && claudeCliAvailable,
    serverPathExists,
    pythonAvailable,
    claudeCliAvailable,
    error: claudeCliError
      ?? (!serverPathExists
        ? `K-Personal 서버 없음: ${K_PERSONAL_PATH}`
        : !pythonAvailable
          ? `Python 실행 안 됨: ${PYTHON_EXE}`
          : undefined),
  };
}

/**
 * MCP 서버 설정 JSON 생성
 */
function buildMCPConfig(health: MCPStatus): Record<string, any> {
  if (!health.serverPathExists || !health.pythonAvailable) {
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
  logToFile(level, message);
}

// ─── 턴 관리 ───────────────────────────────────────────

type Provider = "claude" | "anthropic" | "openai" | "gemini" | "openrouter" | "codex";

// 권한 레벨 — Settings UI 와 동일.
//   auto    : 자동 승인 (도구 즉시 사용 가능)
//   ask     : 매번 확인 — 도구는 호출 가능하지만 시스템 프롬프트로 모델에게 K 확인 의무화
//             (sidecar 가 stdin/stdout JSON 프로토콜이라 CLI 의 interactive prompt 를 받을 수 없으므로
//              "soft enforcement" 로 대체. 진정한 hard prompt 는 향후 Agent SDK 임베드 시 가능)
//   manual  : 수동만 — 도구 호출 자체를 CLI 가 거부 (--disallowed-tools)
type PermLevel = "auto" | "ask" | "manual";
type PermissionsMap = Partial<Record<string, PermLevel>>;

// 대화 히스토리 항목 — Resume 시 tool 메시지까지 같이 실어 보내려고 union 으로 확장.
type HistoryItem =
  | { role: "user" | "assistant"; content: string }
  | {
      role: "tool";
      toolName: string;
      toolInput?: unknown;
      toolOutput?: string;
    };

type UserMessage = {
  type: "user_message";
  id: string;
  content: string;
  agent_id?: string;  // resume 지원용 (기존 대화 이어가기)
  // history 항목:
  //   user/assistant: { role, content } — 일반 대화 메시지
  //   tool: { role: "tool", toolName, toolInput?, toolOutput? } — 도구 호출/결과 (Resume 시 포함)
  // tool 항목은 buildPromptWithHistory 에서 [Tool] 라벨로 prior_conversation 에 임베드돼
  // 모델이 "이미 어떤 도구를 어떤 결과로 호출했는지" 인지 → 같은 도구 중복 호출 방지.
  history?: Array<HistoryItem>;
  // API 키 (설정에서 입력한 값)
  // - provider === "claude" → Max 구독 OAuth 사용, api_key 무시
  // - 그 외 → REST API 직접 호출에 사용 (필수)
  api_key?: string;
  // 선택된 provider. 미지정/"claude" → Claude Code CLI 경로 (기본).
  provider?: Provider;
  // 모델 ID. provider 별로 형식이 다름 (예: openai="gpt-4o-mini", gemini="gemini-2.0-flash").
  // 미지정이면 provider 별 기본값.
  model?: string;
  // 에이전트 권한 (Settings UI 의 8개 토글 — id → level).
  // claude provider 에서만 의미 있음 (REST API 모드는 도구 미지원).
  permissions?: PermissionsMap;
  // 개별 잠금된 도구 풀네임 목록 (Settings UI "정밀 잠금" 섹션에서 K가 체크).
  // 카테고리 토글과 독립적으로 작동 — 카테고리가 auto 여도 여기 들어 있으면 차단.
  // 예: ["Bash", "mcp__k-personal__fm_move_file", "mcp__k-personal__cc_keyboard_type"]
  lockedTools?: string[];
  // 첨부 파일 — Composer 에서 paste/drag/select 한 파일들 (base64 인코딩됨).
  // sidecar 가 turn 별 임시 폴더에 디코드해 저장하고, Claude CLI prompt 에 path 안내를 추가.
  // 이후 Claude CLI 가 Read 도구로 자동 분석 (image → vision, text → 본문 읽기).
  // turn 종료 시 finally 블록이 임시 폴더 통째로 삭제.
  attachments?: Array<{
    name: string;
    type: string;
    size: number;
    base64: string;
  }>;
};

// ─── 권한 카테고리 ↔ Claude CLI 도구 매핑 ─────────────────
// MCP 도구는 Claude Code CLI 에서 `mcp__<server>__<tool>` 형식.
// K-Personal MCP server name = "k-personal" (buildMCPConfig 참고).
const PERM_TOOL_MAP: Record<string, string[]> = {
  file_read: [
    "Read", "Glob", "Grep",
    "mcp__k-personal__fm_list_directory",
    "mcp__k-personal__fm_search_files",
    "mcp__k-personal__fm_recent_files",
    "mcp__k-personal__fm_file_info",
    "mcp__k-personal__fm_disk_usage",
    "mcp__k-personal__fm_list_backups",
    "mcp__k-personal__fm_operation_log",
  ],
  file_write: [
    "Write", "Edit", "MultiEdit",
    // 비파괴 도구만 여기 — destructive 도구는 file_delete 로 이관 (B안).
    "mcp__k-personal__fm_copy_file",
  ],
  // "파일 삭제" 카테고리.
  // K-Personal MCP 자체는 직접 삭제 도구가 없는 안전한 설계지만,
  // "결과적으로 삭제와 동등한" 도구는 여기로 묶어 file_delete 토글로 통제.
  //   - fm_move_file: 다른 폴더로 옮기면 사실상 원본 위치에선 사라짐
  //   - fm_organize_folder: 자동 정리 = 대량 이동
  //   - fm_restore_file: 백업 복원 = 현재 파일 덮어쓰기
  // Bash(rm/del) 도 file_delete 토글을 참조 (HIGH_RISK_BUILTINS 정책).
  file_delete: [
    "mcp__k-personal__fm_move_file",
    "mcp__k-personal__fm_organize_folder",
    "mcp__k-personal__fm_restore_file",
  ],
  app_launch: [
    "mcp__k-personal__app_launch",
    "mcp__k-personal__app_kill",
    "mcp__k-personal__app_list_running",
    "mcp__k-personal__app_open_url",
    "mcp__k-personal__app_register",
    "mcp__k-personal__app_list_registered",
    "mcp__k-personal__app_launch_preset",
  ],
  system_control: [
    "mcp__k-personal__cc_mouse_move",
    "mcp__k-personal__cc_mouse_click",
    "mcp__k-personal__cc_mouse_position",
    "mcp__k-personal__cc_keyboard_type",
    "mcp__k-personal__cc_keyboard_hotkey",
    "mcp__k-personal__cc_focus_window",
    "mcp__k-personal__clip_get",
    "mcp__k-personal__clip_set",
    "mcp__k-personal__clip_paste_at",
    "mcp__k-personal__clip_snippet_add",
    "mcp__k-personal__clip_snippet_get",
    "mcp__k-personal__clip_snippet_list",
  ],
  screenshot: [
    "mcp__k-personal__cc_screenshot",
    "mcp__k-personal__cc_screenshot_region",
    "mcp__k-personal__cc_screen_size",
    "mcp__k-personal__cc_list_windows",
  ],
  web_fetch: ["WebFetch", "WebSearch"],
  db_access: [
    "mcp__k-personal__db_todo_add",
    "mcp__k-personal__db_todo_list",
    "mcp__k-personal__db_todo_done",
    "mcp__k-personal__db_todo_delete",
    "mcp__k-personal__db_note_add",
    "mcp__k-personal__db_note_list",
    "mcp__k-personal__db_note_search",
    "mcp__k-personal__db_note_delete",
    "mcp__k-personal__db_habit_add",
    "mcp__k-personal__db_habit_check",
    "mcp__k-personal__db_habit_list",
  ],
  // Phase 13 — Headless Automation
  // ui_*: Windows UI Automation 트리 직접 조작. 마우스/키보드/스크린샷 안 씀,
  //       백그라운드 창에도 작동. K님이 같은 PC 를 동시에 써도 충돌 0.
  //       cc_* (system_control/screenshot) 와 별도 카테고리로 분리해
  //       "K 입력 점유 여부" 단위로 토글 가능.
  ui_automation: [
    "mcp__k-personal__ui_dump_tree",
    "mcp__k-personal__ui_find",
    "mcp__k-personal__ui_click_by_name",
    "mcp__k-personal__ui_click_by_id",
    "mcp__k-personal__ui_set_text",
    "mcp__k-personal__ui_get_text",
    "mcp__k-personal__ui_focus_control",
    "mcp__k-personal__ui_invoke",
    "mcp__k-personal__ui_list_windows",
  ],
  // web_*: Playwright 헤드리스 브라우저. K님 화면에 안 뜸.
  //        web_fetch (단순 GET) 와 분리 — 이쪽은 클릭/입력까지 가능한 풀 자동화.
  web_automation: [
    "mcp__k-personal__web_open",
    "mcp__k-personal__web_snapshot",
    "mcp__k-personal__web_click",
    "mcp__k-personal__web_fill",
    "mcp__k-personal__web_get_text",
    "mcp__k-personal__web_screenshot",
    "mcp__k-personal__web_evaluate",
    "mcp__k-personal__web_url",
    "mcp__k-personal__web_close",
  ],
};

// 권한 ID → 한국어 라벨 (시스템 프롬프트 안내문에 사용).
const PERM_LABEL: Record<string, string> = {
  file_read: "파일 읽기",
  file_write: "파일 쓰기",
  file_delete: "파일 삭제",
  app_launch: "앱 실행",
  system_control: "시스템 제어 (마우스/키보드/클립보드)",
  screenshot: "화면 캡처",
  web_fetch: "웹 요청",
  db_access: "개인 DB",
  ui_automation: "UI 자동화 (백그라운드 컨트롤 조작)",
  web_automation: "웹 자동화 (헤드리스 브라우저)",
};

// 기본 권한 정책 — Settings UI DEFAULT_PERMISSIONS 와 동일.
// permissions 필드가 비어 있을 때(첫 실행 등) 사용.
// 2026-04-30: K 의 풀 PC 제어 요청에 따라 4개 권한을 ask → auto 로 승급.
// (file_write/file_delete/app_launch/system_control 모두 auto 가 되면
//  HIGH_RISK_BUILTINS 정책에 의해 Bash/BashOutput/KillShell 도 자동 해제됨)
const DEFAULT_PERMISSIONS: Record<string, PermLevel> = {
  file_read: "auto",
  file_write: "auto",
  file_delete: "auto",
  app_launch: "auto",
  system_control: "auto",
  screenshot: "auto",
  web_fetch: "auto",
  db_access: "auto",
  // Phase 13 — 헤드리스 자동화는 K님 입력/화면을 안 건드리므로 기본 auto
  ui_automation: "auto",
  web_automation: "auto",
};

// Bash, BashOutput, KillShell 같은 high-risk built-in.
// 단일 명령으로 파일 삭제·앱 실행·임의 코드 실행이 모두 가능 → 별도 정책.
// 정책: file_write / file_delete / app_launch 셋 중 하나라도 manual 또는 ask 면 → 거부.
//       (모두 auto 일 때만 K가 명시적으로 풀권한 상태이므로 허용)
const HIGH_RISK_BUILTINS = ["Bash", "BashOutput", "KillShell"];

// Claude CLI 가 노출하는 "셸·코드 실행 우회 통로" — 권한 카테고리 매핑이 어렵거나
// sub-agent 형태로 게이트를 무력화할 수 있는 도구들. 권한 토글과 무관하게 항상 차단.
//   - Task: sub-agent 를 띄우면 그 안에선 게이트가 다시 풀린 상태 → 우회 가능
//   - Monitor: 임의 셸 명령 실행 (Bash 우회 통로)
//   - Skill: .claude/skills 의 임의 코드 실행
//   - NotebookEdit: Jupyter 셀 실행 (이 프로젝트엔 불필요, 셸 실행 가능)
// (Bash 자체는 HIGH_RISK_BUILTINS 에서 별도 정책으로 처리)
const ALWAYS_BLOCKED_BYPASS = ["Task", "Monitor", "Skill", "NotebookEdit"];

interface ToolFlags {
  disallowed: string[];
  effective: Record<string, PermLevel>;
  lockedCount: number;
}

function buildToolFlags(
  perms: PermissionsMap | undefined,
  lockedTools: string[] | undefined,
): ToolFlags {
  const effective: Record<string, PermLevel> = { ...DEFAULT_PERMISSIONS };
  if (perms) {
    for (const [id, level] of Object.entries(perms)) {
      if (level === "auto" || level === "ask" || level === "manual") {
        effective[id] = level;
      }
    }
  }

  // ─── 정책 모델 (v0.4.1+: A안 회귀 + 개별 잠금 추가) ──────────────────
  //
  // K님 원래 요구는 "자동화 능력은 살아있되, 위험 도구는 하나하나 잠그는 버튼".
  // 이전 C안(default-deny + --allowed-tools strict) 은 새 MCP 도구가 자동 차단되고
  // 와일드카드 잔버그(K-Personal MCP 통째 미노출)가 생겨 자동화 본질과 충돌 → 회귀.
  //
  // 새 모델:
  //   1. default-allow  — `--allowed-tools` 미사용. Claude CLI 가 노출하는 도구는
  //      기본적으로 호출 가능. 새 MCP 도구 추가돼도 자동 허용 → 자동화 능력 보존.
  //   2. 카테고리 차단  — 카테고리 토글이 manual 인 권한의 도구는 disallowed 풀네임으로 박힘.
  //   3. 개별 잠금      — Settings UI "정밀 잠금"에서 K가 체크한 도구 풀네임은 그대로
  //      disallowed 에 추가 (카테고리 auto 여도 무조건 차단). "하나하나 잠그는 버튼"의 본체.
  //   4. 우회 통로 차단 — ALWAYS_BLOCKED_BYPASS (Task/Monitor/Skill/NotebookEdit) 는 항상 disallowed.
  //   5. Bash 정책      — file_write+file_delete+app_launch 가 모두 auto 일 때만 Bash/BashOutput/KillShell 허용.
  const disallowed: string[] = [...ALWAYS_BLOCKED_BYPASS];

  // 카테고리 토글이 manual 인 도구 풀네임 추가
  for (const [permId, level] of Object.entries(effective)) {
    if (level !== "manual") continue;
    const tools = PERM_TOOL_MAP[permId] ?? [];
    disallowed.push(...tools);
  }

  // 개별 잠금된 도구 풀네임 추가 (카테고리 토글과 독립적)
  let lockedCount = 0;
  if (lockedTools && Array.isArray(lockedTools)) {
    for (const t of lockedTools) {
      if (typeof t === "string" && t.trim()) {
        disallowed.push(t.trim());
        lockedCount++;
      }
    }
  }

  // Bash 정책: 파괴적 카테고리 셋이 모두 auto 일 때만 셸 허용
  const bashTrustworthy =
    effective.file_write === "auto" &&
    effective.file_delete === "auto" &&
    effective.app_launch === "auto";
  if (!bashTrustworthy) {
    disallowed.push(...HIGH_RISK_BUILTINS);
  }

  return {
    disallowed: Array.from(new Set(disallowed)),
    effective,
    lockedCount,
  };
}

// "ask" 모드 권한이 있으면 시스템 프롬프트 끝에 안내 추가.
// 모델이 해당 카테고리 도구를 호출하기 전에 K에게 한국어로 확인을 받도록 지시.
function buildAskGuidance(effective: Record<string, PermLevel>): string {
  const askIds = Object.entries(effective)
    .filter(([, lv]) => lv === "ask")
    .map(([id]) => id);
  if (askIds.length === 0) return "";

  const lines = askIds.map((id) => `  - ${PERM_LABEL[id] ?? id}`);
  return [
    "",
    "[K님 확인 필요한 권한 (ask 모드)]",
    "다음 카테고리의 도구를 호출하기 전에는 반드시 한국어로 의도를 한 줄 설명한 뒤",
    "K님께 \"진행해도 될까요?\" 형태로 명시적 확인을 받고, 허락 후에만 도구를 호출합니다.",
    "K님이 \"응/그래/진행해\" 같이 동의하지 않으면 호출하지 않습니다.",
    ...lines,
  ].join("\n");
}

// manual 카테고리가 있을 때 시스템 프롬프트 안내 (모델이 헛수고 안 하게).
function buildManualGuidance(effective: Record<string, PermLevel>): string {
  const manualIds = Object.entries(effective)
    .filter(([, lv]) => lv === "manual")
    .map(([id]) => id);
  if (manualIds.length === 0) return "";
  const lines = manualIds.map((id) => `  - ${PERM_LABEL[id] ?? id}`);
  return [
    "",
    "[차단된 권한 (manual 모드)]",
    "다음 카테고리의 도구는 K님이 차단했습니다. 호출 시도 자체가 거부됩니다.",
    "필요하면 K님께 환경설정에서 권한을 풀어달라고 안내하세요.",
    ...lines,
  ].join("\n");
}

// REST API 호출용 시스템 프롬프트 (도구 미지원 — Claude CLI 경로의 K-Personal MCP 안내 제거)
const SYSTEM_PROMPT_REST = `당신은 K님의 개인 비서입니다. 한국어로 자연스럽고 간결하게 응답하세요.

[제약]
- 이 모드(외부 API)에서는 K-Personal MCP 도구(스크린샷, 마우스, 파일 등)를 사용할 수 없습니다.
- 시스템 자동화가 필요하면 K님께 "Claude (Max 구독) 모드로 전환" 을 안내하세요.
- 코드/명령어를 제외한 모든 답변은 한국어로 작성합니다.`;

// tool 호출 결과를 텍스트로 압축 — base64 폭탄 / 거대 파일 출력 방어.
// toolInput 은 JSON 으로 직렬화하되 800자, toolOutput 은 1500자에서 절단.
// (toolOutput 에 base64 이미지가 통째로 들어있으면 1500자만으로도 충분히 "찍었다" 는 의미 전달)
function summarizeToolItem(item: Extract<HistoryItem, { role: "tool" }>): string {
  const inputStr = (() => {
    if (item.toolInput == null) return "";
    try {
      const s = typeof item.toolInput === "string"
        ? item.toolInput
        : JSON.stringify(item.toolInput);
      return s.length > 800 ? s.slice(0, 800) + "…(truncated)" : s;
    } catch {
      return "[unserializable]";
    }
  })();
  const outputStr = (() => {
    if (!item.toolOutput) return "(no output / interrupted)";
    return item.toolOutput.length > 1500
      ? item.toolOutput.slice(0, 1500) + "…(truncated)"
      : item.toolOutput;
  })();
  const head = `[Tool] ${item.toolName}${inputStr ? `(${inputStr})` : ""}`;
  return `${head}\n→ ${outputStr}`;
}

function buildPromptWithHistory(
  content: string,
  history?: Array<HistoryItem>,
  memoryContent?: string,
): string {
  // memory 가 있으면 stdin 의 시작에 시스템 컨텍스트 블록으로 prepend.
  // 이유: --system-prompt 인자에 memory 를 박으면 Windows cmd.exe 의 8191자 한계를 넘겨
  //       "명령줄이 너무 깁니다" 로 spawn 자체가 실패한다 (memory 가 6KB+ 누적되면 발생).
  //       stdin 은 길이 한계가 없으므로 memory 는 stdin 으로 흘리는 것이 안전.
  // SYSTEM_PROMPT 의 "[누적 메모리]" 안내가 이 블록을 시스템 컨텍스트로 취급하도록 모델을 안내함.
  const memoryBlock =
    memoryContent && memoryContent.trim()
      ? `<memory_context>\n${memoryContent.trim()}\n</memory_context>\n\n`
      : "";

  if (!history || history.length === 0) return memoryBlock + content;

  const lines: string[] = ["<prior_conversation>"];
  for (const m of history) {
    if (m.role === "tool") {
      lines.push(summarizeToolItem(m));
      continue;
    }
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
  return memoryBlock + lines.join("\n");
}

const activeTurns = new Map<string, ChildProcess>();
// REST API 모드의 turn은 fetch AbortController 로 취소.
const activeRestTurns = new Map<string, AbortController>();
let cachedMCPHealth: MCPStatus = { configured: false, serverPathExists: false, pythonAvailable: false, claudeCliAvailable: false };

// ─── Provider 라우터 ──────────────────────────────────
async function handleUserMessage(msg: UserMessage): Promise<void> {
  const provider: Provider = msg.provider ?? "claude";
  if (provider === "claude") {
    return handleViaClaudeCLI(msg);
  }
  if (provider === "codex") {
    return handleViaCodexCLI(msg);
  }
  return handleViaRestAPI(msg, provider);
}

// ─── 첨부 파일을 임시 폴더에 풀어내기 ────────────────────────────
// Composer 에서 base64 로 보낸 파일들을 turn 별 임시 디렉토리에 디코드해 저장.
// 반환값:
//   dir: 정리 대상 임시 폴더 경로 (없으면 null)
//   guidance: prompt 끝에 붙일 안내 텍스트 (없으면 빈 문자열)
// Claude CLI 의 Read 도구가 path 를 받아 이미지는 vision, 텍스트는 본문으로 처리.
function materializeAttachments(
  msg: UserMessage,
): { dir: string | null; guidance: string } {
  const list = msg.attachments;
  if (!list || list.length === 0) return { dir: null, guidance: "" };

  // turn 별 폴더 — 이름 충돌과 동시 turn 간섭 방지 + 정리 단순화
  const dir = path.join(os.tmpdir(), `kda-attachments-${msg.id}`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    logToFile("warn", `attachment dir 생성 실패: ${e instanceof Error ? e.message : String(e)}`);
    return { dir: null, guidance: "" };
  }

  const lines: string[] = [];
  let saved = 0;
  for (let i = 0; i < list.length; i++) {
    const att = list[i];
    if (!att?.base64) continue;
    // 파일명 sanitize — Windows 경로 금지 문자 / 공백 / 디렉토리 트래버설 차단.
    // 빈 결과면 idx 기반 fallback 으로 대체.
    const safeName =
      (att.name ?? "")
        .replace(/[\\/:*?"<>|]/g, "_")
        .replace(/\.\.+/g, "_")
        .replace(/\s+/g, "_")
        .slice(0, 120) || `attachment-${i}`;
    const target = path.join(dir, safeName);
    try {
      writeFileSync(target, Buffer.from(att.base64, "base64"));
      saved++;
      const sizeKB = Math.max(1, Math.round((att.size ?? 0) / 1024));
      lines.push(`  - ${target}  (${att.type || "application/octet-stream"}, ${sizeKB}KB)`);
    } catch (e) {
      logToFile(
        "warn",
        `attachment write 실패 ${att.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (saved === 0) {
    return { dir, guidance: "" };
  }

  const guidance = [
    "",
    "[첨부 파일]",
    "K님이 다음 파일을 첨부했습니다. Read 도구로 내용을 확인한 뒤 답변에 활용하세요.",
    "(이미지는 자동으로 vision 분석되고, 텍스트는 본문이 그대로 읽힙니다)",
    ...lines,
  ].join("\n");

  return { dir, guidance };
}

// ─── Claude Code CLI 경로 (Max 구독 OAuth) ─────────────
async function handleViaClaudeCLI(msg: UserMessage): Promise<void> {
  const mcpConfig = buildMCPConfig(cachedMCPHealth);

  // 첨부 파일을 임시 폴더에 풀고, prompt 에 path 안내를 덧붙임.
  // 임시 폴더는 finally 에서 통째로 삭제.
  const { dir: attachmentsDir, guidance: attachmentsGuidance } =
    materializeAttachments(msg);
  const baseContent = attachmentsGuidance
    ? `${msg.content}${attachmentsGuidance}`
    : msg.content;
  // memory 는 stdin (prompt) 으로 흘려보낸다 — 명령행 길이 한계 회피.
  const memory = loadMemoryContext();
  const promptWithHistory = buildPromptWithHistory(
    baseContent,
    msg.history,
    memory.content,
  );

  // ─── 명령행 길이 절약 ───────────────────────────────────────
  // Windows cmd.exe 의 명령행 길이 한계는 약 8191자.
  // history 가 길어진 prompt(최대 ~40KB) 를 -p 인자로 그대로 박으면
  // "명령줄이 너무 깁니다" 류 에러로 spawn 자체가 실패한다.
  // 대책:
  //   1. prompt 본문은 stdin 으로 흘려보낸다 (-p 만 두고 인자 값은 생략).
  //   2. mcp-config JSON 도 임시 파일로 빼서 path 만 인자로 넘긴다.
  //
  // 임시 파일은 finally 에서 정리.
  let mcpConfigFile: string | null = null;

  // ─── 권한 게이트 (default-allow + 개별 잠금) ──────────────────────
  // Settings UI 의 8개 카테고리 토글(auto/ask/manual) + "정밀 잠금" 도구 리스트를 변환.
  //   카테고리 manual    → 카테고리 도구 풀네임이 --disallowed-tools 에 박힘 (hard)
  //   카테고리 ask       → 시스템 프롬프트가 K 확인 의무화 (soft — sidecar 가 stdin 프로토콜이라
  //                        CLI interactive prompt 를 못 받음)
  //   카테고리 auto      → 자유 호출
  //   개별 잠금된 도구    → 카테고리와 무관하게 --disallowed-tools 에 박힘 (hard)
  //   Task/Monitor/Skill/NotebookEdit → 항상 차단 (우회 통로)
  //   Bash/BashOutput/KillShell → file_write+file_delete+app_launch 가 모두 auto 일 때만 허용
  // --allowed-tools 는 미사용 (default-allow → 새 MCP 도구 자동 허용 → 자동화 능력 보존).
  // --permission-mode 는 bypassPermissions (interactive prompt 우회, 실제 게이트는 disallowed-tools).
  const toolFlags = buildToolFlags(msg.permissions, msg.lockedTools);

  // Claude CLI 인자 구성 (인자에 박는 본문 최소화)
  const args: string[] = [
    "-p",  // prompt 는 stdin 으로 받음 (인자 생략)
    "--output-format", "stream-json",
    "--verbose",
    // 2026-05-06: Claude CLI 2.1.122 기준 stream-json 모드에서도 partial messages
    // (message_start / content_block_delta 등)는 이 옵션 켜야 emit 됨.
    // 안 켜면 result 만 와서 Phase 12 의 maxTurnUsage 캡처가 0 으로 박힘 → 컨텍스트 % 가
    // 100턴 가도 안 올라가는 회귀 발생 (이번 세션 displayCtx=0 이 그 증상).
    "--include-partial-messages",
    // bypass 모드 — interactive prompt 우회. 실제 게이트는 disallowed-tools 가 담당.
    "--permission-mode", "bypassPermissions",
  ];

  if (toolFlags.disallowed.length > 0) {
    args.push("--disallowed-tools", toolFlags.disallowed.join(","));
  }

  // 시스템 프롬프트 = 기본 + ask 안내 + manual 안내.
  // 누적 메모리(memory/) 는 길이가 누적되어 cmd.exe 의 8191자 한계를 깨므로
  // --system-prompt 인자에 박지 않는다 — 대신 stdin(prompt) 의 <memory_context> 블록으로 흘려보냄.
  // SYSTEM_PROMPT 의 "[누적 메모리]" 안내가 모델에게 그 블록을 시스템 컨텍스트로 취급하도록 함.
  const askGuidance = buildAskGuidance(toolFlags.effective);
  const manualGuidance = buildManualGuidance(toolFlags.effective);
  const fullSystemPrompt = SYSTEM_PROMPT + askGuidance + manualGuidance;

  // ─── 큰 인자 자동 파일 외화 ─────────────────────────────────────────
  // 임계치(LARGE_ARG_THRESHOLD) 이상의 인자 값은 임시 파일로 빼고 path 인자로 전환.
  // Claude CLI 는 다음을 모두 지원:
  //   --system-prompt <text>     ↔ --system-prompt-file <path>
  //   --settings     <text|path> (둘 다 같은 인자, file path 도 OK)
  //   --mcp-config   <text|path>
  // 임계치를 넘지 않으면 inline 으로 두어 디스크 I/O 부담 회피.
  // 모든 외화 파일은 finally 에서 cleanup.
  const tmpFiles: string[] = [];
  const LARGE_ARG_THRESHOLD = 1500;  // 1.5KB 이상은 파일로 — 큰 인자 4-5개 합쳐도 안전선 안.

  function pushOrMaterialize(
    inlineFlag: string,
    fileFlag: string | null,
    value: string,
    suffix: string,
  ): void {
    if (value.length < LARGE_ARG_THRESHOLD || !fileFlag) {
      // 작거나 file 변형이 없으면 inline.
      // (file 변형이 있어도 작으면 inline 이 빠름)
      args.push(inlineFlag, value);
      return;
    }
    try {
      const tmpPath = path.join(os.tmpdir(), `kda-${suffix}-${msg.id}.txt`);
      writeFileSync(tmpPath, value, "utf-8");
      tmpFiles.push(tmpPath);
      args.push(fileFlag, tmpPath);
    } catch (e) {
      // 파일 쓰기 실패 시 inline 폴백 — 길이 검증에서 다시 잡힘.
      logToFile(
        "warn",
        `${suffix} 임시 파일 외화 실패, inline 폴백: ${e instanceof Error ? e.message : String(e)}`,
      );
      args.push(inlineFlag, value);
    }
  }

  pushOrMaterialize("--system-prompt", "--system-prompt-file", fullSystemPrompt, "system-prompt");

  // ─── JSON 인자 외화 + read-back 검증 헬퍼 ─────────────────────────
  // 도입 배경 (2026-05-06): Phase 13 직후 비결정적으로 발생한 두 종류 사고
  //   - "Invalid JSON provided to --settings"
  //   - "Invalid MCP configuration: mcpServers: Does not adhere to ... schema"
  // 원인 가설: writeFileSync 는 동기지만 OS 디스크 cache flush 까지 보장 X →
  //          Claude CLI 가 spawn 직후 너무 빨리 읽으면 빈/부분 파일을 보고 거부.
  // 대책: 작성 직후 read-back → JSON.parse + 길이 일치 → 두 번 실패하면 inline 폴백.
  const materializeJsonArg = (opts: {
    inlineFlag: string;
    jsonString: string;
    suffix: string;
  }): { ok: boolean; mode: "file" | "inline-fallback"; tmpPath: string | null; bytes: number } => {
    const tmpPath = path.join(os.tmpdir(), `kda-${opts.suffix}-${msg.id}.json`);
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        writeFileSync(tmpPath, opts.jsonString, "utf-8");
        const readBack = readFileSync(tmpPath, "utf-8");
        if (readBack.length !== opts.jsonString.length) {
          throw new Error(`length mismatch: written=${opts.jsonString.length} readback=${readBack.length}`);
        }
        JSON.parse(readBack); // throw on invalid
        args.push(opts.inlineFlag, tmpPath);
        tmpFiles.push(tmpPath);
        return { ok: true, mode: "file", tmpPath, bytes: opts.jsonString.length };
      } catch (e) {
        lastErr = e;
        logToFile(
          "warn",
          `${opts.suffix} 외화 검증 실패 (시도 ${attempt}/2): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    const head50 = opts.jsonString.length > 50 ? opts.jsonString.slice(0, 50) + "..." : opts.jsonString;
    logToFile(
      "error",
      `${opts.suffix} 외화 2회 실패 → inline 폴백. lastErr=${lastErr instanceof Error ? lastErr.message : String(lastErr)} head=${head50}`,
    );
    args.push(opts.inlineFlag, opts.jsonString);
    return { ok: false, mode: "inline-fallback", tmpPath: null, bytes: opts.jsonString.length };
  };

  // MCP 설정 외화 (Claude CLI v2 expects top-level { mcpServers: {...} } wrapper)
  let mcpBytes = 0;
  let mcpHead50 = "";
  if (Object.keys(mcpConfig).length > 0) {
    const mcpJson = JSON.stringify({ mcpServers: mcpConfig });
    mcpBytes = mcpJson.length;
    mcpHead50 = mcpJson.length > 50 ? mcpJson.slice(0, 50) + "..." : mcpJson;
    const r = materializeJsonArg({ inlineFlag: "--mcp-config", jsonString: mcpJson, suffix: "mcp" });
    mcpConfigFile = r.ok ? r.tmpPath : null;
  }

  // 세션 ID가 있으면 이어가기
  if (msg.agent_id) {
    args.push("--resume", msg.agent_id);
  }

  // ─── PreToolUse Hook 주입 ──────────────────────────────────────────
  // 두 가지 가드:
  //   (1) overwriteGuard — file_delete=manual 일 때 Write/Edit/MultiEdit 의 "기존 파일 덮어쓰기" 차단.
  //                        신규 파일 생성은 file_write 토글로만 통제. 의미적으로 데이터 삭제와 동등한 작업 차단.
  //   (2) pitfallGuard   — memory/pitfall_*.md 에 등록된 K 와 합의된 함정 패턴을 Bash 도구 호출 직전에 감지.
  //                        (Phase 9 step 4) 동일 실수 반복 방지 + stderr 로 회피책을 모델에 피드백.
  // dev (sidecar/src/index.ts) 와 release (sidecar/dist/index.js) 모두 한 단계 위로 가서 hooks/ 도달.
  const overwriteGuardPath = path.resolve(__dirname_local, "..", "hooks", "preToolUse-overwriteGuard.mjs");
  const pitfallGuardPath = path.resolve(__dirname_local, "..", "hooks", "preToolUse-pitfallGuard.mjs");
  const hookSettings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Write|Edit|MultiEdit",
          hooks: [
            { type: "command", command: `node "${overwriteGuardPath}"` },
          ],
        },
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: `node "${pitfallGuardPath}"` },
          ],
        },
      ],
    },
  };
  // --settings: 항상 파일로 외화 + read-back 검증 (materializeJsonArg 사용).
  // Reason: shell:true + inline JSON triggers Windows cmd.exe double-quote quirk,
  // making CLI see malformed JSON ("Invalid JSON provided to --settings").
  // 추가로 OS disk-cache flush race 까지 read-back 으로 차단.
  const settingsJson = JSON.stringify(hookSettings);
  const settingsBytes = settingsJson.length;
  const settingsHead50 = settingsJson.length > 50 ? settingsJson.slice(0, 50) + "..." : settingsJson;
  materializeJsonArg({ inlineFlag: "--settings", jsonString: settingsJson, suffix: "settings" });

  // 권한 정책 요약 — 어느 카테고리가 어떻게 처리됐는지 진단 가능.
  const permSummary = Object.entries(toolFlags.effective)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");

  // ─── 인자 합산 길이 검증 (Windows cmd.exe 8191자 한계 회귀 방지) ────────
  // shell:true 로 spawn 하면 "cmd /d /s /c <CLAUDE_CLI> <args...>" 형태로 합쳐져 cmd.exe 가 처리.
  // 위 자동 외화로 큰 인자(--system-prompt, --settings, --mcp-config) 는 이미 path 로 줄어들었지만,
  // 향후 어떤 코드가 새로운 큰 인자를 추가해도 spawn 전에 잡히도록 3단 방어선:
  //   1. WARN  (≥6500): 로그만 남기고 진행 — 인자 추가 흔적 추적용
  //   2. FAIL  (≥7800): spawn 안 함, error 이벤트로 명확히 표면화 + 인자별 길이 dump
  //   3. cmd.exe 8191 자체 한계 — FAIL 임계치가 마진 포함이라 사실상 도달 안 함
  const argsTotalLen =
    CLAUDE_CLI.length + args.reduce((acc, a) => acc + a.length + 3, 0); // +3 = " " + 양쪽 quote 여유
  const ARGS_WARN_THRESHOLD = 6500;
  const ARGS_FAIL_THRESHOLD = 7800;  // 8191 - 391 마진 (cmd /d /s /c, 환경변수 inheritance 등)

  function dumpArgLengths(): string {
    // 이름/값 페어로 나눠 길이 분석. 진단 시 어떤 인자가 비대한지 즉시 파악 가능.
    const parts: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith("--") || a === "-p") {
        const next = args[i + 1];
        if (next && !next.startsWith("--") && next !== "-p") {
          parts.push(`${a}=${next.length}`);
          i++;
        } else {
          parts.push(`${a}`);
        }
      } else {
        parts.push(`<bare:${a.length}>`);
      }
    }
    return parts.join(" ");
  }

  if (argsTotalLen >= ARGS_FAIL_THRESHOLD) {
    const dump = dumpArgLengths();
    const errMsg =
      `CLI args length ${argsTotalLen} exceeds safety threshold ${ARGS_FAIL_THRESHOLD} ` +
      `(Windows cmd.exe 한계 8191). 자동 파일 외화 후에도 인자가 비대 — spawn 차단. ` +
      `인자별 길이: ${dump}`;
    logToFile("error", errMsg);
    // 외화 임시 파일들 cleanup (spawn 안 했으므로 finally 안 거침)
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch { /* cleanup error ignored */ }
    }
    if (attachmentsDir) {
      try { rmSync(attachmentsDir, { recursive: true, force: true }); } catch { /* cleanup error ignored */ }
    }
    emit({
      type: "error",
      id: msg.id,
      message: `명령행 길이 초과 (${argsTotalLen}자). 누군가 큰 인자를 추가했을 가능성 — sidecar.log 의 "CLI args length" 진단 라인 확인. 자세한 로그: ${dump}`,
    });
    emit({ type: "done", id: msg.id, agentId: null });
    return;
  }
  if (argsTotalLen >= ARGS_WARN_THRESHOLD) {
    logToFile(
      "warn",
      `CLI args length ${argsTotalLen} approaches Windows cmd.exe 8191-char limit (threshold=${ARGS_WARN_THRESHOLD}). 인자별 길이: ${dumpArgLengths()}`
    );
  }

  const attachmentsCount = msg.attachments?.length ?? 0;
  logToFile(
    "info",
    `CLI query start id=${msg.id} len=${msg.content.length} promptBytes=${Buffer.byteLength(promptWithHistory, "utf-8")} argsLen=${argsTotalLen} tmpFiles=${tmpFiles.length} resume=${msg.agent_id ?? "none"} mcp=${Object.keys(mcpConfig).length} mcpFile=${mcpConfigFile ? "yes" : "no/inline"} settingsBytes=${settingsBytes} mcpBytes=${mcpBytes} perms=${permSummary} disallowed=${toolFlags.disallowed.length} locked=${toolFlags.lockedCount} hooks=overwriteGuard+pitfallGuard attachments=${attachmentsCount}${attachmentsDir ? ` attDir=${attachmentsDir}` : ""} memory=${memory.count}/${memory.bytes}b`
  );
  // 진단용 head50 (Phase F 2026-05-06 사고 재발 시 즉시 원인 잡기 위해)
  logToFile(
    "info",
    `CLI query head50 id=${msg.id} settingsHead=${JSON.stringify(settingsHead50)} mcpHead=${JSON.stringify(mcpHead50 || "(no mcp)")}`,
  );

  try {
    // Claude CLI 실행
    // hook 스크립트(preToolUse-overwriteGuard.mjs) 가 자식 자식 프로세스로 실행되므로
    // 권한 정책 정보는 환경변수로 전파한다 (Claude CLI → hook 으로 자동 상속됨).
    const proc = spawn(CLAUDE_CLI, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      env: {
        ...process.env,
        // 터미널 깜빡임 방지
        CLAUDE_CODE_NO_FLICKER: "1",
        // PreToolUse hook 이 읽는 정보
        KDA_FILE_DELETE_LEVEL: toolFlags.effective.file_delete ?? "auto",
        KDA_OVERWRITE_GUARD: "1",
        KDA_PITFALL_GUARD: process.env.KDA_PITFALL_GUARD ?? "1",
      },
    });

    activeTurns.set(msg.id, proc);

    // prompt 본문을 stdin 으로 흘려보냄 (명령행 길이 한계 우회)
    if (proc.stdin) {
      proc.stdin.on("error", (e) => {
        logToFile("warn", `CLI stdin error: ${e instanceof Error ? e.message : String(e)}`);
      });
      proc.stdin.write(promptWithHistory, "utf-8");
      proc.stdin.end();
    }

    let currentText = "";
    let sessionId: string | null = null;
    let sawResult = false;

    // ─── Per-turn usage 추적 (Phase 12 — Context Meter v2) ───────────────────
    // 한 turn 안에서 sub-agent / iterative tool 호출 등으로 model call 이 N번 일어나면,
    // result.usage 는 그 N번을 누적 합산한 값이라 1M~4M 까지 부풀어 윈도우 점유율로 부적절.
    // 반면 각 model call 시작 직전의 SSE message_start 의 usage 는 "그 시점에 모델이 실제로
    // 본 컨텍스트 크기" (input + cache_creation + cache_read) 라, turn 안에서 최댓값을 취하면
    // 그 turn 의 가장 큰 단일 model call 컨텍스트 = 윈도우 점유율의 정확한 척도.
    let maxTurnInputTokens = 0;
    let maxTurnCacheCreation = 0;
    let maxTurnCacheRead = 0;
    let maxTurnContextTokens = 0; // = max over message_starts of (input + cc + cr)

    // stderr 캡처: CLI 가 비정상 종료할 때 진짜 원인을 파악.
    // Windows 한국어 콘솔은 cp949(euc-kr) 로 출력하므로 해당 인코딩으로 디코드.
    // 영어 메시지는 ASCII 호환이라 cp949 디코더로도 정상 디코드됨.
    let stderrTail = "";
    const STDERR_KEEP = 4096;
    let stderrDecoder: TextDecoder | null = null;
    try {
      stderrDecoder = new TextDecoder("euc-kr", { fatal: false });
    } catch {
      stderrDecoder = null; // ICU 미지원 환경에선 utf-8 폴백
    }
    // Phase 17: --resume 이 fail 한 케이스를 stderr 패턴으로 감지.
    // Claude CLI 는 "No conversation found with session ID: <id>" 메시지를 stderr 에 박은 뒤
    // exit 0 + 빈 result 로 마무리한다. 이 경우 frontend 가 빈 응답 + 사라지는 작업 표시 만 보고
    // 원인을 모르니, 명시적 에러로 변환해 자동 회복 흐름 (agent_id 클리어 + 재시도) 트리거.
    let resumeSessionMissing = false;
    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        const decoded = stderrDecoder
          ? stderrDecoder.decode(chunk, { stream: true })
          : chunk.toString("utf-8");
        stderrTail += decoded;
        if (stderrTail.length > STDERR_KEEP) {
          stderrTail = stderrTail.slice(-STDERR_KEEP);
        }
        if (
          !resumeSessionMissing &&
          /No conversation found with session ID/i.test(decoded)
        ) {
          resumeSessionMissing = true;
          logToFile(
            "warn",
            `CLI resume target missing — agent_id=${msg.agent_id ?? "?"} 새 session 으로 자동 회복 안내 emit 예정`,
          );
        }
        logToFile("warn", `CLI stderr: ${decoded.trimEnd()}`);
      });
    }

    // stdout 스트리밍 처리
    const rl = readline.createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);

        // 이벤트 타입에 따라 처리
        switch (event.type) {
          case "system": {
            // 시스템 초기화 이벤트 (session_id 포함)
            if (event.session_id) {
              sessionId = event.session_id;
            }
            break;
          }

          case "assistant": {
            // assistant 메시지 - 텍스트 또는 tool_use
            const message = event.message;
            if (message?.content) {
              for (const block of message.content) {
                if (block.type === "text") {
                  // 텍스트 델타 전송
                  const newText = block.text;
                  if (newText && newText !== currentText) {
                    // 전체 텍스트 대신 새로운 부분만 전송
                    const delta = newText.slice(currentText.length);
                    if (delta) {
                      emit({
                        type: "assistant_delta",
                        id: msg.id,
                        text: delta,
                      });
                    }
                    currentText = newText;
                  }
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
            }
            break;
          }

          case "user": {
            // tool_result 이벤트
            const message = event.message;
            if (message?.content) {
              for (const block of message.content) {
                if (block.type === "tool_result") {
                  emit({
                    type: "tool_result",
                    id: msg.id,
                    tool_id: block.tool_use_id,
                    output: normalizeToolOutput(block.content),
                  });
                }
              }
            }
            break;
          }

          case "result": {
            // 완료 이벤트
            sawResult = true;
            // Phase 17: --resume target 이 stderr "No conversation found" 였으면 빈 응답이
            // 그대로 done 으로 가서 frontend 가 작업 표시만 사라진 채 멍해짐. 명시적 에러로
            // 변환 + agentId=null 로 보내 frontend 가 새 session 시작하도록 안내.
            if (resumeSessionMissing && !currentText) {
              emit({
                type: "error",
                id: msg.id,
                message:
                  "이전 대화 세션을 찾을 수 없어요 (앱 업데이트로 위치가 바뀌었을 가능성). 다음 메시지부터는 새 세션으로 자동 이어집니다.",
                code: "resume_session_missing",
                agentId: null,
              } as any);
              emit({
                type: "done",
                id: msg.id,
                usage: null,
                computed_usage: null,
                maxTurnUsage: null,
                agentId: null, // 클리어 — frontend 가 다음 turn 부터 새 session 으로 시작
              });
              logToFile(
                "info",
                `CLI turn end (resume missing recovery) id=${msg.id} clearedAgentId=${msg.agent_id}`,
              );
              break;
            }
            // 안전망: 마지막 chunk 가 race / 누락 등으로 빠졌을 가능성 대비.
            // currentText 가 비어있지 않으면 최종 텍스트로 한 번 더 emit (frontend 가 replace).
            // 2026-05-06 회귀: chunk 단위 emit → 마지막 chunk 만 화면에 남는 사고가 있었기에 추가.
            if (currentText) {
              emit({ type: "assistant_delta", id: msg.id, text: currentText });
            }
            // result.usage 는 한 turn 안 모든 model call 의 누적 합산이라 윈도우 점유율로
            // 부적절. 대신 turn 동안 캡처한 message_start 들의 최댓값(maxTurnUsage)을
            // 별도 필드로 함께 emit — 클라이언트가 이걸 정확한 컨텍스트 측정치로 사용.
            emit({
              type: "done",
              id: msg.id,
              usage: event.usage ?? null,
              computed_usage: event.usage ?? null,
              maxTurnUsage:
                maxTurnContextTokens > 0
                  ? {
                      input_tokens: maxTurnInputTokens,
                      cache_creation_input_tokens: maxTurnCacheCreation,
                      cache_read_input_tokens: maxTurnCacheRead,
                      total_context_tokens: maxTurnContextTokens,
                    }
                  : null,
              agentId: event.session_id ?? sessionId,
            });
            // 다음 turn 을 위해 진단 로그 한 줄 — 표시(maxTurn)와 raw(result.usage)를
            // 동시 박아 회귀 시 갭 추적 가능.
            const ru = event.usage ?? {};
            const rawCtx =
              (ru.input_tokens ?? 0) +
              (ru.cache_creation_input_tokens ?? 0) +
              (ru.cache_read_input_tokens ?? 0);
            logToFile(
              "info",
              `CLI turn end id=${msg.id} displayCtx=${maxTurnContextTokens} rawCtx=${rawCtx} (input=${maxTurnInputTokens} cc=${maxTurnCacheCreation} cr=${maxTurnCacheRead})`
            );
            break;
          }

          case "stream_event": {
            // 부분 응답 이벤트 (실시간 스트리밍)
            const inner = event.event;
            // ── (a) text_delta — 화면에 흘려 보냄 ───────────────────
            const delta = inner?.delta;
            if (delta?.type === "text_delta" && delta.text) {
              // 2026-05-06 회귀 fix: --include-partial-messages 옵션을 켜면서
              // text_delta 가 chunk 단위로 잘게 옴. 프론트는 assistant_delta 의 text 를
              // *전체 내용으로 replace* 하는 정책이라 chunk 만 보내면 마지막 chunk 만 화면에 남고
              // 응답이 잘린 것처럼 보임. → 누적값(currentText) 을 보낸다.
              currentText += delta.text;
              emit({
                type: "assistant_delta",
                id: msg.id,
                text: currentText,
              });
            }
            // ── (b) message_start — turn 내 단일 model call 의 컨텍스트 크기 캡처 ──
            //   sub-agent / iterative tool 호출이 있으면 한 turn 에 여러 번 옴.
            //   각 시점의 (input + cache_creation + cache_read) 중 최댓값 = 윈도우 점유율.
            if (inner?.type === "message_start") {
              const u = inner.message?.usage;
              if (u) {
                const inputT = u.input_tokens ?? 0;
                const cc = u.cache_creation_input_tokens ?? 0;
                const cr = u.cache_read_input_tokens ?? 0;
                const ctx = inputT + cc + cr;
                if (ctx > maxTurnContextTokens) {
                  maxTurnInputTokens = inputT;
                  maxTurnCacheCreation = cc;
                  maxTurnCacheRead = cr;
                  maxTurnContextTokens = ctx;
                }
              }
            }
            break;
          }

          case "rate_limit_event": {
            // Phase 15.5 — Anthropic Max 의 rate limit 정보 (매 turn 박혀 옴)
            //   5h primary 한도 + 7d secondary(weekly) 한도 + 각각 reset_at + 사용%.
            //   지금까진 type 만 로깅했지만, payload 안에 핵심 데이터 다 있음.
            //   frontend 가 5h/주간 bar + reset countdown 표시 가능.
            const payload = (event as any).event ?? event;
            // raw payload 도 sidecar.log 에 — 첫 빌드에서 실제 필드명 검증용
            logToFile(
              "info",
              `CLI event: rate_limit_event payload=${JSON.stringify(payload).slice(0, 500)}`
            );
            emit({
              type: "rate_limit",
              provider: "anthropic",
              payload,
              receivedAt: Date.now(),
            });
            break;
          }

          default: {
            // 기타 이벤트 로깅
            logToFile("info", `CLI event: ${event.type}`);
          }
        }
      } catch (parseErr) {
        // JSON 파싱 실패 - 무시
        logToFile("warn", `JSON parse error: ${line}`);
      }
    }

    // 프로세스 종료 대기
    await new Promise<void>((resolve, reject) => {
      proc.on("close", (code) => {
        if (code === 0 || sawResult) {
          resolve();
        } else {
          const tail = stderrTail.trim();
          const detail = tail
            ? `\nstderr (tail):\n${tail}`
            : "\n(stderr 비어있음 — claude --version 으로 CLI 직접 동작 확인 권장)";
          reject(new Error(`Claude CLI exited with code ${code}${detail}`));
        }
      });
      proc.on("error", reject);
    });

    // result 이벤트가 없었을 때만 fallback done 보냄 (중복 방지)
    if (!sawResult && activeTurns.has(msg.id)) {
      emit({ type: "done", id: msg.id, agentId: sessionId });
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logToFile("error", `CLI query error id=${msg.id}: ${message}${stack ? `\n${stack}` : ""}`);
    emit({ type: "error", id: msg.id, message });
  } finally {
    logToFile("info", `CLI query end id=${msg.id}`);
    activeTurns.delete(msg.id);
    // 외화한 임시 인자 파일들 통째 정리 — system-prompt-file, settings, mcp-config 모두.
    // tmpFiles 가 mcpConfigFile 도 포함하므로 별도 처리 불필요.
    for (const f of tmpFiles) {
      try {
        unlinkSync(f);
      } catch {
        // cleanup error ignored
      }
    }
    // 첨부 임시 폴더 통째 정리 — Read 도구 호출이 끝난 뒤이므로 안전.
    // (Claude CLI 가 비동기로 Read 를 부르는 건 이 turn 안에서만이고, await 가 끝나면 이미 완료.)
    if (attachmentsDir) {
      try {
        rmSync(attachmentsDir, { recursive: true, force: true });
      } catch (e) {
        logToFile(
          "warn",
          `attachment dir 정리 실패 ${attachmentsDir}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
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

// ─── Codex CLI 경로 (ChatGPT Plus/Pro OAuth — Phase 15) ──────────────────
//
// Codex CLI 의 `codex exec --json` 은 다음 JSONL 이벤트들을 stdout 으로 emit:
//   - {"type":"thread.started", "thread_id":"<uuid>"}        — session 시작
//   - {"type":"turn.started"}                                — turn 시작
//   - {"type":"item.completed", "item":{ "id":..., "type":"agent_message", "text":... }}
//                                                            — 최종 응답 또는 중간 텍스트
//   - {"type":"item.completed", "item":{ "type":"reasoning",       "text":...}} — 추론
//   - {"type":"item.completed", "item":{ "type":"command_exec",    ...}}        — Bash 호출
//   - {"type":"item.completed", "item":{ "type":"mcp_tool_call",   ...}}        — MCP 도구 호출
//   - {"type":"item.completed", "item":{ "type":"file_change",     ...}}        — 파일 편집
//   - {"type":"item.delta",     "item":{...}}                — 스트리밍 델타 (text)
//   - {"type":"turn.completed", "usage":{ "input_tokens":..., "cached_input_tokens":...,
//                                          "output_tokens":..., "reasoning_output_tokens":... }}
//
// Claude CLI 와 차이:
//   1. session_id 자리는 thread_id. resume 은 `codex exec resume <thread_id>` subcommand.
//   2. usage 는 turn.completed 에 한 번만 옴 (sub-agent 누적 부풀음 없음 → 그대로 maxTurnUsage 로 사용).
//   3. K-Personal MCP 등록은 Codex 가 자체 관리 (~/.codex/config.toml + `codex mcp add`).
//      sidecar 는 mcp-config 인자를 안 넘김 — Codex CLI 가 자기 config 의 mcp_servers 를 자동으로 사용.
//   4. 권한 게이트: Codex 는 자체 sandbox + approvals 시스템. K-Desktop-Agent 의 PermLevel 은
//      sandbox 모드로 매핑 (auto → workspace-write, ask → read-only, manual → 자체 거부).
//      향후 정밀 매핑은 별도 phase. 현재는 --dangerously-bypass-approvals-and-sandbox 로
//      stdin 프로토콜 호환성 우선 (Claude CLI 의 bypassPermissions 와 동등).
async function handleViaCodexCLI(msg: UserMessage): Promise<void> {
  // 첨부 파일은 Claude 와 같은 방식으로 임시 폴더 + 안내 텍스트
  const { dir: attachmentsDir, guidance: attachmentsGuidance } =
    materializeAttachments(msg);
  const baseContent = attachmentsGuidance
    ? `${msg.content}${attachmentsGuidance}`
    : msg.content;
  const memory = loadMemoryContext();
  const promptWithHistory = buildPromptWithHistory(
    baseContent,
    msg.history,
    memory.content,
  );

  // Codex CLI 인자 — `codex exec` 의 sub-form.
  // resume 은 별도 subcommand 라 case 분기로 처리.
  const args: string[] = [];

  if (msg.agent_id) {
    // `codex exec resume <thread_id>` — 기존 세션 이어가기.
    args.push("exec", "resume", msg.agent_id, "--json");
  } else {
    args.push("exec", "--json");
  }

  // 공통 옵션
  args.push(
    "--skip-git-repo-check",                          // 프로젝트 루트가 git repo 가 아니어도 진행
    "--dangerously-bypass-approvals-and-sandbox",      // Claude 의 bypassPermissions 등가 (stdin 프로토콜)
    "-",                                               // prompt = stdin
  );

  // 모델 지정 — Settings 의 chatModel 과 동기화. "default" 면 안 박음 (config.toml 기본값 사용).
  if (msg.model && msg.model.trim() && msg.model !== "default") {
    // -c model="..." 형식 (TOML literal). Codex 는 TOML 파싱 후 dotted-path override.
    args.unshift(`model="${msg.model}"`);
    args.unshift("-c");
  }

  logToFile(
    "info",
    `Codex query start id=${msg.id} model=${msg.model ?? "default"} resume=${msg.agent_id ?? "none"} promptBytes=${Buffer.byteLength(promptWithHistory, "utf-8")} attachments=${msg.attachments?.length ?? 0}`,
  );

  // Per-turn usage 집계 — Codex 는 turn.completed 에 정확한 컨텍스트 크기 한 번 옴.
  let maxTurnInputTokens = 0;
  let maxTurnCacheCreation = 0;
  let maxTurnCacheRead = 0;
  let maxTurnContextTokens = 0;

  let sessionId: string | null = null;
  let currentText = "";
  let sawCompletion = false;
  let stderrTail = "";
  const STDERR_KEEP = 4096;

  try {
    const proc = spawn(CODEX_CLI, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      env: { ...process.env },
    });

    activeTurns.set(msg.id, proc);

    if (proc.stdin) {
      proc.stdin.on("error", (e) => {
        logToFile("warn", `Codex stdin error: ${e instanceof Error ? e.message : String(e)}`);
      });
      proc.stdin.write(promptWithHistory, "utf-8");
      proc.stdin.end();
    }

    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        const decoded = chunk.toString("utf-8");
        stderrTail += decoded;
        if (stderrTail.length > STDERR_KEEP) {
          stderrTail = stderrTail.slice(-STDERR_KEEP);
        }
        logToFile("warn", `Codex stderr: ${decoded.trimEnd()}`);
      });
    }

    const rl = readline.createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        switch (event.type) {
          case "thread.started": {
            if (event.thread_id) sessionId = event.thread_id;
            break;
          }
          case "turn.started": {
            // 신호용 — 현재는 별도 처리 없음
            break;
          }
          case "item.delta": {
            // 스트리밍 델타. agent_message 의 text 누적 (Claude 의 stream_event/text_delta 와 동일).
            const it = event.item;
            if (it?.type === "agent_message" && typeof it.text === "string") {
              currentText += it.text;
              emit({ type: "assistant_delta", id: msg.id, text: currentText });
            }
            break;
          }
          case "item.completed": {
            const it = event.item;
            if (!it) break;
            if (it.type === "agent_message" && typeof it.text === "string") {
              // 일부 호출은 delta 없이 한 번에 옴 — 최종 텍스트 replace.
              if (it.text !== currentText) {
                currentText = it.text;
                emit({ type: "assistant_delta", id: msg.id, text: currentText });
              }
            } else if (it.type === "command_exec") {
              // Codex 자체 Bash 도구 호출. Claude 의 tool_use 패턴으로 중계.
              emit({
                type: "tool_use",
                id: msg.id,
                tool_id: it.id ?? `codex-${Date.now()}`,
                name: it.command_name ?? "Bash",
                input: { command: it.command ?? it.text ?? "" },
              });
              if (it.output != null) {
                emit({
                  type: "tool_result",
                  id: msg.id,
                  tool_id: it.id ?? `codex-${Date.now()}`,
                  output: typeof it.output === "string" ? it.output : JSON.stringify(it.output),
                });
              }
            } else if (it.type === "mcp_tool_call") {
              // MCP 도구 호출 — name 은 보통 "<server>__<tool>" 형식.
              const toolName = it.tool ?? it.name ?? "mcp_tool";
              emit({
                type: "tool_use",
                id: msg.id,
                tool_id: it.id ?? `codex-mcp-${Date.now()}`,
                name: toolName,
                input: it.arguments ?? it.input ?? {},
              });
              if (it.result != null) {
                emit({
                  type: "tool_result",
                  id: msg.id,
                  tool_id: it.id ?? `codex-mcp-${Date.now()}`,
                  output: typeof it.result === "string" ? it.result : JSON.stringify(it.result),
                });
              }
            } else if (it.type === "file_change") {
              emit({
                type: "tool_use",
                id: msg.id,
                tool_id: it.id ?? `codex-file-${Date.now()}`,
                name: "FileEdit",
                input: { path: it.path, change: it.change ?? "edit" },
              });
            }
            // reasoning 등 다른 타입은 일단 로그만.
            else {
              logToFile("info", `Codex item.completed type=${it.type}`);
            }
            break;
          }
          case "turn.completed": {
            sawCompletion = true;
            // Codex usage 형식 → Anthropic usage 형식으로 매핑.
            //   input_tokens          ← input_tokens (모두 새로 본 input)
            //   cached_input_tokens   ← cache_read_input_tokens
            //   (Codex 는 cache_creation 분리 안 함 — 0 으로 둠)
            const u = event.usage ?? {};
            const inp = (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0);
            const cr = u.cached_input_tokens ?? 0;
            maxTurnInputTokens = Math.max(0, inp);
            maxTurnCacheRead = cr;
            maxTurnContextTokens = (u.input_tokens ?? 0); // = 그 turn 모델이 본 컨텍스트 크기
            // 마지막 안전망 — 누적 텍스트가 있으면 한 번 더 emit (Claude 와 동일 정책).
            if (currentText) {
              emit({ type: "assistant_delta", id: msg.id, text: currentText });
            }
            emit({
              type: "done",
              id: msg.id,
              usage: {
                input_tokens: maxTurnInputTokens,
                output_tokens: u.output_tokens ?? 0,
                cache_read_input_tokens: cr,
              },
              computed_usage: {
                input_tokens: maxTurnInputTokens,
                output_tokens: u.output_tokens ?? 0,
                cache_read_input_tokens: cr,
              },
              maxTurnUsage:
                maxTurnContextTokens > 0
                  ? {
                      input_tokens: maxTurnInputTokens,
                      cache_creation_input_tokens: maxTurnCacheCreation,
                      cache_read_input_tokens: maxTurnCacheRead,
                      total_context_tokens: maxTurnContextTokens,
                    }
                  : null,
              agentId: sessionId,
            });
            logToFile(
              "info",
              `Codex turn end id=${msg.id} displayCtx=${maxTurnContextTokens} (input=${maxTurnInputTokens} cr=${maxTurnCacheRead} out=${u.output_tokens ?? 0})`,
            );
            break;
          }
          case "error": {
            const errMsg = event.message ?? event.error ?? "Codex error";
            logToFile("error", `Codex error event: ${errMsg}`);
            emit({ type: "error", id: msg.id, message: String(errMsg) });
            break;
          }
          default: {
            logToFile("info", `Codex event: ${event.type}`);
          }
        }
      } catch (parseErr) {
        logToFile("warn", `Codex JSON parse error: ${line}`);
      }
    }

    await new Promise<void>((resolve, reject) => {
      proc.on("close", (code) => {
        if (code === 0 || sawCompletion) {
          resolve();
        } else {
          const tail = stderrTail.trim();
          const detail = tail
            ? `\nstderr (tail):\n${tail}`
            : "\n(stderr 비어있음 — codex --version 으로 CLI 직접 동작 확인 권장)";
          reject(new Error(`Codex CLI exited with code ${code}${detail}`));
        }
      });
      proc.on("error", reject);
    });

    if (!sawCompletion && activeTurns.has(msg.id)) {
      emit({ type: "done", id: msg.id, agentId: sessionId });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logToFile("error", `Codex query error id=${msg.id}: ${message}${stack ? `\n${stack}` : ""}`);
    emit({ type: "error", id: msg.id, message });
  } finally {
    logToFile("info", `Codex query end id=${msg.id}`);
    activeTurns.delete(msg.id);
    if (attachmentsDir) {
      try {
        rmSync(attachmentsDir, { recursive: true, force: true });
      } catch (e) {
        logToFile(
          "warn",
          `Codex attachment dir 정리 실패: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
}

// ─── REST API 경로 (OpenAI / Anthropic / Gemini / OpenRouter) ─────────────
// 각 프로바이더의 SSE 스트리밍 응답을 파싱해 assistant_delta 이벤트로 중계.
//
// Phase 11 G1 (2026-04-30): OpenAI / OpenRouter / Gemini 는 K-Personal MCP 도구도
// 호출할 수 있게 됨 (function-calling). 모델이 tool_calls 를 emit 하면 sidecar 가
// MCP subprocess 에 위임 → 결과를 받아 다음 라운드에 첨부 → 모델이 최종 답변할 때까지 반복.
// Anthropic-via-REST 는 별개 protocol (tool_use content blocks) 이라 G1 범위 밖이며,
// 텍스트 전용으로 유지됨 (Anthropic 사용자는 Claude (Max OAuth) provider 로 전환 권장).

type ProviderFormat = "openai" | "anthropic" | "gemini";

function defaultModelFor(provider: Provider): string {
  switch (provider) {
    case "anthropic": return "claude-sonnet-4-5";
    case "openai": return "gpt-4o-mini";
    case "gemini": return "gemini-2.0-flash";
    case "openrouter": return "openai/gpt-4o-mini";
    case "codex": return "default";
    default: return "";
  }
}

interface ParsedDelta {
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function parseStreamChunk(parsed: any, format: ProviderFormat): ParsedDelta {
  if (format === "openai") {
    const choice = parsed?.choices?.[0];
    const text = choice?.delta?.content;
    const usage = parsed?.usage;
    return {
      text: typeof text === "string" ? text : undefined,
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
    };
  }
  if (format === "anthropic") {
    if (parsed?.type === "content_block_delta") {
      const delta = parsed.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return { text: delta.text };
      }
    }
    if (parsed?.type === "message_start") {
      return { inputTokens: parsed.message?.usage?.input_tokens };
    }
    if (parsed?.type === "message_delta") {
      return { outputTokens: parsed.usage?.output_tokens };
    }
    return {};
  }
  if (format === "gemini") {
    const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
    const usage = parsed?.usageMetadata;
    return {
      text: typeof text === "string" ? text : undefined,
      inputTokens: usage?.promptTokenCount,
      outputTokens: usage?.candidatesTokenCount,
    };
  }
  return {};
}

// Hard cap on tool-calling rounds per turn. Real Claude agent runs typically settle in
// 4–6 rounds for non-trivial tasks; 8 is a safety ceiling to bound infinite loops where
// the model keeps re-calling the same tool. When hit we emit a warning + done.
const MAX_TOOL_ROUNDS = 8;

// Per-tool-call timeout. K-Personal tools mostly return in <500ms (file ops, screenshot)
// but `app_launch_preset` of a heavy app can take ~10s. 30s is generous.
const MCP_CALL_TIMEOUT_MS = 30_000;

/**
 * Try to load the K-Personal MCP tool catalog for the REST path. Returns null on any
 * failure (missing server, Python missing, handshake timeout) — caller should degrade
 * gracefully to text-only mode.
 */
async function loadMCPToolsForRest(): Promise<{
  client: MCPClient;
  tools: MCPTool[];
} | null> {
  if (!cachedMCPHealth.serverPathExists || !cachedMCPHealth.pythonAvailable) {
    return null;
  }
  try {
    const client = getKPersonalMCPClient({
      command: PYTHON_EXE,
      args: [K_PERSONAL_PATH],
      logger: (level, m) => logToFile(level, m),
    });
    const tools = await client.listTools();
    if (tools.length === 0) return null;
    return { client, tools };
  } catch (e) {
    logToFile("warn", `MCP unavailable for REST turn: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function handleViaRestAPI(msg: UserMessage, provider: Provider): Promise<void> {
  const apiKey = msg.api_key;
  if (!apiKey || !apiKey.trim()) {
    emit({
      type: "error",
      id: msg.id,
      message: `${provider} API 키가 설정되지 않았습니다. 환경설정 → AI 모델 연동에서 키를 입력하거나, Claude (Max 구독) 모드로 전환하세요.`,
    });
    emit({ type: "done", id: msg.id, agentId: null });
    return;
  }

  const model = (msg.model && msg.model.trim()) || defaultModelFor(provider);
  const history = msg.history ?? [];

  // History flattening — same shape as before. Tool messages from prior turns get
  // text-summarised and absorbed into the previous assistant turn so the OpenAI/Gemini
  // message arrays stay legal (no role:"tool" without matching tool_call_id from this
  // exact assistant message). New tool calls in THIS turn are tracked separately and
  // injected with proper tool_call_id linkage on subsequent rounds.
  const flattened: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of history) {
    if (m.role === "tool") {
      const summary = summarizeToolItem(m);
      const last = flattened[flattened.length - 1];
      if (last && last.role === "assistant") {
        last.content = `${last.content}\n\n${summary}`;
      } else {
        flattened.push({ role: "assistant", content: summary });
      }
    } else {
      flattened.push({ role: m.role, content: m.content });
    }
  }

  const memory = loadMemoryContext();
  const restSystemPrompt = SYSTEM_PROMPT_REST + memory.content;

  // ─── Resolve permission policy & MCP tool catalog ──────────────────────
  const permFlags = buildToolFlags(msg.permissions, msg.lockedTools);
  const disallowedSet = new Set(permFlags.disallowed);

  // Provider-side tool calling is currently scoped to OpenAI-shape and Gemini.
  // Anthropic-via-REST keeps text-only single-shot for now (G1 scope decision).
  const supportsTools = provider === "openai" || provider === "openrouter" || provider === "gemini";

  let mcp: { client: MCPClient; tools: MCPTool[] } | null = null;
  let knownToolNames = new Set<string>();
  let openaiToolsArr: ReturnType<typeof toOpenAITools> = [];
  let geminiFnDecls: ReturnType<typeof toGeminiFunctionDeclarations> = [];
  if (supportsTools) {
    mcp = await loadMCPToolsForRest();
    if (mcp) {
      // Build provider-shaped tool catalogs once per turn (reused across rounds).
      openaiToolsArr = toOpenAITools(mcp.tools, disallowedSet);
      geminiFnDecls = toGeminiFunctionDeclarations(mcp.tools, disallowedSet);
      // knownToolNames = catalog actually exposed THIS turn (after permission filter).
      // dispatchModelToolCall uses it to reject hallucinated names.
      for (const t of mcp.tools) {
        const ns = namespacedToolName(t.name);
        if (!disallowedSet.has(ns)) knownToolNames.add(ns);
      }
    }
  }

  // ─── Initial messages array (provider-specific format) ────────────────
  // For OpenAI-shape: [{role:"system",...}, ...flattened, {role:"user", content: msg.content}]
  // For Gemini: contents[] with role "user"/"model"; system goes in systemInstruction.
  const oaiMessages: OpenAIMessage[] = [
    { role: "system", content: restSystemPrompt },
    ...flattened
      .filter((m) => m.content && m.content.trim())
      .map<OpenAIMessage>((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: msg.content },
  ];
  const geminiContents: GeminiContent[] = [
    ...flattened
      .filter((m) => m.content && m.content.trim())
      .map<GeminiContent>((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
    { role: "user", parts: [{ text: msg.content }] },
  ];

  const controller = new AbortController();
  activeRestTurns.set(msg.id, controller);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let aborted = false;
  let roundsRun = 0;
  let totalToolCalls = 0;

  logToFile(
    "info",
    `REST query start id=${msg.id} provider=${provider} model=${model} historyLen=${history.length} memory=${memory.count}/${memory.bytes}b mcp=${mcp ? `${mcp.tools.length}tools/${knownToolNames.size}exposed` : "off"} maxRounds=${MAX_TOOL_ROUNDS}`
  );

  // Round 0 mirrors the legacy single-shot path; rounds 1..N append tool results and
  // re-call the model. Anthropic stays at round 0 only.
  try {
    while (roundsRun < MAX_TOOL_ROUNDS) {
      roundsRun++;

      // Build per-provider request, then dispatch to the correct round runner.
      let endpoint: string;
      let headers: Record<string, string>;
      let body: Record<string, unknown>;
      let runner: "openai" | "gemini" | "anthropic-singleshot";

      switch (provider) {
        case "anthropic": {
          endpoint = "https://api.anthropic.com/v1/messages";
          headers = {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          };
          // Anthropic stays single-shot (G1 scope) — tools omitted, no loop.
          body = {
            model,
            max_tokens: 4096,
            system: restSystemPrompt,
            messages: oaiMessages
              .filter((m) => m.role !== "system" && typeof m.content === "string")
              .map((m) => ({ role: m.role, content: m.content as string })),
            stream: true,
          };
          runner = "anthropic-singleshot";
          break;
        }
        case "openai": {
          endpoint = "https://api.openai.com/v1/chat/completions";
          headers = {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          };
          body = {
            model,
            messages: oaiMessages,
            stream: true,
            stream_options: { include_usage: true },
          };
          if (openaiToolsArr.length > 0) (body as any).tools = openaiToolsArr;
          runner = "openai";
          break;
        }
        case "openrouter": {
          endpoint = "https://openrouter.ai/api/v1/chat/completions";
          headers = {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "x-title": "K Desktop Agent",
            "http-referer": "https://github.com/lee30934-byte/K-Desktop-Agent",
          };
          body = { model, messages: oaiMessages, stream: true };
          if (openaiToolsArr.length > 0) (body as any).tools = openaiToolsArr;
          runner = "openai";
          break;
        }
        case "gemini": {
          endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
          headers = { "content-type": "application/json" };
          body = {
            contents: geminiContents,
            systemInstruction: { parts: [{ text: restSystemPrompt }] },
          };
          if (geminiFnDecls.length > 0) {
            (body as any).tools = [{ functionDeclarations: geminiFnDecls }];
          }
          runner = "gemini";
          break;
        }
        default: {
          emit({ type: "error", id: msg.id, message: `Unknown provider: ${provider}` });
          emit({ type: "done", id: msg.id, agentId: null });
          return;
        }
      }

      // ─── Anthropic single-shot (legacy SSE handling, no tool calls) ────
      if (runner === "anthropic-singleshot") {
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          throw new Error(`HTTP ${response.status} ${response.statusText}: ${errText.slice(0, 800)}`);
        }
        if (!response.body) throw new Error("응답 body 가 비어있음 (스트리밍 미지원?)");

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const eventBlock = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const dataLines: string[] = [];
            for (const line of eventBlock.split("\n")) {
              if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
            }
            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n").trim();
            if (!data || data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parseStreamChunk(parsed, "anthropic");
              if (delta.text) emit({ type: "assistant_delta", id: msg.id, text: delta.text });
              if (typeof delta.inputTokens === "number") totalInputTokens = delta.inputTokens;
              if (typeof delta.outputTokens === "number") totalOutputTokens = delta.outputTokens;
            } catch (e) {
              logToFile("warn", `REST anthropic SSE parse error: ${data.slice(0, 200)}`);
            }
          }
        }
        break; // single-shot — exit loop
      }

      // ─── OpenAI / OpenRouter / Gemini round runner ────────────────────
      const round = runner === "openai"
        ? await runOpenAIChatRound({
            endpoint, headers, body, signal: controller.signal,
            onDelta: { onText: (t) => emit({ type: "assistant_delta", id: msg.id, text: t }) },
            logger: (lv, m) => logToFile(lv, m),
          })
        : await runGeminiRound({
            endpoint, headers, body, signal: controller.signal,
            onDelta: { onText: (t) => emit({ type: "assistant_delta", id: msg.id, text: t }) },
            logger: (lv, m) => logToFile(lv, m),
          });

      totalInputTokens += round.inputTokens;
      totalOutputTokens += round.outputTokens;

      if (round.toolCalls.length === 0) break; // no tools requested → final answer

      if (!mcp) {
        // Defensive — should never happen since tools weren't sent without mcp.
        logToFile("warn", `model emitted tool_calls but MCP is unavailable id=${msg.id}`);
        break;
      }

      // Execute each tool call sequentially. Concurrent execution is tempting (especially
      // for read-only tools) but K-Personal includes mouse/keyboard/clipboard ops where
      // ordering matters. Sequential = predictable.
      const dispatched: Array<{ id: string; name: string; output: string; isError: boolean }> = [];
      for (const tc of round.toolCalls) {
        totalToolCalls++;

        emit({
          type: "tool_use",
          id: msg.id,
          tool_id: tc.id,
          name: tc.name,
          input: tc.args,
        });

        const result = await dispatchModelToolCall({
          client: mcp.client,
          namespacedName: tc.name,
          args: tc.args,
          disallowed: disallowedSet,
          knownTools: knownToolNames,
          callTimeoutMs: MCP_CALL_TIMEOUT_MS,
        });

        const output = result.ok
          ? result.text
          : `[REJECTED] ${result.reason}`;
        const isError = result.ok ? result.isError : true;
        dispatched.push({ id: tc.id, name: tc.name, output, isError });

        emit({
          type: "tool_result",
          id: msg.id,
          tool_id: tc.id,
          output,
        });

        logToFile(
          "info",
          `REST tool dispatch id=${msg.id} round=${roundsRun} name=${tc.name} ok=${result.ok} isError=${isError} outBytes=${output.length}`
        );

        // Honour aborts mid-batch — stops further tool calls in this round.
        if (controller.signal.aborted) break;
      }

      if (controller.signal.aborted) break;

      // Append assistant + tool messages so the next round sees the trace.
      if (runner === "openai") {
        oaiMessages.push(buildOpenAIAssistantToolMessage(round.text, round.toolCalls));
        for (const d of dispatched) {
          oaiMessages.push(buildOpenAIToolResultMessage(d.id, d.output));
        }
      } else {
        geminiContents.push(buildGeminiModelToolCallContent(round.text, round.toolCalls));
        geminiContents.push(
          buildGeminiToolResponseContent(dispatched.map((d) => ({ name: d.name, output: d.output })))
        );
      }

      // If we just hit the ceiling, surface a warning so K knows the loop was capped.
      if (roundsRun >= MAX_TOOL_ROUNDS) {
        const note = `\n\n[round limit] ${MAX_TOOL_ROUNDS}회 도구 호출 후 자동 종료 — 모델이 무한 루프에 빠진 것으로 판단됨.`;
        emit({ type: "assistant_delta", id: msg.id, text: note });
        break;
      }
    }

    emit({
      type: "done",
      id: msg.id,
      usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
      computed_usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
      agentId: null,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      aborted = true;
      logToFile("info", `REST query aborted id=${msg.id} round=${roundsRun}`);
      emit({ type: "done", id: msg.id, agentId: null });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      logToFile("error", `REST query error id=${msg.id} round=${roundsRun}: ${message}`);
      emit({ type: "error", id: msg.id, message });
      emit({ type: "done", id: msg.id, agentId: null });
    }
  } finally {
    activeRestTurns.delete(msg.id);
    logToFile(
      "info",
      `REST query end id=${msg.id} aborted=${aborted} rounds=${roundsRun} toolCalls=${totalToolCalls} in=${totalInputTokens} out=${totalOutputTokens}`
    );
  }
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
      const proc = activeTurns.get(msg.id);
      if (proc) {
        proc.kill("SIGTERM");
        log("info", `interrupted CLI turn ${msg.id}`);
      }
      const controller = activeRestTurns.get(msg.id);
      if (controller) {
        controller.abort();
        log("info", `interrupted REST turn ${msg.id}`);
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
      // CLI 모드에서는 elicitation 처리 안 함 (CLI가 자체 처리)
      log("info", `elicitation_response received (ignored in CLI mode)`);
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

// ─── Phase 15.5 — Claude Code statusLine 설치 + rate limit polling ──────────────
//
// SSE rate_limit_event 는 reset 시간만 주고 used% 는 안 줌. 사용% 는 statusLine 의 stdin
// JSON 에만 박힘. 그래서 우리 helper(statusLineSource.ts)를 K 의 ~/.kda/statusline.mjs 에
// install + claude code 의 settings.json 에 등록 → claude 가 매 update 마다 mjs 호출 →
// mjs 가 %TEMP%/kda-rate-limits.json 에 atomic write → sidecar 가 5초 polling.
//
// 기존 statusLine 이 있으면 덮어쓰지 않고 skip + log warn (안전).

const KDA_STATUSLINE_PATH = path.join(os.homedir(), ".kda", "statusline.mjs");
const KDA_RATE_LIMITS_TMP = path.join(os.tmpdir(), "kda-rate-limits.json");

function installStatusLine(): void {
  try {
    // 1. statusline.mjs dump (매번 overwrite — version 비교 안 해도 atomic)
    mkdirSync(path.dirname(KDA_STATUSLINE_PATH), { recursive: true });
    writeFileSync(KDA_STATUSLINE_PATH, STATUSLINE_SOURCE, "utf-8");

    // 2. ~/.claude/settings.json 에 등록 (없으면 생성, 다른 statusLine 있으면 skip)
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        const raw = readFileSync(settingsPath, "utf-8");
        const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
        settings = JSON.parse(stripped) as Record<string, unknown>;
      } catch (err) {
        log("warn", `settings.json 파싱 실패 (statusLine install skip): ${err}`);
        return;
      }
    }
    const expectedCommand = `node "${KDA_STATUSLINE_PATH}"`;
    const current = (settings.statusLine ?? null) as { command?: string } | null;
    if (current?.command && current.command !== expectedCommand && !current.command.includes("kda")) {
      log(
        "warn",
        `settings.json 에 다른 statusLine 이미 설정됨: ${current.command} — KDA 등록 skip`
      );
      return;
    }
    if (current?.command === expectedCommand) {
      log("info", "statusLine 이미 등록됨 (idempotent)");
      return;
    }
    settings.statusLine = {
      type: "command",
      command: expectedCommand,
      padding: 0,
    };
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    // atomic write — tmp + rename
    const tmp = settingsPath + ".tmp." + process.pid;
    writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf-8");
    renameSync(tmp, settingsPath);
    log("info", `statusLine 등록 완료: ${expectedCommand}`);
  } catch (err) {
    log("warn", `statusLine install 실패: ${err}`);
  }
}

function startRateLimitPolling(): void {
  // (a) statusLine path — interactive Claude 세션이 있으면 statusLine 이 temp file 박음.
  //     non-interactive `claude -p` 에선 안 부르지만, K 가 별도 터미널에서 interactive 쓰면 작동.
  let lastMtime = 0;
  setInterval(() => {
    try {
      const stat = statSync(KDA_RATE_LIMITS_TMP);
      if (stat.mtimeMs <= lastMtime) return;
      lastMtime = stat.mtimeMs;
      const raw = readFileSync(KDA_RATE_LIMITS_TMP, "utf-8");
      const data = JSON.parse(raw);
      emit({
        type: "rate_limit",
        provider: "anthropic",
        payload: data.rate_limits ?? data,
        receivedAt: typeof data.receivedAt === "number" ? data.receivedAt : Date.now(),
      } as any);
      log(
        "info",
        `rate_limit polled (statusLine): ${JSON.stringify(data.rate_limits ?? {}).slice(0, 200)}`
      );
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        log("warn", `rate_limit poll 실패: ${err}`);
      }
    }
  }, 5000);

  // (b) ccusage path — non-interactive 환경(K-Desktop-Agent)에서 정확한 토큰/시간 수집.
  //     `npx ccusage blocks --active --json` (5h primary) + `npx ccusage weekly --json` (주간 secondary).
  //     5분 간격 + 기동 직후 1회. ccusage 가 ~/.claude/projects/ session 파일 파싱 → statusLine 무관.
  pollCcusageOnce();
  setInterval(pollCcusageOnce, 5 * 60 * 1000);
}

function spawnNpx(args: string[], timeoutMs: number): { stdout: string; ok: boolean } {
  // Windows 의 npx 는 npx.cmd 셸 wrapper — cmd /c 로 호출해야 PATH 해석됨.
  const isWin = process.platform === "win32";
  const cmd = isWin ? "cmd" : "npx";
  const fullArgs = isWin ? ["/c", "npx", ...args] : args;
  const res = spawnSync(cmd, fullArgs, {
    encoding: "utf-8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    stdout: res.stdout ?? "",
    ok: res.status === 0 && !!res.stdout,
  };
}

function pollCcusageOnce(): void {
  try {
    const blocks = spawnNpx(["ccusage@latest", "blocks", "--active", "--json"], 30_000);
    const weekly = spawnNpx(["ccusage@latest", "weekly", "--json", "--order", "desc"], 30_000);

    let primary: any = null;
    let secondary: any = null;

    if (blocks.ok) {
      try {
        const j = JSON.parse(blocks.stdout);
        const active = Array.isArray(j.blocks) ? j.blocks.find((b: any) => b.isActive) : null;
        if (active) {
          primary = {
            // ccusage 가 used% 직접 안 줌 — 토큰 + projection 으로 추정.
            // projection.remainingMinutes 가 있으면 "burn rate 기준 한도 도달까지 X분" → 시간 진행률.
            // 폴백: block 시간 진행률 (시작~end 사이 현재 위치).
            used_tokens: active.totalTokens,
            reset_at: active.endTime, // ISO string — App.tsx normalize 가 처리
            // burn rate / projection 도 future use 용으로 보존
            burn_rate: active.burnRate?.tokensPerMinute,
            projection_remaining_min: active.projection?.remainingMinutes,
            block_start: active.startTime,
            block_end: active.endTime,
          };
        }
      } catch (err) {
        log("warn", `ccusage blocks JSON 파싱 실패: ${err}`);
      }
    }

    if (weekly.ok) {
      try {
        const j = JSON.parse(weekly.stdout);
        const current = Array.isArray(j.weekly) && j.weekly.length > 0 ? j.weekly[0] : null;
        if (current) {
          // weekly entry 의 `week` 는 ISO date (YYYY-MM-DD). 다음 reset = week + 7일 0:00.
          const weekStart = new Date(current.week);
          const nextReset = new Date(weekStart);
          nextReset.setDate(nextReset.getDate() + 7);
          secondary = {
            used_tokens: current.totalTokens,
            reset_at: nextReset.toISOString(),
            week_start: current.week,
          };
        }
      } catch (err) {
        log("warn", `ccusage weekly JSON 파싱 실패: ${err}`);
      }
    }

    if (primary || secondary) {
      emit({
        type: "rate_limit",
        provider: "anthropic",
        payload: { primary, secondary, source: "ccusage" },
        receivedAt: Date.now(),
      } as any);
      log(
        "info",
        `rate_limit polled (ccusage): primary_tokens=${primary?.used_tokens ?? "n/a"} secondary_tokens=${secondary?.used_tokens ?? "n/a"}`
      );
    } else {
      log("warn", "ccusage 폴링 — primary/secondary 모두 못 받음 (ccusage 미설치 또는 ~/.claude/projects/ 비어있을 가능성)");
    }
  } catch (err) {
    log("warn", `pollCcusageOnce 실패: ${err}`);
  }
}

// ─── 기동 ──────────────────────────────────────────────

cachedMCPHealth = checkMCPHealth();

// statusLine install (idempotent — 매 sidecar 시작마다 mjs overwrite, settings 는 한 번만)
installStatusLine();
// rate limit polling start
startRateLimitPolling();

emit({ type: "ready", version: "0.4.0" });

emit({
  type: "mcp_status",
  connected: cachedMCPHealth.configured,
  server: "k-personal",
  error: cachedMCPHealth.error,
  details: {
    path: K_PERSONAL_PATH,
    pathExists: cachedMCPHealth.serverPathExists,
    pythonAvailable: cachedMCPHealth.pythonAvailable,
    claudeCliAvailable: cachedMCPHealth.claudeCliAvailable,
    claudeCliResolved: claudeCliResolution.resolved,
    claudeCliTried: claudeCliResolution.tried,
  },
});


const _readyMsg = "sidecar ready (CLI mode, claudeCli=" + (claudeCliResolution.resolved ?? "(none)") + ", MCP " + (cachedMCPHealth.configured ? "configured" : ("NOT configured: " + (cachedMCPHealth.error ?? ""))) + ")";
log("info", _readyMsg);
