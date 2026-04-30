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

type Provider = "claude" | "anthropic" | "openai" | "gemini" | "openrouter";

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
  history?: Array<HistoryItem>
): string {
  if (!history || history.length === 0) return content;

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
  return lines.join("\n");
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
  const promptWithHistory = buildPromptWithHistory(baseContent, msg.history);

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
    // bypass 모드 — interactive prompt 우회. 실제 게이트는 disallowed-tools 가 담당.
    "--permission-mode", "bypassPermissions",
  ];

  if (toolFlags.disallowed.length > 0) {
    args.push("--disallowed-tools", toolFlags.disallowed.join(","));
  }

  // 시스템 프롬프트 = 기본 + ask 안내 + manual 안내 + 누적 메모리 (memory/)
  const askGuidance = buildAskGuidance(toolFlags.effective);
  const manualGuidance = buildManualGuidance(toolFlags.effective);
  const memory = loadMemoryContext();
  const fullSystemPrompt =
    SYSTEM_PROMPT + askGuidance + manualGuidance + memory.content;
  args.push("--system-prompt", fullSystemPrompt);

  // MCP 설정이 있으면 임시 파일로
  if (Object.keys(mcpConfig).length > 0) {
    try {
      const tmpPath = path.join(os.tmpdir(), `kda-mcp-${msg.id}.json`);
      writeFileSync(tmpPath, JSON.stringify(mcpConfig), "utf-8");
      mcpConfigFile = tmpPath;
      args.push("--mcp-config", tmpPath);
    } catch (e) {
      // 임시 파일 작성 실패 시 inline JSON 폴백
      logToFile("warn", `mcp-config 임시 파일 작성 실패, inline 으로 폴백: ${e instanceof Error ? e.message : String(e)}`);
      args.push("--mcp-config", JSON.stringify(mcpConfig));
      mcpConfigFile = null;
    }
  }

  // 세션 ID가 있으면 이어가기
  if (msg.agent_id) {
    args.push("--resume", msg.agent_id);
  }

  // ─── PreToolUse Hook 주입 (덮어쓰기 가드) ──────────────────────────
  // file_delete=manual 일 때 Write/Edit/MultiEdit 가 "기존 파일을 덮어쓰는" 행위
  // (= 의미적으로 데이터 삭제) 를 차단. 신규 파일 생성은 file_write 토글로만 통제.
  // hook 스크립트는 sidecar/hooks/preToolUse-overwriteGuard.mjs 에 위치.
  // dev (sidecar/src/index.ts) 와 release (sidecar/dist/index.js) 모두 한 단계 위로 가서 hooks/ 도달.
  const hookScriptPath = path.resolve(__dirname_local, "..", "hooks", "preToolUse-overwriteGuard.mjs");
  const hookSettings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Write|Edit|MultiEdit",
          hooks: [
            { type: "command", command: `node "${hookScriptPath}"` },
          ],
        },
      ],
    },
  };
  // --settings 는 file path 또는 inline JSON 둘 다 가능. inline 으로 전달 (임시 파일 부담 없음).
  args.push("--settings", JSON.stringify(hookSettings));

  // 권한 정책 요약 — 어느 카테고리가 어떻게 처리됐는지 진단 가능.
  const permSummary = Object.entries(toolFlags.effective)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");

  const attachmentsCount = msg.attachments?.length ?? 0;
  logToFile(
    "info",
    `CLI query start id=${msg.id} len=${msg.content.length} promptBytes=${Buffer.byteLength(promptWithHistory, "utf-8")} resume=${msg.agent_id ?? "none"} mcp=${Object.keys(mcpConfig).length} mcpFile=${mcpConfigFile ? "yes" : "no/inline"} perms=${permSummary} disallowed=${toolFlags.disallowed.length} locked=${toolFlags.lockedCount} hook=overwriteGuard attachments=${attachmentsCount}${attachmentsDir ? ` attDir=${attachmentsDir}` : ""} memory=${memory.count}/${memory.bytes}b`
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
        // PreToolUse hook 이 읽는 권한 정보
        KDA_FILE_DELETE_LEVEL: toolFlags.effective.file_delete ?? "auto",
        KDA_OVERWRITE_GUARD: "1",
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
    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        const decoded = stderrDecoder
          ? stderrDecoder.decode(chunk, { stream: true })
          : chunk.toString("utf-8");
        stderrTail += decoded;
        if (stderrTail.length > STDERR_KEEP) {
          stderrTail = stderrTail.slice(-STDERR_KEEP);
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
            emit({
              type: "done",
              id: msg.id,
              usage: event.usage ?? null,
              computed_usage: event.usage ?? null,
              agentId: event.session_id ?? sessionId,
            });
            break;
          }

          case "stream_event": {
            // 부분 응답 이벤트 (실시간 스트리밍)
            const delta = event.event?.delta;
            if (delta?.type === "text_delta" && delta.text) {
              emit({
                type: "assistant_delta",
                id: msg.id,
                text: delta.text,
              });
              currentText += delta.text;
            }
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
    // 임시 mcp-config 파일 정리
    if (mcpConfigFile) {
      try {
        unlinkSync(mcpConfigFile);
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

// ─── REST API 경로 (OpenAI / Anthropic / Gemini / OpenRouter) ─────────────
// 각 프로바이더의 SSE 스트리밍 응답을 파싱해 assistant_delta 이벤트로 중계.
// 도구 사용은 미지원(K-Personal MCP는 Claude CLI 전용).

type ProviderFormat = "openai" | "anthropic" | "gemini";

function defaultModelFor(provider: Provider): string {
  switch (provider) {
    case "anthropic": return "claude-sonnet-4-5";
    case "openai": return "gpt-4o-mini";
    case "gemini": return "gemini-2.0-flash";
    case "openrouter": return "openai/gpt-4o-mini";
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

  // tool 메시지는 REST API 가 지원 안 하므로 텍스트로 평탄화 후 user 메시지에 합쳐 넣음.
  // (Resume 시 prior tool 호출 정보를 모델이 인지하도록 — Claude CLI 경로와 동등성 유지)
  // role: "user"|"assistant" 만 그대로, "tool" 은 직전 메시지에 보조 텍스트로 흡수.
  const flattened: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of history) {
    if (m.role === "tool") {
      const summary = summarizeToolItem(m);
      // 직전이 assistant 면 거기에 붙이고, 아니면 새 assistant 항목으로 추가.
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

  // OpenAI 호환 messages 배열 (openai/openrouter/anthropic 공통 베이스)
  const oaiMessages = flattened
    .filter((m) => m.content && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
  oaiMessages.push({ role: "user", content: msg.content });

  // 누적 메모리 주입 — Claude CLI 경로와 동일한 memory/ 디렉토리를 read-only 로 시스템 프롬프트에 합침.
  // (REST API 는 도구가 없으니 hook 적용 불가 — pitfall_* 도 정보만 전달됨)
  const memory = loadMemoryContext();
  const restSystemPrompt = SYSTEM_PROMPT_REST + memory.content;

  let endpoint: string;
  let headers: Record<string, string>;
  let body: any;
  let format: ProviderFormat;

  switch (provider) {
    case "anthropic": {
      endpoint = "https://api.anthropic.com/v1/messages";
      headers = {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      };
      body = {
        model,
        max_tokens: 4096,
        system: restSystemPrompt,
        messages: oaiMessages,
        stream: true,
      };
      format = "anthropic";
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
        messages: [{ role: "system", content: restSystemPrompt }, ...oaiMessages],
        stream: true,
        stream_options: { include_usage: true },
      };
      format = "openai";
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
      body = {
        model,
        messages: [{ role: "system", content: restSystemPrompt }, ...oaiMessages],
        stream: true,
      };
      format = "openai";
      break;
    }
    case "gemini": {
      endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
      headers = { "content-type": "application/json" };
      // flattened (tool 메시지를 assistant 텍스트로 흡수한 결과) 를 Gemini 형식으로 변환.
      const contents = flattened
        .filter((m) => m.content && m.content.trim())
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));
      contents.push({ role: "user", parts: [{ text: msg.content }] });
      body = {
        contents,
        systemInstruction: { parts: [{ text: restSystemPrompt }] },
      };
      format = "gemini";
      break;
    }
    default: {
      emit({ type: "error", id: msg.id, message: `Unknown provider: ${provider}` });
      emit({ type: "done", id: msg.id, agentId: null });
      return;
    }
  }

  const controller = new AbortController();
  activeRestTurns.set(msg.id, controller);

  let inputTokens = 0;
  let outputTokens = 0;
  let aborted = false;

  logToFile(
    "info",
    `REST query start id=${msg.id} provider=${provider} model=${model} historyLen=${history.length} memory=${memory.count}/${memory.bytes}b`
  );

  try {
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
    if (!response.body) {
      throw new Error("응답 body 가 비어있음 (스트리밍 미지원?)");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE: 이벤트 경계는 빈 줄(\n\n).
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const eventBlock = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        // event: 라인은 무시, data: 라인만 추출 (멀티라인 data 도 합침)
        const dataLines: string[] = [];
        for (const line of eventBlock.split("\n")) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        }
        if (dataLines.length === 0) continue;
        const data = dataLines.join("\n").trim();
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parseStreamChunk(parsed, format);
          if (delta.text) {
            emit({ type: "assistant_delta", id: msg.id, text: delta.text });
          }
          if (typeof delta.inputTokens === "number") inputTokens = delta.inputTokens;
          if (typeof delta.outputTokens === "number") outputTokens = delta.outputTokens;
        } catch (e) {
          logToFile("warn", `REST SSE parse error: ${data.slice(0, 200)}`);
        }
      }
    }

    emit({
      type: "done",
      id: msg.id,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      computed_usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      agentId: null,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      aborted = true;
      logToFile("info", `REST query aborted id=${msg.id}`);
      emit({ type: "done", id: msg.id, agentId: null });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      logToFile("error", `REST query error id=${msg.id}: ${message}`);
      emit({ type: "error", id: msg.id, message });
      emit({ type: "done", id: msg.id, agentId: null });
    }
  } finally {
    activeRestTurns.delete(msg.id);
    logToFile(
      "info",
      `REST query end id=${msg.id} aborted=${aborted} in=${inputTokens} out=${outputTokens}`
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

// ─── 기동 ──────────────────────────────────────────────

cachedMCPHealth = checkMCPHealth();

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
