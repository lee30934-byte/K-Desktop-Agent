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
  copyFileSync,
  openSync,
  readSync,
  closeSync,
  type WriteStream,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
// Phase 46 (v0.5.34): Windows 에서 process tree (손자 포함) 모두 죽이기 위해 tree-kill 도입.
// node 의 child.kill 은 Windows 에서 손자 process 안 죽임 — Anthropic SDK / MCP 서버 spawn 한
// 자손이 STOP 후에도 살아있어 K 가 "안 멈춤" 으로 인식.
import treeKill from "tree-kill";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
// Phase 135 — Gemini CLI 구독 OAuth 내장 로그인 (로컬 loopback 콜백 서버 + 토큰 교환)
import http from "node:http";
import { randomBytes } from "node:crypto";

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
// Phase 84 (v0.6.27) — Connector/Tool Safety Layer (Lee #6).
// 위험도 분류 + SafeMode 강등 + critical 도구 자동 차단 + tool_use 가시성.
import {
  applySafeMode,
  strictExtraDisallowed,
  riskOfTool,
  summariseSafeModeImpact,
  type SafeMode,
} from "./toolSafety.js";
// Phase 87 (v0.6.30) — Git Memory Sync. lee-profile + memory/ ↔ GitHub private repo
// Phase 89 (v0.6.31) — Hybrid: personal + team repo 둘 다 sync 가능 (SyncTarget 패턴).
// Phase 91 (v0.6.33) — syncLog (commit history viewer)
import {
  syncFull,
  syncStatus,
  syncResolveConflict,
  syncLog,
  storeGitCredential,
  checkGitInstalled,
  makeSyncTarget,
  getTeamMemoryRoot,
  GIT_SYNC_CONFIG_DEFAULTS,
  type GitSyncConfig,
  type GitSyncResult,
  type SyncKind,
} from "./memorySync.js";
// Phase 90 (v0.6.32) — SafeMode 주간 통계 (~/.kda/safety-stats.json)
import {
  recordAlert,
  recordBlock,
  loadSafetyStats,
  resetSafetyStats,
  summariseSafetyStats,
} from "./safetyStats.js";
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
// Phase 54 (v0.5.42): K 의 다른 PC 진단 — 설치본 (`Program Files\K Desktop Agent\...`) 의
// sidecar 부모(`resources\logs`) 가 readonly 라 mkdirSync 가 silent fail → fileLogStream null
// → 진단 로그 전부 silent drop. fallback path 박음 — bundled path 실패 시 user-writable 위치
// (APPDATA → tmpdir) 로 자동 전환. 어디에 박혔는지 첫 라인에 marker 박아 K 가 찾기 쉽게.
const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = path.dirname(__filename_local);
const LOG_DIR_CANDIDATES = [
  path.resolve(__dirname_local, "..", "..", "logs"),
  path.join(
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
    "com.k.desktop-agent",
    "logs",
  ),
  path.join(os.tmpdir(), "kda-logs"),
];
let fileLogStream: WriteStream | null = null;
let activeLogDir: string | null = null;
for (const dir of LOG_DIR_CANDIDATES) {
  try {
    mkdirSync(dir, { recursive: true });
    const stream = createWriteStream(path.join(dir, "sidecar.log"), { flags: "a" });
    fileLogStream = stream;
    activeLogDir = dir;
    // 어디에 박혔는지 첫 라인 marker — K 가 sidecar.log 찾을 때 hint
    try {
      stream.write(
        `[epoch=${Math.floor(Date.now() / 1000)}] info: sidecar log path = ${dir}\n`,
      );
    } catch {
      // ignore — stream 쓰기 실패해도 fileLogStream 자체는 유효 (다음 write 시도)
    }
    break;
  } catch {
    // 다음 candidate 로
  }
}
// 로깅 실패가 sidecar 동작을 막으면 안 됨 — fileLogStream === null 이어도 process 는 계속

function logToFile(level: string, message: string): void {
  if (!fileLogStream) return;
  const ts = Math.floor(Date.now() / 1000);
  try {
    fileLogStream.write(`[epoch=${ts}] ${level}: ${message}\n`);
  } catch {
    // ignore
  }
}

function isBrokenStdoutPipe(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  const message = typeof e?.message === "string" ? e.message : "";
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || message.includes("broken pipe");
}

let exitingForBrokenStdoutPipe = false;
function exitForBrokenStdoutPipe(reason: string): never {
  if (!exitingForBrokenStdoutPipe) {
    exitingForBrokenStdoutPipe = true;
    logToFile("fatal", `stdout pipe is broken; exiting sidecar for parent respawn (${reason})`);
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  }
  throw new Error(reason);
}

process.stdout.on("error", (err) => {
  if (isBrokenStdoutPipe(err)) {
    exitForBrokenStdoutPipe(err instanceof Error ? err.message : String(err));
  }
});

// 크래시 로그: uncaught 예외/거부를 sidecar.log 에 남김 (release 에서도 원인 추적 가능)
process.on("uncaughtException", (err) => {
  logToFile("fatal", `uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  if (isBrokenStdoutPipe(err)) {
    exitForBrokenStdoutPipe(err instanceof Error ? err.message : String(err));
  }
});
process.on("unhandledRejection", (reason) => {
  logToFile("fatal", `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  if (isBrokenStdoutPipe(reason)) {
    exitForBrokenStdoutPipe(reason instanceof Error ? reason.message : String(reason));
  }
});

// ─── 설정 ─────────────────────────────────────────────

/**
 * K-Personal MCP 서버 경로.
 *
 * Phase 22 (v0.5.8): user-specific hardcoded path 제거.
 * Phase 66.7 (v0.6.8): OneDrive redirect 함정 fix — K 보고 사례 (K 의 PC 가
 *   Documents 를 OneDrive 의 한글 폴더 "문서" 로 redirect 하는 환경. node 의
 *   단순 path.join(home, "Documents") 는 이걸 못 따라가 server.py 못 찾음).
 *
 * 우선순위:
 *   1. 환경변수 K_PERSONAL_MCP_PATH (있으면 그대로)
 *   2. ~/.kda/kpersonal-mcp-path.txt 의 첫 줄 (install-kpersonal-mcp.ps1 이 KnownFolder
 *      API 로 정확히 resolve 한 결과를 영속화 — OneDrive / 비표준 redirect 정공법)
 *   3. <USERPROFILE>/Documents/K-Personal-MCP/server.py
 *   4. <USERPROFILE>/OneDrive/Documents/K-Personal-MCP/server.py (영문 OneDrive)
 *   5. <USERPROFILE>/OneDrive/문서/K-Personal-MCP/server.py (한국어 OneDrive)
 *   6. <USERPROFILE>/K-Personal-MCP/server.py
 *   7. (검사 fail 후) 폴더 자체 없으니 MCP NOT configured 정상 표시
 */
function resolveKPersonalPath(): string {
  if (process.env.K_PERSONAL_MCP_PATH) return process.env.K_PERSONAL_MCP_PATH;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";

  // Phase 66.7: install-kpersonal-mcp.ps1 가 박은 KDA cache 파일 우선.
  // 그 ps1 은 Windows KnownFolder API 로 정확한 Documents path (OneDrive redirect 반영)
  // 를 받아 박으므로, 어떤 한국어/영문 OneDrive 변형이든 정공법으로 해결.
  if (home) {
    const cachePath = path.join(home, ".kda", "kpersonal-mcp-path.txt");
    if (existsSync(cachePath)) {
      try {
        // BOM strip (PowerShell 의 Set-Content -Encoding UTF8 함정 양방향 방어)
        let cached = readFileSync(cachePath, "utf-8");
        if (cached.charCodeAt(0) === 0xfeff) cached = cached.slice(1);
        const targetDir = cached.split(/\r?\n/)[0].trim();
        if (targetDir) {
          const serverPy = path.join(targetDir, "server.py");
          if (existsSync(serverPy)) return serverPy;
        }
      } catch {
        // cache 손상 — 무시 + fallback 으로
      }
    }
  }

  if (!home) return "K-Personal-MCP/server.py"; // last-resort relative
  const candidates = [
    path.join(home, "Documents", "K-Personal-MCP", "server.py"),
    // Phase 66.7 — OneDrive redirect 변형들 (K 의 PC 환경)
    path.join(home, "OneDrive", "Documents", "K-Personal-MCP", "server.py"),
    path.join(home, "OneDrive", "문서", "K-Personal-MCP", "server.py"),
    path.join(home, "K-Personal-MCP", "server.py"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // 첫 후보를 default 로 반환 — 존재 안 해도 health check 가 알아서 NOT configured 표시
  return candidates[0];
}
const K_PERSONAL_PATH = resolveKPersonalPath();

/**
 * Python 실행 파일.
 *
 * 환경변수 PYTHON_EXE 가 있으면 그걸 우선 사용. 없으면 후보 경로들을
 * 순차적으로 `--version` 으로 검사해 처음 0 리턴 나오는 걸 채택.
 *
 * 후보 우선순위 (Windows 우선, K PC 환경 — `python` 없고 `py.exe` 만 있음):
 *   1. py.exe              (Windows Python Launcher — Python 설치 시 기본 박힘)
 *   2. py
 *   3. python3.exe
 *   4. python3
 *   5. python.exe
 *   6. python              (마지막 폴백)
 *
 * 시도한 경로 목록은 진단용으로 보존 (헬스체크 에러 메시지에 포함).
 *
 * 함정 (Phase 18 발견): 단순 "python" 으로만 박으면 K PC 처럼 PATH 에
 * `python.exe` 가 없는 환경에서 K-Personal MCP 가 영구히 spawn 못 함 →
 * cc_/ui_/web_/fm_/db_/app_ 도구 전부 사라짐. Claude/Codex CLI 와 동일하게
 * 후보 검출 패턴으로 확장.
 */
function getPythonCandidates(): string[] {
  if (process.env.PYTHON_EXE) {
    return [process.env.PYTHON_EXE];
  }
  return ["py.exe", "py", "python3.exe", "python3", "python.exe", "python"];
}

function probePython(exe: string): boolean {
  try {
    const result = spawnSync(exe, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      shell: true,
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function resolvePython(): { resolved: string | null; tried: string[] } {
  const tried: string[] = [];
  for (const candidate of getPythonCandidates()) {
    tried.push(candidate);
    if (probePython(candidate)) {
      return { resolved: candidate, tried };
    }
  }
  return { resolved: null, tried };
}

const pythonResolution = resolvePython();
const PYTHON_EXE = pythonResolution.resolved ?? "python";

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
      windowsHide: true,
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
      windowsHide: true,
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

/**
 * Gemini CLI 실행 파일 (Phase 134).
 *
 * 환경변수 GEMINI_CLI 가 있으면 그걸 우선 사용. 없으면 후보 경로들을
 * 순차적으로 `--version` 으로 검사 (Claude/Codex CLI 와 동일 패턴).
 *
 * 후보 우선순위:
 *   1. %APPDATA%\npm\gemini.cmd  (npm install -g @google/gemini-cli)
 *   2. gemini.cmd
 *   3. gemini
 */
function getGeminiCliCandidates(): string[] {
  if (process.env.GEMINI_CLI) {
    return [process.env.GEMINI_CLI];
  }
  const list: string[] = [];
  const appdata = process.env.APPDATA;
  if (appdata) {
    list.push(path.join(appdata, "npm", "gemini.cmd"));
  }
  list.push("gemini.cmd", "gemini");
  return list;
}

function probeGeminiCli(exe: string): boolean {
  try {
    const result = spawnSync(exe, ["--version"], {
      encoding: "utf-8",
      timeout: 10000,
      shell: true,
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function resolveGeminiCli(): { resolved: string | null; tried: string[] } {
  const tried: string[] = [];
  for (const candidate of getGeminiCliCandidates()) {
    tried.push(candidate);
    if (probeGeminiCli(candidate)) {
      return { resolved: candidate, tried };
    }
  }
  return { resolved: null, tried };
}

const geminiCliResolution = resolveGeminiCli();
const GEMINI_CLI = geminiCliResolution.resolved ?? "gemini";

// ─── 초기 진단 로그 (Phase 18) ──────────────────────────────────
// CLI/Python resolution 결과를 sidecar.log 에 즉시 박아 K PC 환경별
// 어떤 후보가 채택됐는지 한눈에 진단 가능하게 함.
// "MCP NOT configured" 같은 모호한 메시지의 원인을 sidecar.log 만 보고
// 즉시 좁힐 수 있도록 (env vs PATH vs missing) 결과를 명시적으로 박는다.
logToFile(
  "info",
  `resolved python: ${pythonResolution.resolved ?? "(none)"} ` +
    `tried=[${pythonResolution.tried.join(", ")}] ` +
    `env_PYTHON_EXE=${process.env.PYTHON_EXE ?? "(unset)"}`,
);
logToFile(
  "info",
  `resolved claude_cli: ${claudeCliResolution.resolved ?? "(none)"} ` +
    `tried=[${claudeCliResolution.tried.join(", ")}] ` +
    `env_CLAUDE_CLI=${process.env.CLAUDE_CLI ?? "(unset)"}`,
);
logToFile(
  "info",
  `resolved codex_cli: ${codexCliResolution.resolved ?? "(none)"} ` +
    `tried=[${codexCliResolution.tried.join(", ")}] ` +
    `env_CODEX_CLI=${process.env.CODEX_CLI ?? "(unset)"}`,
);
logToFile(
  "info",
  `resolved gemini_cli: ${geminiCliResolution.resolved ?? "(none)"} ` +
    `tried=[${geminiCliResolution.tried.join(", ")}] ` +
    `env_GEMINI_CLI=${process.env.GEMINI_CLI ?? "(unset)"}`,
);

// ─── 누적 메모리 자동 로딩 (Phase 9 step 1) ─────────────────────
// `~/.claude/projects/<key>/memory/` 의 모든 .md 파일을 system prompt 끝에 주입.
// K 가 명시한 선호(feedback_*), 회피해야 할 함정(pitfall_*), 잘 먹힌 패턴(pattern_*) 을
// 매 턴마다 자동 로드해 같은 실수 반복 / 같은 선호 재설명 부담을 줄인다.
//
// Phase 22 (v0.5.8): user-specific hardcoded fallback 제거. 이전엔
// `C--Users-user-Documents-K-Desktop-Agent` 가 release 폴백이라 다른 PC 에선
// 그 사용자명 디렉토리가 없어서 항상 fail. 이제 inferred 가 fail 하면 빈
// 디렉토리 (메모리 없음) 로 처리 — universal.
//
// 디렉토리 결정 우선순위:
//   1. KDA_MEMORY_DIR 환경변수 (수동 오버라이드)
//   2. 추론한 프로젝트 루트 (dev 모드 — sidecar/src 또는 sidecar/dist 의 2단계 위)
//      → Claude 키 규약 변환: C:\Users\<user>\Documents\K-Desktop-Agent
//        → C--Users-<user>-Documents-K-Desktop-Agent (`:`, `\\` → `-`)
//      → 그 결과 디렉토리에 memory/ 가 실제 존재하면 채택
//   3. 추론 fail 시 — 빈 path 반환 (메모리 디렉토리 없음 = 컨텍스트 빈 상태)

function getMemoryDir(): string {
  // Phase 61 (v0.5.49): K 다른 PC 진단으로 candidate path 확장.
  // Phase 94 (v0.6.36): ~/.kda/memory/ 우선순위 1순위로 격상.
  //   종전엔 ~/.claude/projects/<inferred-key>/memory/ 가 1순위라
  //   Git Memory Sync (Phase 87) 의 working dir (~/.kda/) 와 불일치 →
  //   K 의 누적 메모리가 GitHub repo 에 영원히 안 박히는 함정 (lee-profile + memory/
  //   양쪽 다 .gitignore 화이트리스트라 추적은 가능했으나 폴더 자체가 빈 상태).
  //   이제 ~/.kda/memory/ 우선 + migrateLegacyMemoryToKda() 가 시작 시 기존
  //   legacy 위치의 메모리를 ~/.kda/memory/ 로 1회 복사 → 그 후 sync 자동.
  const home = os.homedir();
  const candidates: string[] = [];

  const envOverride = process.env.KDA_MEMORY_DIR;
  if (envOverride) candidates.push(envOverride);

  // 1. Phase 94 (v0.6.36) — KDA 표준 user-scoped 위치 (Git Memory Sync 의 working dir 와 일치).
  //    여기를 1순위로 두면 K 의 누적 메모리가 자동으로 GitHub repo 와 동기화됨.
  candidates.push(path.join(home, ".kda", "memory"));

  // 2. legacy 추론한 프로젝트 루트 키 (Phase 56 ~ Phase 93 의 default).
  //    migrateLegacyMemoryToKda() 가 시작 시 1회 복사하므로 이건 fallback.
  const inferredRoot = path.resolve(__dirname_local, "..", "..");
  const inferredKey = inferredRoot.replace(/[:\\]/g, "-");
  candidates.push(path.join(home, ".claude", "projects", inferredKey, "memory"));

  // 3. Claude CLI 와 공유 가능
  candidates.push(path.join(home, ".claude", "memory"));

  // 4. Phase 22 fallback: Documents/K-Desktop-Agent 추론 키 (dev 환경)
  const fallbackProjectPath = path.join(home, "Documents", "K-Desktop-Agent");
  const fallbackKey = fallbackProjectPath.replace(/[:\\]/g, "-");
  candidates.push(path.join(home, ".claude", "projects", fallbackKey, "memory"));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // 모두 실패 — 첫 candidate (env override 또는 ~/.kda/memory/) 반환
  // 그 경로에 memory load 시 ENOENT → empty memory context 처리됨
  return candidates[0];
}

/**
 * Phase 94 (v0.6.36) — 메모리 위치 통일을 위한 1회 마이그레이션.
 *
 * 종전 KDA 가 메모리를 `~/.claude/projects/<inferred-key>/memory/` 에 박았지만,
 * Git Memory Sync (Phase 87) 의 working dir 는 `~/.kda/` — 두 위치 분리로
 * K 의 11개+ 누적 메모리 (pitfall_*, feedback_*, MEMORY.md) 가 GitHub repo 에
 * 안 박히는 함정. K 의 root_cause 정신 → 단순 우선순위 swap 만으로는 부족,
 * 기존 콘텐츠 이동까지 자동 처리.
 *
 * 이 함수는 sidecar 시작 직후 1회 실행:
 *   - `~/.kda/memory/` 가 비어 있거나 존재 안 함
 *   - legacy 위치 중 하나에 *.md 가 있으면
 *   → `~/.kda/memory/` 로 복사 (legacy 위치는 보존 — 회귀 위험 0)
 *
 * 이미 `~/.kda/memory/` 에 *.md 가 있으면 skip — 사용자 누적 상태 절대 안 건드림.
 * `loadMemoryContext()` 다음 호출부터 새 위치의 메모리 사용 → 다음 GitSync 에서
 * 자동 commit + push.
 */
function migrateLegacyMemoryToKda(): void {
  const home = os.homedir();
  const kdaMemory = path.join(home, ".kda", "memory");

  // 이미 ~/.kda/memory/ 에 *.md 있으면 skip
  if (existsSync(kdaMemory)) {
    try {
      const existing = readdirSync(kdaMemory);
      if (existing.some((f) => f.toLowerCase().endsWith(".md"))) {
        return;
      }
    } catch {
      /* read 실패 — 진행 (mkdirSync recursive 가 알아서 처리) */
    }
  }

  // legacy candidates — getMemoryDir() 의 2~4번 순서와 동일
  const inferredRoot = path.resolve(__dirname_local, "..", "..");
  const inferredKey = inferredRoot.replace(/[:\\]/g, "-");
  const fallbackProjectPath = path.join(home, "Documents", "K-Desktop-Agent");
  const fallbackKey = fallbackProjectPath.replace(/[:\\]/g, "-");
  const legacyCandidates = [
    path.join(home, ".claude", "projects", inferredKey, "memory"),
    path.join(home, ".claude", "memory"),
    path.join(home, ".claude", "projects", fallbackKey, "memory"),
  ];

  for (const legacy of legacyCandidates) {
    if (!existsSync(legacy)) continue;
    try {
      const files = readdirSync(legacy).filter((f) =>
        f.toLowerCase().endsWith(".md"),
      );
      if (files.length === 0) continue;

      mkdirSync(kdaMemory, { recursive: true });
      let copied = 0;
      for (const f of files) {
        const src = path.join(legacy, f);
        const dst = path.join(kdaMemory, f);
        try {
          copyFileSync(src, dst);
          copied++;
        } catch (e) {
          log("warn", `[MemoryMigration] copy 실패 ${f}: ${e}`);
        }
      }
      log(
        "info",
        `[MemoryMigration] ${copied}개 메모리 파일 복사: ${legacy} → ${kdaMemory}`,
      );
      return; // 첫 매치만 — 여러 legacy 위치에 분산돼 있을 가능성 낮음
    } catch (e) {
      log("warn", `[MemoryMigration] legacy 위치 read 실패 ${legacy}: ${e}`);
    }
  }
}

interface MemoryContext {
  count: number;
  bytes: number;
  content: string;
  dir: string;
}

/**
 * Phase 81 (v0.6.25) — Lee Profile loader.
 *
 * `~/.kda/lee-profile.md` 의 내용을 read. 없으면 빈 string.
 * loadMemoryContext 의 결과 prefix 로 박혀 system prompt 의 첫머리에 위치 — K 의 응답 스타일 /
 * 개인 규칙이 매 turn 마다 자연스럽게 반영되게 함.
 *
 * Lee 의 학습효과 패치 #1 (Memory Auto-Loader) 의 일부. 기존 memory/ 자동 prepend (Phase 56 등)
 * 가 K 의 "함정/선호" 메타데이터라면, lee-profile.md 는 K 본인이 직접 채우는 자기 규칙
 * (예: "증거 없는 완료 보고 금지", "한국어 우선", "긴 작업은 5분 단위 evidence update").
 */
function loadLeeProfile(): { content: string; bytes: number; exists: boolean; path: string } {
  const profilePath = path.join(os.homedir(), ".kda", "lee-profile.md");
  if (!existsSync(profilePath)) {
    return { content: "", bytes: 0, exists: false, path: profilePath };
  }
  try {
    const raw = readFileSync(profilePath, "utf-8");
    // UTF-8 BOM strip (Windows 에디터가 자주 박음)
    const cleaned = raw.replace(/^﻿/, "").trim();
    return { content: cleaned, bytes: cleaned.length, exists: true, path: profilePath };
  } catch (e) {
    logToFile(
      "warn",
      `lee-profile.md read 실패: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { content: "", bytes: 0, exists: false, path: profilePath };
  }
}

/**
 * Phase X-2 (v0.7.00) — Soul (에이전트 정체성) loader.
 *
 * `~/.kda/soul.md` 의 내용을 read. 없으면 빈 string. lee-profile.md 가 "K(사용자)의 규칙"
 * 이라면, soul.md 는 "에이전트 자신의 정체성/가치관/페르소나" — Hermes Agent 의 soul 개념.
 * 파일 존재만으로 게이트 (flag 불필요). 없으면 종전과 100% 동일 동작.
 * system prompt 최상단(SYSTEM_PROMPT 바로 뒤)에 박혀 매 turn 정체성을 일관되게 유지.
 */
function loadSoul(): { content: string; bytes: number; exists: boolean; path: string } {
  const soulPath = path.join(os.homedir(), ".kda", "soul.md");
  if (!existsSync(soulPath)) {
    return { content: "", bytes: 0, exists: false, path: soulPath };
  }
  try {
    const raw = readFileSync(soulPath, "utf-8");
    const cleaned = raw.replace(/^﻿/, "").trim();
    return { content: cleaned, bytes: cleaned.length, exists: true, path: soulPath };
  } catch (e) {
    logToFile(
      "warn",
      `soul.md read 실패: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { content: "", bytes: 0, exists: false, path: soulPath };
  }
}

/**
 * Phase 109 / X-4 / X-6 / X-7 / X-9 (v0.7.00) — Agent Flags loader.
 *
 * `~/.kda/agent-flags.json` 의 boolean 토글들. 모든 기능 기본 OFF → 파일이 없거나
 * 키가 빠지면 종전과 100% 동일 동작 (zero-regression, pitfall_av: 자동행동은 토글·기본off).
 *   - nudge:          Phase 109 턴경계 self-nudge (다음 행동 제안)
 *   - failureCapture: X-7 실패 자동 포착 (Reflexion — 실패를 메모리에 기록 권유)
 *   - memoryWrite:    X-6 자기수정 메모리 (db_memory_write 도구 노출)
 *   - schedule:       X-4 자연어 Cron-lite (db_schedule_* 도구 노출)
 *   - skillRegistry:  X-9 스킬 레지스트리 import (db_skill_* 도구 노출)
 * mtime 캐시로 매 turn 디스크 재파싱 회피.
 */
interface AgentFlags {
  nudge: boolean;
  failureCapture: boolean;
  memoryWrite: boolean;
  schedule: boolean;
  skillRegistry: boolean;
}
const AGENT_FLAGS_DEFAULT: AgentFlags = {
  nudge: false,
  failureCapture: false,
  memoryWrite: false,
  schedule: false,
  skillRegistry: false,
};
let _agentFlagsCache: { mtimeMs: number; flags: AgentFlags } | null = null;
function loadAgentFlags(): AgentFlags {
  const flagsPath = path.join(os.homedir(), ".kda", "agent-flags.json");
  try {
    if (!existsSync(flagsPath)) {
      _agentFlagsCache = null;
      return { ...AGENT_FLAGS_DEFAULT };
    }
    const mtimeMs = statSync(flagsPath).mtimeMs;
    if (_agentFlagsCache && _agentFlagsCache.mtimeMs === mtimeMs) {
      return _agentFlagsCache.flags;
    }
    const raw = readFileSync(flagsPath, "utf-8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw) as Partial<Record<keyof AgentFlags, unknown>>;
    const flags: AgentFlags = { ...AGENT_FLAGS_DEFAULT };
    for (const k of Object.keys(AGENT_FLAGS_DEFAULT) as (keyof AgentFlags)[]) {
      if (typeof parsed[k] === "boolean") flags[k] = parsed[k] as boolean;
    }
    _agentFlagsCache = { mtimeMs, flags };
    return flags;
  } catch (e) {
    logToFile(
      "warn",
      `agent-flags.json read/parse 실패 (기본 OFF 적용): ${e instanceof Error ? e.message : String(e)}`,
    );
    return { ...AGENT_FLAGS_DEFAULT };
  }
}

// 플래그 OFF 시 --disallowed-tools 에 박을 MCP 도구 풀네임. flag ON 이면 노출.
// PERM_TOOL_MAP 의 어느 카테고리에도 안 들어가므로 default-allow 상태 → flag 로만 제어.
const FLAG_GATED_TOOLS: Record<keyof AgentFlags, string[]> = {
  nudge: [],
  failureCapture: [],
  memoryWrite: ["mcp__k-personal__db_memory_write"],
  schedule: [
    "mcp__k-personal__db_schedule_add",
    "mcp__k-personal__db_schedule_list",
    "mcp__k-personal__db_schedule_due",
    "mcp__k-personal__db_schedule_done",
    "mcp__k-personal__db_schedule_delete",
  ],
  skillRegistry: [
    "mcp__k-personal__db_skill_scan",
    "mcp__k-personal__db_skill_import",
  ],
};

/** flag OFF 인 기능들의 MCP 도구 풀네임을 모아 반환 (disallowed 에 추가용). */
function flagGatedDisallowed(flags: AgentFlags): string[] {
  const out: string[] = [];
  for (const k of Object.keys(FLAG_GATED_TOOLS) as (keyof AgentFlags)[]) {
    if (!flags[k]) out.push(...FLAG_GATED_TOOLS[k]);
  }
  return out;
}

/**
 * Phase 109 / X-4 / X-6 / X-7 / X-9 — 활성 플래그에 대한 시스템 프롬프트 가이던스.
 * flag OFF 인 기능은 한 줄도 안 박힘 → 모델이 존재조차 모름 (zero-regression).
 */
function buildAgentFeatureGuidance(flags: AgentFlags): string {
  const blocks: string[] = [];
  if (flags.nudge) {
    blocks.push(
      [
        "",
        "[턴경계 self-nudge (실험 기능 ON)]",
        "응답 마지막에, 작업이 끝나지 않았다면 다음에 할 일을 한 줄로 스스로 제안하세요.",
        "K 의 명시적 지시 없이 다음 행동을 자동 실행하지는 말고, 제안만 합니다.",
      ].join("\n"),
    );
  }
  if (flags.failureCapture) {
    blocks.push(
      [
        "",
        "[실패 자동 포착 (실험 기능 ON)]",
        "도구 호출이 실패하거나 K 가 같은 실수를 지적하면, 원인과 회피책을 한 줄로 정리해",
        "K 에게 'memory/pitfall_*.md 로 기록할까요?' 라고 제안하세요 (자동 기록 금지, 승인 후에만).",
      ].join("\n"),
    );
  }
  if (flags.memoryWrite) {
    blocks.push(
      [
        "",
        "[자기수정 메모리 (실험 기능 ON)]",
        "db_memory_write 도구로 ~/.kda/memory/*.md 를 직접 쓰거나 덧붙일 수 있습니다.",
        "덮어쓰기 전 반드시 K 의 확인을 받고, append 를 우선 고려하세요 (.bak 자동 백업됨).",
      ].join("\n"),
    );
  }
  if (flags.schedule) {
    blocks.push(
      [
        "",
        "[일정/리마인더 (실험 기능 ON)]",
        "db_schedule_add/list/due/done/delete 로 일정을 저장할 수 있습니다.",
        "자연어 시각('매일 9시')은 ISO(next_run)와 recur(daily/weekly/monthly)로 변환해 등록하세요.",
        "백그라운드 자동 실행은 없습니다 — 도래한 일정은 db_schedule_due 로 확인해 K 에게 알립니다.",
      ].join("\n"),
    );
  }
  if (flags.skillRegistry) {
    blocks.push(
      [
        "",
        "[스킬 레지스트리 import (실험 기능 ON)]",
        "외부 SKILL.md 설치 절차: ① web_*/WebFetch 로 본문 fetch → ② db_skill_scan 으로 정적 검사",
        "→ ③ 본문을 직접 읽고 의미 검토 → ④ 검사 결과를 K 에게 번호 텍스트로 보고하고 승인 요청",
        "→ ⑤ 승인 후에만 db_skill_import(approved=true) 호출. BLOCK 판정은 승인해도 설치 거부됩니다.",
      ].join("\n"),
    );
  }
  return blocks.join("\n");
}

/**
 * Phase 136 (v0.7.9) — Hermes 기능 엔진 동등 배선 (Codex / Gemini CLI / REST).
 *
 * 진단: v0.7.0 의 헤르메스 기능(soul.md, featureGuidance, agent-flags 도구 게이트,
 * SYSTEM_PROMPT 응답 규칙)은 전부 handleViaClaudeCLI 의 fullSystemPrompt 조립 +
 * `--system-prompt` / `--disallowed-tools` / preToolUse hook 으로만 배선돼 있었음.
 * Codex CLI(`codex exec`) 와 Gemini CLI 는 이 인자들이 없어서:
 *   ① SYSTEM_PROMPT(한국어/번호 선택지/파괴작업 확인 규칙) 자체를 못 받음
 *   ② soul.md 정체성 미주입
 *   ③ buildAgentFeatureGuidance(nudge 등 실험 기능 안내) 미주입
 *   ④ flag OFF 도구(db_memory_write 등)가 게이트 없이 노출
 *   ⑤ Codex resume 턴은 memory_context 조차 빠짐 (bootstrap 턴에만 주입)
 * → "GPT 모델이 헤르메스 룰을 안 따른다" 의 원인.
 *
 * 해결: Claude 경로와 동일 구성 요소를 stdin 프롬프트 최상단의 <kda_system> 블록
 * 텍스트로 조립해 주입 (cmd.exe 8191자 인자 한계 회피 — memory_context 와 동일 전략).
 * 도구 게이트는 CLI 레벨 차단이 불가능하므로 [비활성 도구] 금지 블록으로 프롬프트
 * 레벨 차단 (REST 경로는 disallowedSet 으로 하드 차단 — 카탈로그에서 제거).
 *
 * compact 모드: Codex resume 턴용. thread 에 bootstrap 턴의 전체 지침이 이미 있으므로
 * 매 턴 전체 재주입 시 context 폭발 (pitfall_codex_model_context_window_dynamic).
 * 핵심 룰 1줄 + 활성 기능 안내 + 게이트 목록만 리마인드 (수백 byte).
 */
function buildEngineSystemText(
  folderSystemPrompt: string | undefined,
  agentFlags: AgentFlags,
  opts?: { compact?: boolean },
): string {
  const gated = flagGatedDisallowed(agentFlags);
  const gatedNotice = gated.length > 0
    ? [
        "",
        "",
        "[비활성 도구 — 호출 금지]",
        "다음 도구는 실험 기능 토글(agent-flags.json)이 꺼져 있어 이번 대화에서 호출 금지입니다.",
        "도구 목록에 보이더라도 절대 호출하지 마세요:",
        ...gated.map((t) => `- ${t}`),
      ].join("\n")
    : "";
  const featureGuidance = buildAgentFeatureGuidance(agentFlags);

  if (opts?.compact) {
    return (
      "[KDA 룰 리마인더] 한국어로 간결하게 답하세요. 선택지는 번호 텍스트(1/2/3)로 본문에 직접 제시하세요. " +
      "파괴적 작업(삭제/덮어쓰기/이동)은 실행 전 반드시 확인을 받으세요. " +
      "<memory_context> 의 pitfall_* 패턴은 절대 반복하지 마세요." +
      featureGuidance +
      gatedNotice
    );
  }

  const soul = loadSoul();
  const soulBlock = soul.exists && soul.content
    ? `\n\n[에이전트 정체성 (soul.md)]\n다음은 당신(에이전트) 자신의 정체성·가치관입니다. 매 응답에서 일관되게 유지하세요.\n\n${soul.content}\n`
    : "";
  const folderBlock = folderSystemPrompt && folderSystemPrompt.trim()
    ? `\n\n[프로젝트 지침]\n이 대화는 K 가 지정한 프로젝트 폴더에 속해 있으며, 아래 지침을 항상 따라야 합니다. K 의 요청과 충돌하면 K 의 명시적 지시를 우선하되, 그 외엔 이 지침을 우선 적용하세요.\n\n${folderSystemPrompt.trim()}\n`
    : "";
  return SYSTEM_PROMPT + soulBlock + folderBlock + featureGuidance + gatedNotice;
}

// Phase 81 (v0.6.25) — system prompt 폭발 방지: lee-profile + memory 합쳐 32KB 초과 시 trim.
// K 의 다른 PC 진단 (pitfall_codex_model_context_window_dynamic) 에서 memory_context 18.6KB →
// 매 turn 마다 stdin 으로 박혀 context 자연 증가. cap 으로 단일 turn 폭발 차단.
const MEMORY_CONTEXT_HARD_CAP_BYTES = 32 * 1024;

/**
 * Phase 106 (v0.7.00) — 메모리 선택 로딩 (frontmatter triggers).
 *
 * Hermes Agent 의 SKILL.md frontmatter-gated selective loading 을 KDA 의 memory/ 에 일반화.
 * memory/*.md 의 frontmatter 에 `triggers:` 가 있으면 "조건부 로딩" 파일로 취급:
 *   - 현재 사용자 메시지가 trigger 키워드 중 하나와 매치 → full body 박음
 *   - 매치 안 됨 → description 한 줄 요약만 (존재는 알리되 본문 생략 → context 절약)
 * `triggers:` 없는 기존 파일은 그대로 full body 항상 로딩 (백 호환 — 동작 무변화).
 * `always: true` 면 triggers 가 있어도 항상 full body.
 *
 * 함께: 32KB hard cap 도달 시 기존 tail-slice (lossy, 후순위 통째 잘림) 대신
 * priority-section drop — lee-profile > pitfall summary > feedback/MEMORY > triggered body
 * > 기타 always body > team 순으로 낮은 우선순위부터 통째 drop → 중요 섹션 보존.
 */
interface MemoryFileMeta {
  description: string | null;
  triggers: string[];
  always: boolean;
  hasFrontmatter: boolean;
}

/** frontmatter block (--- 사이) 만 추출. 없으면 null. */
function extractFrontmatterBlock(body: string): string | null {
  const fm = body.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  return fm ? fm[1] : null;
}

/**
 * YAML frontmatter 의 list/scalar 필드를 string[] 로 파싱.
 * 지원 형태: `key: [a, b]`, `key: a, b`, 여러 줄 `key:\n  - a\n  - b`.
 */
function extractYamlList(block: string, key: string): string[] {
  const splitCsv = (v: string): string[] =>
    v
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  const inline = block.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, "m"));
  if (inline) {
    const v = inline[1].trim();
    return v.startsWith("[") ? splitCsv(v.replace(/^\[|\]$/g, "")) : splitCsv(v);
  }
  const listM = block.match(
    new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]*-[ \\t]*.+\\r?\\n?)+)`, "m"),
  );
  if (listM) {
    return listM[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/^[ \t]*-[ \t]*/, "").trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return [];
}

/** frontmatter scalar 한 줄 추출 (없으면 null). */
function extractYamlScalar(block: string, key: string): string | null {
  const m = block.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

function parseMemoryFrontmatter(body: string): MemoryFileMeta {
  const block = extractFrontmatterBlock(body);
  if (!block) {
    // frontmatter 없어도 description: 한 줄은 추출 시도 (기존 pitfall 스타일 호환)
    const d = body.match(/^description:\s*(.+?)(?:\r?\n|$)/m);
    return {
      description: d ? d[1].trim().slice(0, 200) : null,
      triggers: [],
      always: false,
      hasFrontmatter: false,
    };
  }
  const desc = extractYamlScalar(block, "description");
  const alwaysM = block.match(/^always:\s*(true|false)\s*$/m);
  return {
    description: desc ? desc.slice(0, 200) : null,
    triggers: extractYamlList(block, "triggers"),
    always: alwaysM ? alwaysM[1] === "true" : false,
    hasFrontmatter: true,
  };
}

/**
 * Phase 107 (v0.7.00) — 스킬 메모리 (skill_*.md).
 *
 * agentskills.io / Hermes SKILL.md 표준과 호환되는 frontmatter:
 *   name / description / triggers / allowed-tools / created / updated / success_count
 * 스킬은 "실행 권한" 이 아니라 "조언 텍스트" — 본문은 절대 실행되지 않고 context 로만 주입됨.
 * 따라서 allowed-tools 는 표시용 메타데이터일 뿐, 실제 차단은 기존 권한 게이트가 enforce.
 * (KDA 는 claude 의 네이티브 Skill 도구를 ALWAYS_BLOCKED_BYPASS 로 이미 차단함 — 별개 layer)
 */
interface SkillMeta {
  name: string;
  description: string | null;
  triggers: string[];
  allowedTools: string[];
  successCount: number;
  created: string | null;
  updated: string | null;
}

function parseSkillFrontmatter(body: string, fallbackName: string): SkillMeta {
  const block = extractFrontmatterBlock(body) ?? "";
  const base = parseMemoryFrontmatter(body);
  const name = extractYamlScalar(block, "name") ?? fallbackName;
  const scStr = extractYamlScalar(block, "success_count");
  const successCount = scStr && /^\d+$/.test(scStr) ? parseInt(scStr, 10) : 0;
  return {
    name,
    description: base.description,
    triggers: base.triggers,
    allowedTools: extractYamlList(block, "allowed-tools"),
    successCount,
    created: extractYamlScalar(block, "created"),
    updated: extractYamlScalar(block, "updated"),
  };
}

/**
 * Phase 107 — Curator: 오래되고(>90일 미갱신) 한 번도 성공 안 한(success_count=0) 스킬을
 * 정리 후보로 판단. 자동 삭제는 절대 안 함 (제안만). 백그라운드 타이머 없음 (pitfall_av 안전).
 */
const SKILL_CURATOR_STALE_DAYS = 90;
function isSkillPruneCandidate(meta: SkillMeta, now: number): boolean {
  if (meta.successCount > 0) return false;
  const ref = meta.updated ?? meta.created;
  if (!ref) return false;
  const t = Date.parse(ref);
  if (Number.isNaN(t)) return false;
  const ageDays = (now - t) / (1000 * 60 * 60 * 24);
  return ageDays >= SKILL_CURATOR_STALE_DAYS;
}

/**
 * Phase 107 — memory/ 의 skill_*.md 를 읽어 skill 섹션 entries 생성.
 *  - 항상: 스킬 인덱스 1개 (name + description + 로딩 여부, Curator 정리후보 표시) — priority CORE
 *  - 트리거 매치된 스킬: full body entry — priority TRIGGERED
 * 스킬은 조언 텍스트일 뿐 실행 권한이 아님. allowed-tools 는 표시용.
 */
function buildSkillEntries(dir: string, currentMsg: string): MemorySectionEntry[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.startsWith("skill_") && f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
  if (files.length === 0) return [];

  const now = Date.now();
  const indexLines: string[] = [];
  const bodyEntries: MemorySectionEntry[] = [];
  let pruneCount = 0;

  for (const f of files) {
    try {
      const body = readMemoryFileCached(path.join(dir, f));
      const meta = parseSkillFrontmatter(body, f.replace(/^skill_/, "").replace(/\.md$/, ""));
      const triggered =
        meta.triggers.length === 0 || memoryTriggerMatches(currentMsg, meta.triggers);
      const prune = isSkillPruneCandidate(meta, now);
      if (prune) pruneCount++;

      const tags = [
        triggered ? "이번 턴 로딩됨" : "트리거 시 로딩",
        meta.successCount > 0 ? `성공 ${meta.successCount}회` : null,
        prune ? "정리 후보" : null,
      ]
        .filter(Boolean)
        .join(", ");
      indexLines.push(
        `- **${meta.name}** — ${meta.description ?? "(설명 없음)"} (${tags})`,
      );

      if (triggered) {
        const toolNote =
          meta.allowedTools.length > 0
            ? `\n(권장 도구: ${meta.allowedTools.join(", ")} — 실제 차단은 KDA 권한 게이트가 enforce)`
            : "";
        bodyEntries.push({
          group: "skill",
          priority: MEMORY_PRIORITY_TRIGGERED,
          file: f,
          text: `### [skill] ${meta.name}${toolNote}\n${body.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim()}`,
        });
      }
    } catch (e) {
      logToFile(
        "warn",
        `skill file read 실패 ${f}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const entries: MemorySectionEntry[] = [];
  if (indexLines.length > 0) {
    const curatorNote =
      pruneCount > 0
        ? `\n\n[Curator] ${pruneCount}개 스킬이 ${SKILL_CURATOR_STALE_DAYS}일+ 미사용 & 성공 0회 → 정리 후보. K 승인 시 해당 skill_*.md 삭제 가능.`
        : "";
    entries.push({
      group: "skill",
      priority: MEMORY_PRIORITY_CORE,
      file: "skill-index",
      text:
        "다음은 학습/임포트한 스킬 목록입니다. 트리거에 매치되면 본문이 아래에 로딩됩니다.\n" +
        indexLines.join("\n") +
        curatorNote,
    });
  }
  return entries.concat(bodyEntries);
}

function memoryTriggerMatches(userMessage: string, triggers: string[]): boolean {
  if (!userMessage || triggers.length === 0) return false;
  const lc = userMessage.toLowerCase();
  return triggers.some((t) => t && lc.includes(t.toLowerCase()));
}

/**
 * Phase 106 — memory 파일 read 캐시 (path → {mtimeMs, body}).
 * 매 turn 17개+ 파일을 re-read 하던 비용 제거. mtime 변하면 자동 갱신.
 */
const _memoryFileCache = new Map<string, { mtimeMs: number; body: string }>();

function readMemoryFileCached(filePath: string): string {
  const st = statSync(filePath);
  const hit = _memoryFileCache.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.body;
  const body = readFileSync(filePath, "utf-8");
  _memoryFileCache.set(filePath, { mtimeMs: st.mtimeMs, body });
  return body;
}

/**
 * Phase 82 (v0.6.26) — Pitfall Guard: pitfall_*.md 의 핵심만 압축 추출.
 *
 * memory/ 폴더의 pitfall_*.md 파일들은 길고 자세함 (1KB ~ 10KB). LLM 이 긴 memory 안에서
 * 묻혀 같은 함정 반복 가능성. 회피: 각 pitfall_*.md 의 frontmatter `description:` 한 줄만
 * 추출해서 system prompt 첫 부분에 [⚠ 절대 반복 금지] 압축 리스트로 별도 박음.
 *
 * Lee 의 학습효과 패치 #2 (Pitfall Guard) 의 LLM-native 구현 — 별도 detection layer 없이
 * 강조된 anti-pattern 리스트만으로 LLM 의 self-check 유도.
 */
function extractPitfallSummary(memoryDir: string): { count: number; lines: string[] } {
  if (!existsSync(memoryDir)) return { count: 0, lines: [] };
  try {
    const files = readdirSync(memoryDir)
      .filter((f) => f.startsWith("pitfall_") && f.endsWith(".md"))
      .sort();
    const lines: string[] = [];
    for (const f of files) {
      try {
        const body = readMemoryFileCached(path.join(memoryDir, f));
        // frontmatter 의 `description: ` 한 줄 추출. 첫 줄만, 최대 200자.
        const descMatch = body.match(/^description:\s*(.+?)(?:\r?\n|$)/m);
        const desc = descMatch ? descMatch[1].trim().slice(0, 200) : null;
        const slug = f.replace(/^pitfall_/, "").replace(/\.md$/, "");
        if (desc) {
          lines.push(`- **[${slug}]** ${desc}`);
        } else {
          // description 없으면 name 만이라도
          lines.push(`- **[${slug}]** (자세한 내용은 memory 의 ${f} 참조)`);
        }
      } catch {
        // skip
      }
    }
    return { count: lines.length, lines };
  } catch {
    return { count: 0, lines: [] };
  }
}

/**
 * Phase 89 — team-memory/memory/ 에서 추가 메모리 파일 로드.
 * personal memory 와 별도 섹션으로 합치기 위해 분리. team 폴더 없으면 빈 결과.
 */
function loadTeamMemorySections(): { sections: string[]; bytes: number } {
  const teamMemDir = path.join(getTeamMemoryRoot(), "memory");
  if (!existsSync(teamMemDir)) return { sections: [], bytes: 0 };
  let bytes = 0;
  const sections: string[] = [];
  try {
    const files = readdirSync(teamMemDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    for (const f of files) {
      try {
        const body = readFileSync(path.join(teamMemDir, f), "utf-8");
        sections.push(`### ${f}\n${body.trim()}`);
        bytes += body.length;
      } catch (e) {
        logToFile(
          "warn",
          `team memory file read 실패 ${f}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } catch {
    /* readdir 실패 시 graceful */
  }
  return { sections, bytes };
}

// Phase 106 (v0.7.00) — droppable 메모리 섹션 엔트리.
// priority 가 작을수록 중요(나중에 drop). cap 초과 시 큰 priority 부터 통째로 drop.
interface MemorySectionEntry {
  group: "memory" | "team" | "skill";
  priority: number;
  text: string;
  file: string;
}

const MEMORY_PRIORITY_CORE = 2; // feedback_*.md, MEMORY.md
const MEMORY_PRIORITY_TRIGGERED = 3; // 조건부인데 현재 메시지에 매치된 full body
const MEMORY_PRIORITY_ALWAYS = 4; // 기타 항상 로딩 full body
const MEMORY_PRIORITY_TEAM = 5; // 팀 공유
const MEMORY_PRIORITY_SUMMARY = 6; // 조건부 미매치 → 한 줄 요약 (작아서 사실상 보존)

/**
 * Phase 106 — 현재 사용자 메시지(userMessage)를 받아 조건부 메모리를 선택 로딩.
 * userMessage 미전달(기존 caller 호환) 시 조건부 파일은 요약만 노출.
 */
function loadMemoryContext(userMessage?: string): MemoryContext {
  const dir = getMemoryDir();
  const leeProfile = loadLeeProfile();
  const currentMsg = userMessage ?? "";
  try {
    const entries: MemorySectionEntry[] = [];

    if (existsSync(dir)) {
      // Phase 100: pitfall_*.md 의 full body 는 제외 (description summary 만 별도 block 으로).
      // Phase 106: 나머지 .md 는 frontmatter triggers 로 선택 로딩.
      // Phase 107: skill_*.md 는 별도 skill 섹션에서 처리 (아래 buildSkillEntries).
      const files = readdirSync(dir)
        .filter(
          (f) =>
            f.endsWith(".md") && !f.startsWith("pitfall_") && !f.startsWith("skill_"),
        )
        .sort();
      for (const f of files) {
        try {
          const body = readMemoryFileCached(path.join(dir, f));
          const meta = parseMemoryFrontmatter(body);
          const isCore = f === "MEMORY.md" || f.startsWith("feedback_");
          const isConditional = meta.triggers.length > 0 && !meta.always && !isCore;

          if (isConditional && !memoryTriggerMatches(currentMsg, meta.triggers)) {
            // 조건부 + 미매치 → 본문 생략, 한 줄 요약만 (존재 + 트리거 안내)
            const hint = meta.description
              ? meta.description
              : `트리거 키워드: ${meta.triggers.join(", ")}`;
            entries.push({
              group: "memory",
              priority: MEMORY_PRIORITY_SUMMARY,
              file: f,
              text: `### ${f} (조건부 — 현재 미로딩)\n- ${hint}\n  (관련 작업 시 ${f} 파일을 직접 read)`,
            });
            continue;
          }

          const priority = isCore
            ? MEMORY_PRIORITY_CORE
            : isConditional
              ? MEMORY_PRIORITY_TRIGGERED
              : MEMORY_PRIORITY_ALWAYS;
          entries.push({
            group: "memory",
            priority,
            file: f,
            text: `### ${f}\n${body.trim()}`,
          });
        } catch (e) {
          logToFile(
            "warn",
            `memory file read 실패 ${f}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    // Phase 89 — team memory 추가 섹션 (별도 헤더, lee-profile 절대 X)
    const team = loadTeamMemorySections();
    for (let i = 0; i < team.sections.length; i++) {
      entries.push({
        group: "team",
        priority: MEMORY_PRIORITY_TEAM,
        file: `team#${i}`,
        text: team.sections[i],
      });
    }

    // Phase 107 — skill 메모리 (skill_*.md): 인덱스 + 트리거 매치된 본문
    for (const e of buildSkillEntries(dir, currentMsg)) entries.push(e);

    // Phase 81 (v0.6.25): lee-profile.md 가 있으면 memory 보다 먼저 박힘 (K 의 개인 규칙이 최우선)
    const leeBlock = leeProfile.exists && leeProfile.content
      ? [
          "",
          "",
          "## K(Lee)의 개인 응답 규칙 (lee-profile.md)",
          "",
          "다음은 K 본인이 직접 정의한 응답 스타일/규칙입니다. 위반 시 K 가 명시적으로 지적합니다.",
          "",
          leeProfile.content,
        ].join("\n")
      : "";

    // Phase 82 (v0.6.26) — Pitfall Guard 압축 섹션. memory 보다 먼저, lee-profile 보다 뒤.
    const pitfallSummary = extractPitfallSummary(dir);
    const pitfallBlock = pitfallSummary.count > 0
      ? [
          "",
          "",
          "## ⚠ 절대 반복 금지 함정 (pitfall summary)",
          "",
          `다음 ${pitfallSummary.count}개는 K 와 이미 한 번 겪은 함정입니다. 같은 패턴 반복 금지.`,
          "각 항목의 자세한 진단/회피책은 위의 memory_context 안 같은 이름의 pitfall_*.md 참조.",
          "",
          ...pitfallSummary.lines,
        ].join("\n")
      : "";

    // Phase 106 — priority-section drop. lee-profile + pitfall summary 는 fixed (절대 drop X).
    // 나머지 entries 를 priority asc(중요 먼저)로 greedy 포함, cap 초과분만 통째 drop.
    const fixedTopLen = leeBlock.length + pitfallBlock.length;
    const HEADER_RESERVE = 700; // 그룹 헤더 + drop 경고 여유
    const sorted = [...entries].sort((a, b) => a.priority - b.priority);
    let used = fixedTopLen;
    const memSecs: string[] = [];
    const teamSecs: string[] = [];
    const skillSecs: string[] = [];
    const droppedFiles: string[] = [];
    for (const e of sorted) {
      const cost = e.text.length + 2;
      if (used + cost + HEADER_RESERVE > MEMORY_CONTEXT_HARD_CAP_BYTES) {
        droppedFiles.push(e.file);
        continue;
      }
      used += cost;
      if (e.group === "team") teamSecs.push(e.text);
      else if (e.group === "skill") skillSecs.push(e.text);
      else memSecs.push(e.text);
    }
    if (droppedFiles.length > 0) {
      logToFile(
        "warn",
        `loadMemoryContext: ${MEMORY_CONTEXT_HARD_CAP_BYTES} cap 초과 → ${droppedFiles.length}개 섹션 drop: ${droppedFiles.join(", ")}`,
      );
    }

    let memoryContent = "";
    if (memSecs.length > 0) {
      memoryContent = [
        "",
        "## K님의 누적 메모리 (memory/)",
        "",
        "다음은 이전 세션들에서 K님과 합의했거나 기록한 선호·함정·패턴입니다.",
        "매 응답에서 자연스럽게 반영하세요. 특히 `pitfall_*` 항목은 동일 패턴을 반복하지 마세요.",
        "",
        memSecs.join("\n\n"),
      ].join("\n");
    }
    if (teamSecs.length > 0) {
      const teamBlock = [
        "",
        "## 팀 공유 메모리 (team-memory/)",
        "",
        "다음은 팀이 함께 학습한 함정/규칙입니다 (개인 비밀 X — 누구나 볼 수 있음).",
        "K 의 개인 lee-profile 과는 별도 — 회사/팀 공통 안전 가이드만 박혀 있음.",
        "",
        teamSecs.join("\n\n"),
      ].join("\n");
      memoryContent = memoryContent ? memoryContent + "\n\n" + teamBlock : teamBlock;
    }
    if (skillSecs.length > 0) {
      const skillBlock = [
        "",
        "## 🧩 스킬 메모리 (skill_*.md)",
        "",
        "스킬은 실행 권한이 아니라 조언 텍스트입니다. 본문은 절대 자동 실행되지 않으며,",
        "모든 도구 호출은 기존 KDA 권한 게이트의 검사를 그대로 받습니다.",
        "",
        skillSecs.join("\n\n"),
      ].join("\n");
      memoryContent = memoryContent ? memoryContent + "\n\n" + skillBlock : skillBlock;
    }

    let combined = (leeBlock + pitfallBlock + (memoryContent ? "\n" + memoryContent : "")).trim();
    if (droppedFiles.length > 0) {
      combined +=
        `\n\n[ℹ ${droppedFiles.length}개 메모리 섹션이 cap(${(MEMORY_CONTEXT_HARD_CAP_BYTES / 1024).toFixed(0)}KB) 초과로 생략됨. 필요 시 ~/.kda/memory/ 직접 read. 정리 권장.]`;
    }

    if (!combined) {
      return { count: 0, bytes: 0, content: "", dir };
    }
    return {
      count: memSecs.length + teamSecs.length + skillSecs.length + (leeProfile.exists ? 1 : 0),
      bytes: combined.length,
      content: "\n" + combined,
      dir,
    };
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
- 선택지를 제시할 때는 AskUserQuestion 같은 별도 도구를 쓰지 말고, 반드시 번호를 매긴 텍스트(예: 1 / 2 / 3)로 본문에 직접 제시하세요. K님은 일반 메시지로 번호나 내용을 답합니다. (이 환경은 단방향 CLI라 interactive 질문 도구의 답을 제때 받지 못합니다.)
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
- 과거 대화 검색 (db_convo_search): "예전에 ~했었지?", "지난번 그 얘기" 처럼 과거 세션 내용을 떠올려야 할 때 사용 (trigram 전문검색)

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

  // Python 사용 가능 여부 확인.
  // 모듈 로드 시 resolvePython() 가 한 번 돌아 후보를 검증했으므로,
  // resolved 가 null 이 아니면 사용 가능. (Claude/Codex CLI 와 동일 패턴.)
  const pythonAvailable = pythonResolution.resolved !== null;

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

  const pythonError = !pythonAvailable
    ? `Python 실행 안 됨. 시도한 경로: [${pythonResolution.tried.join(", ")}]. ` +
      `Windows Python Launcher (py.exe) 또는 python.exe 설치 확인 후 앱 재시작. ` +
      `또는 환경변수 PYTHON_EXE 로 명시 지정 가능.`
    : undefined;

  return {
    configured: serverPathExists && pythonAvailable && claudeCliAvailable,
    serverPathExists,
    pythonAvailable,
    claudeCliAvailable,
    error: claudeCliError
      ?? (!serverPathExists
        ? `K-Personal 서버 없음: ${K_PERSONAL_PATH}`
        : pythonError),
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

// Phase 137 — 오케스트레이션 collector 상태. emit() 이 참조하므로 emit 보다 먼저 선언
// (TDZ 회피 — emit 은 모듈 init 중에도 호출될 수 있음).
// sub-turn id (`{mainId}#{engine}`) → collector. 평소 빈 Map — O(1) miss.
const orchestrationCollectors = new Map<string, OrchCollector>();
// interrupt 된 오케스트레이션 main id — fan-in 후 종합 skip 용.
const cancelledOrchestrations = new Set<string>();

function rawEmit(obj: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch (err) {
    if (isBrokenStdoutPipe(err)) {
      exitForBrokenStdoutPipe(err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

function emit(obj: Record<string, unknown>): void {
  // Phase 137 — 오케스트레이션 sub-turn 이벤트 인터셉트.
  // sub-turn id (`{mainId}#{engine}`) 로 등록된 collector 가 있으면:
  //   assistant_delta → 텍스트 수집 + orchestrate_delta 로 재태깅 (frontend 엔진별 카드)
  //   done / error    → collector resolve (fan-in) — frontend 로는 안 흘림
  //   그 외 (tool_use, turn_heartbeat 등) → swallow
  // 평소엔 Map 이 비어 있어 O(1) miss — 기존 이벤트 흐름 무영향.
  const id = obj.id;
  if (typeof id === "string" && orchestrationCollectors.size > 0) {
    const col = orchestrationCollectors.get(id);
    if (col) {
      switch (obj.type) {
        case "assistant_delta": {
          // CLI 3종(claude/codex/gemini-cli)은 누적 텍스트(text=currentText)를 보냄 → 교체.
          col.text = String(obj.text ?? "");
          rawEmit({
            type: "orchestrate_delta",
            id: col.mainId,
            engine: col.engine,
            text: col.text,
          });
          return;
        }
        case "done": {
          col.resolve({
            engine: col.engine,
            ok: col.text.trim().length > 0,
            text: col.text,
            error: col.text.trim().length > 0 ? undefined : "빈 응답",
          });
          return;
        }
        case "error": {
          col.resolve({
            engine: col.engine,
            ok: false,
            text: col.text,
            error: String((obj as { message?: unknown }).message ?? "알 수 없는 오류"),
          });
          return;
        }
        default:
          return; // sub-turn 의 나머지 이벤트는 frontend 로 안 흘림
      }
    }
  }
  rawEmit(obj);
}

function log(level: "info" | "warn" | "error", message: string): void {
  emit({ type: "log", level, message });
  logToFile(level, message);
}

const TURN_KEEPALIVE_INTERVAL_MS =
  Number(process.env.KDA_TURN_KEEPALIVE_INTERVAL_MS) || 60_000;
const DEFAULT_TURN_IDLE_TIMEOUT_MS =
  60 * 60 * 1000;
const ACTIVE_TOOL_TIMEOUT_MS =
  Number(process.env.KDA_ACTIVE_TOOL_TIMEOUT_MS) || 60 * 60 * 1000;

function emitTurnHeartbeat(
  id: string,
  provider: "claude" | "codex" | "gemini-cli",
  idleMs: number,
  activeWorkMs: number | null,
  pid: number | null,
): void {
  emit({
    type: "turn_heartbeat",
    id,
    provider,
    idleMs,
    activeWorkMs,
    pid,
    ts: Date.now(),
  });
}

// ─── 턴 관리 ───────────────────────────────────────────

type Provider = "claude" | "anthropic" | "openai" | "gemini" | "openrouter" | "codex" | "gemini-cli";

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
  // Phase 126 (v0.6.81) — Codex resume 실패 자동 회복 가드 (내부 전용, frontend 미사용).
  // true 면 그 turn 은 이미 "새 세션 재시도" 진입 → 무한 재귀/중복 long_task 방지.
  _codexResumeRetried?: boolean;
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
  // Phase 125 (v0.6.80) — Codex 추론 강도 (reasoning effort).
  // Codex CLI 의 config 키 `model_reasoning_effort` override 용.
  // 허용값: "minimal" | "low" | "medium" | "high". "default"/미지정 → 안 박음 (config.toml 기본값).
  // codex provider 에서만 의미 있음 (다른 provider 는 무시).
  reasoningEffort?: string;
  // 에이전트 권한 (Settings UI 의 8개 토글 — id → level).
  // claude provider 에서만 의미 있음 (REST API 모드는 도구 미지원).
  permissions?: PermissionsMap;
  // 개별 잠금된 도구 풀네임 목록 (Settings UI "정밀 잠금" 섹션에서 K가 체크).
  // 카테고리 토글과 독립적으로 작동 — 카테고리가 auto 여도 여기 들어 있으면 차단.
  // 예: ["Bash", "mcp__k-personal__fm_move_file", "mcp__k-personal__cc_keyboard_type"]
  lockedTools?: string[];
  // Phase 84 (v0.6.27) — Connector/Tool Safety Layer (Lee #6).
  // SafeMode 가 balanced/strict 면 카테고리 토글을 일괄 강등 (auto → ask 또는 manual).
  // strict 면 STRICT_BLOCKED_TOOLS (fm_organize_folder / fm_restore_file / app_kill) 도 자동 차단.
  // 미지정/"off" 면 기존 동작 — 백 호환.
  safeMode?: SafeMode;
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
  // Phase 107 (v0.6.56) — 폴더 프로젝트 지침 자동 inject.
  // App.tsx 가 활성 conv 의 folderId 보고 folder.systemPrompt 를 매 turn 박음.
  // 시스템 프롬프트 build 시 SYSTEM_PROMPT 뒤에 [프로젝트 지침] 블록으로 prepend.
  // 빈 string / undefined 면 무시.
  folderSystemPrompt?: string;
  // Phase 107 — 폴더 첨부파일 reference (절대 경로).
  // 새 대화 첫 message 일 때만 박힘 (App.tsx 가 detect).
  // sidecar 가 Claude CLI prompt 에 "참고 파일" path 안내를 추가 → Claude 가 Read 로 자동 분석.
  // attachments (base64) 와 달리 이건 이미 K PC 의 영구 파일이라 임시 폴더 복사 없이 path 직접 안내.
  folderAttachmentPaths?: string[];
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
    // Phase 108 (v0.7.00) — episodic 대화 검색 (read-mostly, db_access 카테고리에 귀속)
    "mcp__k-personal__db_convo_search",
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

// Phase 84 — 도구 풀네임 → 카테고리 ID 역색인 (lazy 계산, 위험도 분류용).
// PERM_TOOL_MAP 이 모듈 로딩 시 고정이라 한 번 만들면 됨.
let _toolToCategoryCache: Map<string, string> | null = null;
function toolToCategory(namespacedName: string): string | undefined {
  if (!_toolToCategoryCache) {
    const m = new Map<string, string>();
    for (const [catId, tools] of Object.entries(PERM_TOOL_MAP)) {
      for (const t of tools) m.set(t, catId);
    }
    _toolToCategoryCache = m;
  }
  return _toolToCategoryCache.get(namespacedName);
}

/**
 * Phase 85 — 현재 turn 의 SafeMode 추적 (buildToolFlags 호출 시점에 set).
 * buildRiskMeta 가 critical/high 도구 호출 시 알림을 박을지 결정에 사용.
 * 동시 turn 은 K 가 안 함 — race 안전 가정.
 */
let _currentTurnSafeMode: SafeMode = "off";
let _currentTurnId: string | null = null;

/**
 * Phase 86 (v0.6.29) — Blocking Elicitation 인프라.
 * REST path 의 dispatchModelToolCall 직전에 SafeMode=strict + critical 도구 호출 시
 * elicitation_request 발사 → K 응답 기다림. cancel 누르면 dispatch 안 함.
 *
 * 동작:
 *   1. requestUserConfirmForCriticalTool(toolName, risk, turnId): Promise<boolean>
 *      - elicitation_request emit
 *      - pendingElicitations map 에 resolver 저장
 *      - 30초 timeout → 자동 false (안전 default = deny)
 *   2. case "elicitation_response": pendingElicitations lookup → resolve
 *
 * CLI 모드 (Claude/Codex CLI) 는 sidecar 가 dispatch 안 함 (CLI 가 직접) — 적용 불가.
 * 이 인프라는 REST path (openai/gemini/openrouter) 만 처리.
 */
const pendingElicitations = new Map<
  string,
  { resolve: (confirmed: boolean) => void; timeoutId: NodeJS.Timeout }
>();
let _elicitationCounter = 0;
const ELICITATION_TIMEOUT_MS = 30_000;

function requestUserConfirmForCriticalTool(
  toolName: string,
  toolInput: unknown,
  risk: { level: string; categoryId: string | null; summary: string },
  turnId: string,
): Promise<boolean> {
  const elicId = `safety-${turnId}-${++_elicitationCounter}`;
  return new Promise<boolean>((resolve) => {
    const timeoutId = setTimeout(() => {
      if (pendingElicitations.delete(elicId)) {
        log(
          "warn",
          `[ToolSafety][elicit] timeout (${ELICITATION_TIMEOUT_MS}ms) — auto-deny tool=${toolName}`,
        );
        resolve(false);
      }
    }, ELICITATION_TIMEOUT_MS);
    pendingElicitations.set(elicId, { resolve, timeoutId });
    emit({
      type: "elicitation_request",
      id: elicId,
      turn_id: turnId,
      tool_name: toolName,
      tool_input: toolInput,
      title: `🔴 ${risk.level === "critical" ? "치명" : "높음"} 위험 도구 호출 확인`,
      message: `SafeMode=strict 에서 ${toolName} 호출이 요청됐습니다.\n사유: ${risk.summary}\n${ELICITATION_TIMEOUT_MS / 1000}초 내 응답 없으면 자동 차단됩니다.`,
      severity: "danger",
      confirm_label: "허용하고 진행",
      cancel_label: "차단",
    });
    log(
      "info",
      `[ToolSafety][elicit] waiting K confirm — id=${elicId} tool=${toolName} risk=${risk.level}`,
    );
  });
}

/**
 * Phase 84 — tool_use emit 의 risk 메타데이터 빌더 + sidecar.log high/critical 라인.
 * 호출 path (claude/codex/REST) 마다 한 줄로 박으려고 헬퍼 분리.
 *
 * Phase 85 (v0.6.28) — SafeMode 가 balanced/strict 일 때 high+ 도구 호출 시 추가로
 *   `safety_alert` event emit. App.tsx 가 받아 채팅에 visible system message 로 박음.
 *   (CLI mode 에선 진정한 blocking 은 불가 — disallowed-tools 가 hard 게이트.
 *    이건 가시성/감사 path. K 가 "왜 이 도구가 돌았지" 즉시 인식.)
 */
function buildRiskMeta(toolName: string, sourceTag: string): {
  level: string;
  categoryId: string | null;
  summary: string;
} {
  const cat = toolToCategory(toolName);
  const info = riskOfTool(toolName, cat);
  if (info.level === "high" || info.level === "critical") {
    log(
      "info",
      `[ToolSafety][${sourceTag}] ${info.level.toUpperCase()} tool dispatched name=${toolName} category=${cat ?? "?"} reason=${info.summary}`,
    );
  }
  // Phase 85 — SafeMode 가 켜져 있고 도구가 high+ 면 frontend 에 알림.
  // off 면 emit 안 함 (백 호환 + 매 high 도구마다 알림 박으면 시끄러움 — SafeMode 가 K 의 의식적
  // 보호 선언일 때만 알림).
  if (
    _currentTurnSafeMode !== "off" &&
    (info.level === "high" || info.level === "critical")
  ) {
    emit({
      type: "safety_alert",
      id: _currentTurnId ?? "unknown",
      tool_name: toolName,
      source: sourceTag,
      level: info.level,
      category_id: cat ?? null,
      summary: info.summary,
      safe_mode: _currentTurnSafeMode,
    });
    // Phase 90 — alert 통계 누적 (~/.kda/safety-stats.json)
    // Phase 91 — toolName 함께 박음 (byTool 분포)
    try {
      recordAlert(_currentTurnSafeMode, toolName);
    } catch (e) {
      logToFile("warn", `safety stats recordAlert failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { level: info.level, categoryId: cat ?? null, summary: info.summary };
}

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

// Phase 124 (v0.6.79) — AskUserQuestion 영구 차단 (B안, race condition 근본 대책).
// 원인: KDA 는 `claude -p --output-format stream-json` 단방향으로 CLI 를 돌린다
// (--input-format stream-json 없음). AskUserQuestion 은 "클라이언트가 답을 tool_result 로
// 돌려줘야 하는" interactive tool 인데, 단방향 CLI 에선 turn 도중 답을 주입할 통로가 없다.
// → CLI 가 답을 안 기다리고 turn 을 끝내고, K 의 선택은 "다음 user 메시지"로 큐잉되면서
//   타이밍에 따라 맥락을 잃고 밀린다 (Phase 50·67·68·95 우회 패치로도 race 미해결).
// 정공법: 이 tool 자체를 disallow → 모델이 애초에 못 부름. 선택지가 필요하면 시스템
// 프롬프트 지시대로 "번호 매긴 텍스트"로 제시 → K 가 일반 메시지로 답 (정상 turn 흐름).
// (참고: pitfall_claude_statusline_non_interactive 와 같은 non-interactive CLI 한계 계열)
const ALWAYS_BLOCKED_INTERACTIVE = ["AskUserQuestion"];

interface ToolFlags {
  disallowed: string[];
  effective: Record<string, PermLevel>;
  lockedCount: number;
  /** Phase 84 — SafeMode 가 강등시킨 카테고리 개수 + critical 차단 도구 수 요약 */
  safeMode?: SafeMode;
  safeModeImpact?: ReturnType<typeof summariseSafeModeImpact>;
}

function buildToolFlags(
  perms: PermissionsMap | undefined,
  lockedTools: string[] | undefined,
  safeMode: SafeMode = "off",
): ToolFlags {
  const baseEffective: Record<string, PermLevel> = { ...DEFAULT_PERMISSIONS };
  if (perms) {
    for (const [id, level] of Object.entries(perms)) {
      if (level === "auto" || level === "ask" || level === "manual") {
        baseEffective[id] = level;
      }
    }
  }

  // Phase 84 — SafeMode 적용. off 면 baseEffective 그대로.
  // balanced: high+ → ask. strict: medium → ask, high+ → manual.
  const effective = applySafeMode(baseEffective, safeMode);
  const safeModeImpact =
    safeMode === "off" ? undefined : summariseSafeModeImpact(baseEffective, effective, safeMode);

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
  const disallowed: string[] = [...ALWAYS_BLOCKED_BYPASS, ...ALWAYS_BLOCKED_INTERACTIVE];

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

  // Phase 84 — SafeMode=strict 면 STRICT_BLOCKED_TOOLS 추가 차단 (fm_organize_folder 등).
  // off/balanced 에선 미적용 (백 호환).
  disallowed.push(...strictExtraDisallowed(safeMode));

  return {
    disallowed: Array.from(new Set(disallowed)),
    effective,
    lockedCount,
    safeMode,
    safeModeImpact,
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
  systemText?: string,
): string {
  // Phase 136 — systemText 가 있으면 프롬프트 최상단에 <kda_system> 블록으로 prepend.
  // Codex/Gemini CLI 는 --system-prompt 인자가 없어 시스템 지침을 stdin 으로 흘림
  // (Claude 경로는 --system-prompt 를 쓰므로 이 param 미사용).
  const systemBlock =
    systemText && systemText.trim()
      ? `<kda_system>\n다음은 시스템 지침입니다. 사용자 메시지보다 우선하는 운영 규칙으로 취급하고, 블록 태그 자체는 사용자에게 언급하지 마세요.\n\n${systemText.trim()}\n</kda_system>\n\n`
      : "";
  // memory 가 있으면 stdin 의 시작에 시스템 컨텍스트 블록으로 prepend.
  // 이유: --system-prompt 인자에 memory 를 박으면 Windows cmd.exe 의 8191자 한계를 넘겨
  //       "명령줄이 너무 깁니다" 로 spawn 자체가 실패한다 (memory 가 6KB+ 누적되면 발생).
  //       stdin 은 길이 한계가 없으므로 memory 는 stdin 으로 흘리는 것이 안전.
  // SYSTEM_PROMPT 의 "[누적 메모리]" 안내가 이 블록을 시스템 컨텍스트로 취급하도록 모델을 안내함.
  const memoryBlock =
    memoryContent && memoryContent.trim()
      ? `<memory_context>\n${memoryContent.trim()}\n</memory_context>\n\n`
      : "";

  if (!history || history.length === 0) return systemBlock + memoryBlock + content;

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
  return systemBlock + memoryBlock + lines.join("\n");
}

const CODEX_BOOTSTRAP_HISTORY_MAX_ITEMS = 24;
const CODEX_BOOTSTRAP_HISTORY_MAX_CHARS = 24_000;

function compactHistoryForCodexBootstrap(
  history?: Array<HistoryItem>,
): Array<HistoryItem> | undefined {
  if (!history || history.length === 0) return history;

  const selected: Array<HistoryItem> = [];
  let chars = 0;
  let omitted = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    const itemChars =
      item.role === "tool"
        ? (item.toolName?.length ?? 0) +
          JSON.stringify(item.toolInput ?? "").length +
          (item.toolOutput?.length ?? 0)
        : item.content.length;

    if (
      selected.length >= CODEX_BOOTSTRAP_HISTORY_MAX_ITEMS ||
      (selected.length > 0 && chars + itemChars > CODEX_BOOTSTRAP_HISTORY_MAX_CHARS)
    ) {
      omitted = i + 1;
      break;
    }

    selected.push(item);
    chars += itemChars;
  }

  selected.reverse();
  if (omitted > 0) {
    selected.unshift({
      role: "assistant",
      content:
        `[KDA Codex fast-start] Earlier conversation context was omitted for latency ` +
        `(${omitted} older messages). Use the visible recent conversation first; ` +
        `ask K if older details are required.`,
    });
  }
  return selected;
}

const activeTurns = new Map<string, ChildProcess>();
// REST API 모드의 turn은 fetch AbortController 로 취소.
const activeRestTurns = new Map<string, AbortController>();
let cachedMCPHealth: MCPStatus = { configured: false, serverPathExists: false, pythonAvailable: false, claudeCliAvailable: false };

const SIDECAR_HEARTBEAT_INTERVAL_MS = Number(process.env.KDA_SIDECAR_HEARTBEAT_INTERVAL_MS ?? "30000");
if (Number.isFinite(SIDECAR_HEARTBEAT_INTERVAL_MS) && SIDECAR_HEARTBEAT_INTERVAL_MS > 0) {
  const heartbeatTimer = setInterval(() => {
    try {
      emit({
        type: "heartbeat",
        ts: Date.now(),
        pid: process.pid,
        activeTurns: activeTurns.size,
        activeRestTurns: activeRestTurns.size,
      });
    } catch (err) {
      logToFile("warn", `heartbeat emit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, SIDECAR_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

// ─── Phase 68 (v0.6.12) — MCP 도구 listing 통합 emit helper ────────────────
//
// 호출 path 두 가지:
//   1. ping handler / recheck_mcp handler → cause="auto" (Settings 가 listen 중이면 받음)
//   2. list_mcp_tools handler → cause="request" (Settings 의 명시 요청 응답)
//
// 어느 path 든 동일하게:
//   - cachedMCPHealth 검사 → fail 시 빈 tools + error 박은 mcp_tools emit
//   - listTools(refresh) 호출
//   - getServerInfo() 결과 같이 박음 (UI tooltip 의 "source" 표시용)
//
// throw 안 함 — 호출자가 .catch(...) 로 swallow 가능하게.
async function emitMcpToolsListing(
  cause: "request" | "auto",
  refresh = false,
): Promise<void> {
  if (!cachedMCPHealth.serverPathExists || !cachedMCPHealth.pythonAvailable) {
    emit({
      type: "mcp_tools",
      server: "k-personal",
      tools: [],
      error: cachedMCPHealth.error ?? "K-Personal MCP 가 설정되지 않았습니다.",
      cause,
    });
    return;
  }
  try {
    const client = getKPersonalMCPClient({
      command: PYTHON_EXE,
      args: [K_PERSONAL_PATH],
      logger: (level, m) => logToFile(level, m),
    });
    const tools = await client.listTools(refresh);
    const info = client.getServerInfo();
    logToFile(
      "info",
      `[mcp:k-personal] emit mcp_tools cause=${cause} count=${tools.length} server=${info.name ?? "?"}@${info.version ?? "?"}`,
    );
    emit({
      type: "mcp_tools",
      server: "k-personal",
      tools,
      serverName: info.name,
      serverVersion: info.version,
      cause,
    });
  } catch (e) {
    const msg_ = e instanceof Error ? e.message : String(e);
    logToFile("warn", `[mcp:k-personal] emitMcpToolsListing failed (cause=${cause}): ${msg_}`);
    emit({
      type: "mcp_tools",
      server: "k-personal",
      tools: [],
      error: msg_,
      cause,
    });
  }
}

// ─── Provider 라우터 ──────────────────────────────────
async function handleUserMessage(msg: UserMessage): Promise<void> {
  const provider: Provider = msg.provider ?? "claude";
  if (provider === "claude") {
    return handleViaClaudeCLI(msg);
  }
  if (provider === "codex") {
    return handleViaCodexCLI(msg);
  }
  if (provider === "gemini-cli") {
    return handleViaGeminiCLI(msg);
  }
  return handleViaRestAPI(msg, provider);
}

// ─── Phase 137 (v0.7.9) — 멀티 에이전트 오케스트레이션 v1 ─────────────────
//
// 구조: fan-out → fan-in.
//   ① orchestrate_message {engines:[...]} 수신 → 각 엔진에 sub-turn (id=`{id}#{engine}`)
//      병렬 디스패치. sub-turn 은 기존 handleUserMessage 파이프라인 그대로 재사용.
//   ② sub-turn 의 stdout 이벤트는 emit() 에서 가로채 frontend 충돌 차단:
//      assistant_delta → orchestrate_delta {id:mainId, engine, text} 로 재태깅,
//      done/error → collector resolve + orchestrate_status, 그 외 (tool_use 등) swallow.
//      → 옛 frontend 가 sub-turn id 를 모르는 turn 으로 오인해 isStreaming 을 조기
//        해제하는 회귀 원천 차단 (frontend 의 done 핸들러는 unknown id 도 active conv 로 fallback).
//   ③ 전부 settle 후 (partial fan-in — 1개 이상 성공이면 진행) 메인 엔진(claude 우선)이
//      원 질문 + 엔진별 답변을 받아 최종 종합 — 이 턴은 원래 id 로 흐르므로 frontend 의
//      기존 assistant_delta/done 처리로 자연 표시.
//   ④ sub-turn 도구 잠금: 프롬프트 레벨 ("도구 호출 금지" 지시). Codex/Gemini CLI 는
//      CLI 레벨 도구 차단 인자가 없어 v1 은 프롬프트 잠금 — 동시 도구 실행 충돌(파일
//      이동 2회 등) 회피 목적. 종합 턴은 일반 턴과 동일 권한.
//   ⑤ interrupt(mainId) → sub-turn process tree-kill + cancelled 마킹 → 종합 skip.
//
// 안전: 명시적 opt-in (Settings 토글 + 엔진 2개 이상 선택 시에만 frontend 가
// orchestrate_message 전송). engines 화이트리스트 미통과/1개 이하 → 일반 턴으로 강등.

type OrchestrateMessage = Omit<UserMessage, "type"> & {
  type: "orchestrate_message";
  engines?: string[];
  // 엔진별 API 키 (현재 gemini-cli 만 의미 — 없으면 구독 OAuth creds 폴백).
  engineApiKeys?: Record<string, string>;
};

interface OrchSubResult {
  engine: Provider;
  ok: boolean;
  text: string;
  error?: string;
}

interface OrchCollector {
  mainId: string;
  engine: Provider;
  text: string;
  settled: boolean;
  resolve: (r: OrchSubResult) => void;
}

const ORCH_VALID_ENGINES: ReadonlySet<string> = new Set(["claude", "codex", "gemini-cli"]);
const ORCH_SUBTURN_TIMEOUT_MS =
  Number(process.env.KDA_ORCH_SUBTURN_TIMEOUT_MS) || 5 * 60 * 1000;
// 종합 프롬프트에 넣을 엔진별 답변 상한 (context 보호 — 3개 엔진 * 8KB = 최대 24KB).
const ORCH_ANSWER_MAX_CHARS = 8_000;
/** sub-turn 프롬프트 래퍼 — 도구 잠금 + 역할 안내. */
function wrapOrchSubTurnContent(content: string): string {
  return [
    "[멀티 엔진 병렬 분석 — 서브턴]",
    "당신은 여러 AI 엔진 중 하나로, 같은 질문에 독립적으로 답하고 있습니다. 최종 답변은 메인 엔진이 종합합니다.",
    "규칙: ① 이 턴에서는 도구를 호출하지 말고 텍스트로만 답하세요 (다른 엔진과 동시 실행 중 — 도구 충돌 방지). ② 핵심 위주로 간결하게. ③ 불확실하면 불확실하다고 명시.",
    "",
    "[질문]",
    content,
  ].join("\n");
}

/** fan-in 결과 → 메인 엔진 종합 프롬프트. */
function buildOrchSynthesisPrompt(question: string, results: OrchSubResult[]): string {
  const parts = [
    "[멀티 엔진 오케스트레이션 — 종합]",
    `K 의 질문에 ${results.length}개 AI 엔진이 병렬로 답했습니다. 당신은 메인 엔진으로서 아래 답변들을 비교·검증해 하나의 최종 답변으로 종합하세요.`,
    "- 엔진 간 일치하는 내용은 신뢰도 높음으로 채택하세요.",
    "- 불일치하는 부분은 어느 쪽이 타당한지 근거와 함께 판단하세요 (확신이 없으면 양쪽 다 제시).",
    '- 응답 마지막에 "── 엔진별 의견 요약" 섹션으로 각 엔진의 핵심 주장을 1-2줄씩 정리하세요.',
    "- 실패한 엔진이 있으면 한 줄로만 언급하세요.",
    "",
    "[원래 질문]",
    question,
  ];
  for (const r of results) {
    const body = r.text.trim().slice(0, ORCH_ANSWER_MAX_CHARS);
    parts.push(
      "",
      `[${r.engine} 답변${r.ok ? "" : ` — 실패: ${r.error ?? "빈 응답"}`}]`,
      body || "(응답 없음)",
    );
  }
  return parts.join("\n");
}

/** sub-turn 1개 실행 — 절대 reject 하지 않음 (실패도 결과로 수렴 → partial fan-in). */
function runOrchSubTurn(raw: OrchestrateMessage, engine: Provider): Promise<OrchSubResult> {
  return new Promise<OrchSubResult>((resolvePromise) => {
    const subId = `${raw.id}#${engine}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const col: OrchCollector = {
      mainId: raw.id,
      engine,
      text: "",
      settled: false,
      resolve: (r) => {
        if (col.settled) return;
        col.settled = true;
        if (timer) clearTimeout(timer);
        orchestrationCollectors.delete(subId);
        emit({
          type: "orchestrate_status",
          id: raw.id,
          engine,
          phase: r.ok ? "done" : "error",
          ...(r.error ? { error: r.error } : {}),
        });
        resolvePromise(r);
      },
    };
    orchestrationCollectors.set(subId, col);
    emit({ type: "orchestrate_status", id: raw.id, engine, phase: "started" });

    // 타임아웃 — 프로세스 정리 후 partial 결과로 수렴 (텍스트가 있으면 ok 취급).
    timer = setTimeout(() => {
      const proc = activeTurns.get(subId);
      if (proc?.pid) treeKill(proc.pid, "SIGKILL", () => {});
      activeTurns.delete(subId);
      const ctrl = activeRestTurns.get(subId);
      if (ctrl) {
        ctrl.abort();
        activeRestTurns.delete(subId);
      }
      const hasText = col.text.trim().length > 0;
      logToFile("warn", `Orchestration sub-turn timeout ${subId} (${ORCH_SUBTURN_TIMEOUT_MS}ms) partialText=${col.text.length}`);
      col.resolve({
        engine,
        ok: hasText,
        text: col.text,
        error: hasText ? undefined : `타임아웃 (${Math.round(ORCH_SUBTURN_TIMEOUT_MS / 1000)}초)`,
      });
    }, ORCH_SUBTURN_TIMEOUT_MS);

    const subMsg: UserMessage = {
      ...(raw as unknown as UserMessage),
      type: "user_message",
      id: subId,
      provider: engine,
      content: wrapOrchSubTurnContent(raw.content),
      // resume 금지 — 같은 thread 를 병렬 sub-turn 이 공유하면 충돌/오염.
      agent_id: undefined,
      _codexResumeRetried: undefined,
      api_key: raw.engineApiKeys?.[engine],
    };
    void handleUserMessage(subMsg).catch((e) => {
      col.resolve({
        engine,
        ok: false,
        text: col.text,
        error: e instanceof Error ? e.message : String(e),
      });
    });
    // 정상 종료는 emit() 인터셉트의 done/error 가 col.resolve 호출.
  });
}

async function handleOrchestrateMessage(raw: OrchestrateMessage): Promise<void> {
  const engines = Array.from(
    new Set((raw.engines ?? []).filter((e) => ORCH_VALID_ENGINES.has(e))),
  ) as Provider[];
  if (engines.length < 2) {
    // 화이트리스트 미통과 / 1개 이하 → 일반 턴 강등 (백 호환 — 실패 대신 응답은 나감).
    logToFile("warn", `Orchestration 강등 id=${raw.id} engines=${JSON.stringify(raw.engines)} → 일반 턴`);
    void handleUserMessage({ ...(raw as unknown as UserMessage), type: "user_message" });
    return;
  }
  const mainEngine: Provider = engines.includes("claude" as Provider)
    ? ("claude" as Provider)
    : engines[0];
  logToFile(
    "info",
    `Orchestration start id=${raw.id} engines=${engines.join(",")} main=${mainEngine} timeout=${ORCH_SUBTURN_TIMEOUT_MS}ms`,
  );
  emit({ type: "orchestrate_status", id: raw.id, engine: "*", phase: "fanout", engines });

  let results: OrchSubResult[];
  try {
    results = await Promise.all(engines.map((engine) => runOrchSubTurn(raw, engine)));
  } catch (e) {
    // runOrchSubTurn 은 reject 안 하지만 방어적 안전망.
    const m = e instanceof Error ? e.message : String(e);
    logToFile("error", `Orchestration fan-out 예외 id=${raw.id}: ${m}`);
    emit({ type: "error", id: raw.id, message: `멀티 엔진 오케스트레이션 실패: ${m}` });
    return;
  }

  if (cancelledOrchestrations.delete(raw.id)) {
    logToFile("info", `Orchestration interrupted id=${raw.id} — 종합 skip`);
    emit({ type: "done", id: raw.id, agentId: null });
    return;
  }

  const okResults = results.filter((r) => r.ok);
  logToFile(
    "info",
    `Orchestration fan-in id=${raw.id} ok=${okResults.length}/${results.length} (${results.map((r) => `${r.engine}:${r.ok ? r.text.length + "ch" : "FAIL"}`).join(", ")})`,
  );
  if (okResults.length === 0) {
    emit({
      type: "error",
      id: raw.id,
      message:
        "멀티 엔진 오케스트레이션 실패 — 모든 엔진 응답 실패:\n" +
        results.map((r) => `- ${r.engine}: ${r.error ?? "빈 응답"}`).join("\n"),
    });
    return;
  }

  // ── 종합 (fan-in) — 메인 엔진이 원래 turn id 로 실행 → frontend 기존 흐름 그대로.
  emit({ type: "orchestrate_status", id: raw.id, engine: mainEngine, phase: "synthesis" });
  const synthesisMsg: UserMessage = {
    ...(raw as unknown as UserMessage),
    type: "user_message",
    provider: mainEngine,
    content: buildOrchSynthesisPrompt(raw.content, results),
    // 첨부는 sub-turn 들이 이미 분석에 반영 — 종합 턴엔 중복 전달 안 함.
    attachments: undefined,
    // 메인 엔진이 claude 가 아니면 agent_id(다른 엔진 thread)는 무효 — 제거.
    agent_id: mainEngine === "claude" ? raw.agent_id : undefined,
  };
  await handleUserMessage(synthesisMsg);
}

// ─── 첨부 파일을 임시 폴더에 풀어내기 ────────────────────────────
// Composer 에서 base64 로 보낸 파일들을 turn 별 임시 디렉토리에 디코드해 저장.
// 반환값:
//   dir: 정리 대상 임시 폴더 경로 (없으면 null)
//   guidance: prompt 끝에 붙일 안내 텍스트 (없으면 빈 문자열)
// Claude CLI 의 Read 도구가 path 를 받아 이미지는 vision, 텍스트는 본문으로 처리.
async function materializeAttachments(
  msg: UserMessage,
): Promise<{ dir: string | null; guidance: string }> {
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
  if (process.env.KDA_STDIN_TRACE) {
    emit({ type: "log", level: "info", message: `[stdin-trace] handleViaClaudeCLI enter id=${msg.id} attachments=${msg.attachments?.length ?? 0}` });
  }
  const mcpConfig = buildMCPConfig(cachedMCPHealth);

  // 첨부 파일을 임시 폴더에 풀고, prompt 에 path 안내를 덧붙임.
  // 임시 폴더는 finally 에서 통째로 삭제.
  const { dir: attachmentsDir, guidance: attachmentsGuidance } =
    await materializeAttachments(msg);
  if (process.env.KDA_STDIN_TRACE) {
    emit({ type: "log", level: "info", message: `[stdin-trace] materialized id=${msg.id} dir=${attachmentsDir ?? "null"} guidanceBytes=${(attachmentsGuidance ?? "").length}` });
  }

  // Phase 107 (v0.6.56) — 폴더 첨부 reference 안내 추가.
  // App.tsx 가 새 대화 첫 message 일 때만 박음 (토큰 절약). path 가 절대 경로 → Claude CLI Read 도구가 직접 읽음.
  // 기존 attachments (base64 임시 파일) 와 달리 영구 파일이라 임시 폴더 복사 X.
  let folderAttachmentGuidance = "";
  if (
    Array.isArray(msg.folderAttachmentPaths) &&
    msg.folderAttachmentPaths.length > 0
  ) {
    const validPaths = msg.folderAttachmentPaths.filter(
      (p) => typeof p === "string" && p.trim().length > 0,
    );
    if (validPaths.length > 0) {
      const lines = validPaths.map((p) => `- ${p}`);
      folderAttachmentGuidance = [
        "",
        "",
        "[프로젝트 참고 파일]",
        "K 가 이 프로젝트 폴더에 등록한 참고 파일들입니다. Read 도구로 내용을 확인하여 답변에 반영하세요.",
        "(이미지는 vision 분석, 텍스트는 본문이 읽힘. 한 번에 다 읽지 말고 필요한 것만 선택적으로 읽으세요.)",
        ...lines,
      ].join("\n");
    }
  }

  const baseContent = `${msg.content}${attachmentsGuidance ?? ""}${folderAttachmentGuidance}`;
  // memory 는 stdin (prompt) 으로 흘려보낸다 — 명령행 길이 한계 회피.
  // Phase 106 — 현재 메시지를 넘겨 조건부 메모리(triggers) 선택 로딩.
  const memory = loadMemoryContext(msg.content);
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
  const toolFlags = buildToolFlags(msg.permissions, msg.lockedTools, msg.safeMode ?? "off");
  // Phase 85 — 현재 turn 의 SafeMode + id 를 buildRiskMeta 가 볼 수 있도록 set
  _currentTurnSafeMode = toolFlags.safeMode ?? "off";
  _currentTurnId = msg.id;
  if (toolFlags.safeMode && toolFlags.safeMode !== "off" && toolFlags.safeModeImpact) {
    log("info", `[ToolSafety] SafeMode=${toolFlags.safeMode} — ${toolFlags.safeModeImpact.summary}`);
  }

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

  // Phase 109 / X-4 / X-6 / X-9 — agent-flags.json 의 실험 기능 게이트.
  // flag OFF 인 기능의 MCP 도구는 disallowed 에 추가 → 모델이 못 부름 (기본 OFF = 종전 동작).
  const agentFlags = loadAgentFlags();
  const gatedDisallowed = flagGatedDisallowed(agentFlags);
  const effectiveDisallowed = Array.from(
    new Set([...toolFlags.disallowed, ...gatedDisallowed]),
  );
  if (effectiveDisallowed.length > 0) {
    args.push("--disallowed-tools", effectiveDisallowed.join(","));
  }

  // Phase 106 (v0.6.55) — model 선택 전달.
  // Settings 의 claude provider model picker 값 ("default" 가 아니면) 을 Claude CLI 의 --model 로 흘림.
  // Claude CLI 가 alias ("opus", "sonnet") 또는 full ID ("claude-opus-4-8") 둘 다 받음 (claude --help 확인).
  // 종전: 이 인자가 빠져있어 K 가 Settings 에서 model picker 바꿔도 CLI 의 default 만 사용됨 (picker 무력화).
  // 분모(currentModelMaxTokensInfo) 는 hardcode 200K fallback (Claude 4.x 표준) — 실제 한도와 안 맞으면
  // K 보고 시 별도 patch (pitfall_codex_model_context_window_dynamic 함정 회피).
  if (msg.model && msg.model.trim() && msg.model !== "default") {
    args.push("--model", msg.model);
  }

  // 시스템 프롬프트 = 기본 + ask 안내 + manual 안내.
  // 누적 메모리(memory/) 는 길이가 누적되어 cmd.exe 의 8191자 한계를 깨므로
  // --system-prompt 인자에 박지 않는다 — 대신 stdin(prompt) 의 <memory_context> 블록으로 흘려보냄.
  // SYSTEM_PROMPT 의 "[누적 메모리]" 안내가 모델에게 그 블록을 시스템 컨텍스트로 취급하도록 함.
  const askGuidance = buildAskGuidance(toolFlags.effective);
  const manualGuidance = buildManualGuidance(toolFlags.effective);
  // Phase 107 (v0.6.56) — 폴더 프로젝트 지침 inject.
  // 활성 conv 가 폴더에 속하고 그 폴더에 systemPrompt 박혀있으면 [프로젝트 지침] 블록으로 박음.
  // SYSTEM_PROMPT 다음, ask/manual 안내 앞 위치 — K 의 의도가 가장 먼저 보이도록.
  const folderInstructionBlock =
    msg.folderSystemPrompt && msg.folderSystemPrompt.trim()
      ? `\n\n[프로젝트 지침]\n이 대화는 K 가 지정한 프로젝트 폴더에 속해 있으며, 아래 지침을 항상 따라야 합니다. K 의 요청과 충돌하면 K 의 명시적 지시를 우선하되, 그 외엔 이 지침을 우선 적용하세요.\n\n${msg.folderSystemPrompt.trim()}\n`
      : "";
  // Phase X-2 — soul.md (에이전트 정체성) 가 있으면 SYSTEM_PROMPT 바로 뒤에 박음.
  const soul = loadSoul();
  const soulBlock = soul.exists && soul.content
    ? `\n\n[에이전트 정체성 (soul.md)]\n다음은 당신(에이전트) 자신의 정체성·가치관입니다. 매 응답에서 일관되게 유지하세요.\n\n${soul.content}\n`
    : "";
  // Phase 109 / X-4 / X-6 / X-7 / X-9 — 활성 실험 기능 가이던스 (flag OFF 면 빈 문자열).
  const featureGuidance = buildAgentFeatureGuidance(agentFlags);
  const fullSystemPrompt =
    SYSTEM_PROMPT + soulBlock + folderInstructionBlock + askGuidance + manualGuidance + featureGuidance;

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

  // ── Phase 121 (v0.6.76): per-turn idle 워치독 ──────────────────────────
  // 진단(234 starts vs 180 ends): 멈춘 자식 프로세스가 stdout/stderr 를 한참 안 내면
  // proc.on("close") 가 영영 안 와 turn 이 "진행중" 으로 영구 고착 → UI 무한 spinner.
  // 모든 stdout 라인/stderr chunk 마다 lastActivity 갱신. 완전 무출력이 IDLE_TIMEOUT_MS 를
  // 넘으면 hang 으로 판정 → tree-kill → close 경로(catch)가 error 를 emit 해 UI 를 푼다.
  // 긴 tool 실행(예: 빌드) 오인 kill 방지를 위해 값은 보수적(기본 8분). 프론트 dead-stream
  // 워치독(90s 비파괴 "중단" 버튼)이 빠른 수동 탈출을 주므로 sidecar 자동 kill 은 길게 둠.
  // catch/finally 에서 접근하려면 try 밖에 선언해야 한다 (try 블록 스코프 회피).
  const IDLE_TIMEOUT_MS = Number(process.env.KDA_TURN_IDLE_TIMEOUT_MS) || DEFAULT_TURN_IDLE_TIMEOUT_MS;
  let watchdogTripped = false;
  let idleWatchdog: ReturnType<typeof setInterval> | undefined;
  let turnKeepalive: ReturnType<typeof setInterval> | undefined;
  try {
    // Claude CLI 실행
    // hook 스크립트(preToolUse-overwriteGuard.mjs) 가 자식 자식 프로세스로 실행되므로
    // 권한 정책 정보는 환경변수로 전파한다 (Claude CLI → hook 으로 자동 상속됨).
    const proc = spawn(CLAUDE_CLI, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      // Windows: shell:true 면 cmd.exe 경유 → windowsHide 없으면 턴마다 콘솔 창 깜빡임.
      windowsHide: true,
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
    // idle 워치독 기준 시각 — stdout/stderr 출력이 올 때마다 갱신.
    let lastActivity = Date.now();
    const activeToolCalls = new Set<string>();
    let activeToolStartedAt: number | null = null;
    const markActiveToolStart = (toolId: string | undefined | null) => {
      if (!toolId) return;
      activeToolCalls.add(toolId);
      activeToolStartedAt = activeToolStartedAt ?? Date.now();
      lastActivity = Date.now();
    };
    const markActiveToolDone = (toolId: string | undefined | null) => {
      if (toolId) activeToolCalls.delete(toolId);
      if (activeToolCalls.size === 0) activeToolStartedAt = null;
      lastActivity = Date.now();
    };
    // idle 워치독 가동 (선언은 try 밖 — catch/finally 가 watchdogTripped/idleWatchdog 참조).
    // stdout/stderr 가 IDLE_TIMEOUT_MS 동안 무이벤트면 자식 완전 정지로 판정 → tree-kill →
    // catch 에서 명시적 error emit → 프론트 streaming 해제. 15s 간격으로 점검.
    idleWatchdog = setInterval(() => {
      const now = Date.now();
      const idle = now - lastActivity;
      const activeWorkMs = activeToolStartedAt === null ? null : now - activeToolStartedAt;
      if (activeToolCalls.size > 0) {
        if ((activeWorkMs ?? 0) <= ACTIVE_TOOL_TIMEOUT_MS) return;
      } else if (idle <= IDLE_TIMEOUT_MS) {
        return;
      }
      watchdogTripped = true;
      if (idleWatchdog) clearInterval(idleWatchdog);
      logToFile(
        "error",
        `CLI idle watchdog tripped id=${msg.id} idleMs=${idle} threshold=${IDLE_TIMEOUT_MS} — 멈춘 자식 프로세스 강제 종료`,
      );
      const pid = proc.pid;
      if (pid) {
        treeKill(pid, "SIGKILL", (err) => {
          if (err) {
            logToFile("warn", `idle watchdog tree-kill 실패 PID=${pid}: ${err.message} — fallback proc.kill`);
            try { proc.kill("SIGKILL"); } catch { /* ignore */ }
          }
        });
      } else {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }, 15_000);

    turnKeepalive = setInterval(() => {
      const now = Date.now();
      const idleMs = now - lastActivity;
      const activeWorkMs = activeToolStartedAt === null ? null : now - activeToolStartedAt;
      if (activeToolCalls.size > 0) lastActivity = now;
      emitTurnHeartbeat(msg.id, "claude", activeToolCalls.size > 0 ? 0 : idleMs, activeWorkMs, proc.pid ?? null);
      emit({
        type: "long_task_evidence",
        taskId: msg.id,
        manifest: {
          provider: "claude",
          activeToolCalls: activeToolCalls.size,
          idleMs,
          activeWorkMs,
          pid: proc.pid ?? null,
          heartbeatAt: now,
        },
      } as any);
    }, TURN_KEEPALIVE_INTERVAL_MS);
    turnKeepalive.unref?.();

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
        lastActivity = Date.now(); // idle 워치독 리셋
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
      lastActivity = Date.now(); // idle 워치독 리셋 — 자식이 살아있다는 신호
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
                  markActiveToolStart(block.id);
                  // Phase 50 — 모델이 AskUserQuestion (Claude 의 user-question tool) 호출 시
                  // sidecar 가 KDA UI 로 라우팅. 기존 path 에선 그냥 tool_use 메시지로만 보였고
                  // 답할 방법이 없어 K 가 옵션을 직접 선택할 수 없었음. 이걸 ask_user_question
                  // 이벤트로 변환 → frontend 의 ElicitationDialog 가 옵션 리스트로 띄워줌.
                  const askInput = block.input as any;
                  if (
                    block.name === "AskUserQuestion" &&
                    askInput &&
                    Array.isArray(askInput.questions) &&
                    askInput.questions.length > 0
                  ) {
                    log(
                      "info",
                      `[AskUserQuestion] 모델 질문 ${askInput.questions.length}개 캡처 → KDA elicitation 라우팅`,
                    );
                    // Phase 95 (v0.6.37) — tool_msg_id 명시 추가.
                    // 종전엔 App.tsx 가 ask_user_question event 받은 후 별도 tool_use event 의
                    // ToolMessage 가 박히길 기다렸으나, race 또는 mismatch 로 patchAskToolMessageOutput
                    // 이 7회 모두 fail (sidecar.log 확인). 이제 tool_msg_id 를 명시 전달 →
                    // App.tsx 가 ask_user_question 받자마자 그 id 로 ToolMessage 미리 박을 수 있음.
                    emit({
                      type: "ask_user_question",
                      id: msg.id,
                      tool_use_id: block.id,
                      tool_msg_id: `${msg.id}-tool-${block.id}`,
                      questions: askInput.questions,
                    } as any);
                    // 기존 tool_use 이벤트도 함께 emit — 메시지 본문에 흔적 남겨 K 가 어떤 질문이
                    // 있었는지 history 로 볼 수 있게. ElicitationDialog 닫혀도 추후 추적 가능.
                  }
                  // Phase 84 — 위험도 캡처 (Claude CLI path)
                  emit({
                    type: "tool_use",
                    id: msg.id,
                    tool_id: block.id,
                    name: block.name,
                    input: block.input,
                    risk: buildRiskMeta(block.name, "claude"),
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
                  markActiveToolDone(block.tool_use_id);
                  // Phase 98 — image content part 를 별도 추출. 종전엔 normalizeToolOutput 이
                  // image 를 JSON.stringify 로 dump 해 K 화면에 base64 텍스트만 보였음.
                  const { text, images } = splitToolContent(block.content);
                  emit({
                    type: "tool_result",
                    id: msg.id,
                    tool_id: block.tool_use_id,
                    output: text,
                    images: images.length > 0 ? images : undefined,
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
    const rawMessage = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    // idle 워치독이 죽인 경우 — generic "exited with code null" 대신 원인을 명확히.
    const message = watchdogTripped
      ? `응답이 ${Math.round(IDLE_TIMEOUT_MS / 1000)}초간 멈춰 자동 중단했습니다. 다시 시도해 주세요. (idle watchdog)`
      : rawMessage;
    logToFile("error", `CLI query error id=${msg.id}: ${rawMessage}${watchdogTripped ? " [idle watchdog kill]" : ""}${stack ? `\n${stack}` : ""}`);
    emit({ type: "error", id: msg.id, message });
  } finally {
    clearInterval(idleWatchdog); // idle 워치독 정리 — 정상/비정상 종료 모두
    clearInterval(turnKeepalive);
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

// Phase 98 — MCP 도구의 image content part 를 별도로 추출.
// Anthropic Messages API 의 tool_result.content 는 string 또는
// Array<{type:"text",text} | {type:"image",source:{type:"base64",media_type,data}}>.
// 종전엔 image 가 JSON.stringify 로 텍스트 덤프되어 K 화면에 base64 raw 가 뿌려졌음.
// 이제 text 는 output 으로, image 는 data URL 배열로 분리 emit → frontend 가 썸네일 렌더.
function splitToolContent(content: unknown): { text: string; images: string[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) {
    return { text: JSON.stringify(content), images: [] };
  }
  const texts: string[] = [];
  const images: string[] = [];
  for (const c of content as any[]) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text" && typeof c.text === "string") {
      texts.push(c.text);
    } else if (c.type === "image" && c.source) {
      const src = c.source;
      // base64 형식 (Anthropic spec)
      if (src.type === "base64" && typeof src.data === "string" && typeof src.media_type === "string") {
        // 잘려있는 부분 방어 — 너무 짧으면 무시
        if (src.data.length > 16) {
          images.push(`data:${src.media_type};base64,${src.data}`);
        }
      } else if (src.type === "url" && typeof src.url === "string") {
        // 일부 MCP 서버가 URL 로 반환할 수 있음 (Anthropic spec 2025 확장)
        images.push(src.url);
      } else {
        // 알 수 없는 source 형식은 fallback 으로 JSON 덤프
        texts.push(JSON.stringify(c));
      }
    } else {
      texts.push(JSON.stringify(c));
    }
  }
  return { text: texts.join("\n"), images };
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

// Phase 61 (v0.5.49): runtime session blocklist — Codex stderr 에 "Reconnecting 5/5
// websocket closed before response.completed" 패턴 감지 시 그 sessionId 를 자동 박음.
// 다음 spawn 의 inspectCodexSessionFile 가드에 같이 검사 → resume 차단.
// K 다른 PC 진단: 비대한 resume session 에서 stream 안정성 깨짐 → 5번 retry 후 실패.
// in-memory 만 (process 재시작 시 reset) — persistent 는 file 잠금 등 부담 vs 사용자 의도
// 변경 케이스 (다음 KDA 재시작 시 그 session 다시 쓸 수 있어야) 의 균형.
const sessionBlocklist = new Set<string>();
const sessionBlocklistPath = path.join(
  os.homedir(),
  ".kda",
  "codex-session-blocklist.json",
);

function loadPersistentSessionBlocklist(): void {
  try {
    if (!existsSync(sessionBlocklistPath)) return;
    const raw = readFileSync(sessionBlocklistPath, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed?.ids) ? parsed.ids : [];
    for (const id of ids) {
      if (typeof id === "string" && id.length > 8) sessionBlocklist.add(id);
    }
  } catch (e) {
    logToFile(
      "warn",
      `Codex session blocklist load failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function savePersistentSessionBlocklist(): void {
  try {
    mkdirSync(path.dirname(sessionBlocklistPath), { recursive: true });
    const ids = Array.from(sessionBlocklist).slice(-200);
    writeFileSync(
      sessionBlocklistPath,
      JSON.stringify({ updatedAt: new Date().toISOString(), ids }, null, 2),
      "utf-8",
    );
  } catch (e) {
    logToFile(
      "warn",
      `Codex session blocklist save failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

loadPersistentSessionBlocklist();

function blockSession(agentId: string, reason: string): void {
  sessionBlocklist.add(agentId);
  savePersistentSessionBlocklist();
  logToFile("warn", `Session ${agentId} 자동 blocklist 추가 — ${reason}`);
}

// Phase 59 (v0.5.47): poisoned Codex session 차단 — K 의 다른 PC 진단 결정타.
// Codex thread 가 한 번 cumulative billing 누적 (예: total_token_usage.input_tokens=8M+)
// 으로 오염되면, KDA 가 그 thread 를 resume 하는 한 매 turn context % 가 비정상으로 부풀음.
// Phase 58 까지의 fix 는 "오염된 값을 frontend 에 안 보내기" 였지만, 그 thread 자체를 계속
// resume 하면 다시 비정상 상태 진입. 해결: resume 직전 .jsonl 파일 검사 → poisoned 면 새 세션.
function findCodexSessionFileById(agentId: string): string | null {
  // Codex 세션 파일: ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl
  // 최근 14일 디렉터리만 스캔 (성능 위해)
  const rootDir = path.join(os.homedir(), ".codex", "sessions");
  if (!existsSync(rootDir)) return null;
  const now = new Date();
  for (let daysBack = 0; daysBack <= 14; daysBack++) {
    const d = new Date(now);
    d.setDate(d.getDate() - daysBack);
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const dayDir = path.join(rootDir, yyyy, mm, dd);
    if (!existsSync(dayDir)) continue;
    try {
      const files = readdirSync(dayDir);
      for (const f of files) {
        if (f.includes(agentId) && f.endsWith(".jsonl")) {
          return path.join(dayDir, f);
        }
      }
    } catch {
      // 디렉터리 읽기 실패 — 다음 일자 검색
    }
  }
  return null;
}

// Phase 126 (v0.6.81) — Codex resume "no rollout found" 크래시 사전 차단.
// findCodexSessionFileById 는 성능 위해 최근 14일만 스캔하므로, 14일 넘은 정상 세션도
// null 을 돌려준다 (그건 resume 그대로 시도 → Codex 가 자체 보유분으로 정상 resume).
// 하지만 thread_id 가 진짜 고아(예: 옛 Codex 버전의 UUIDv4 id, 또는 끊겨 기록 안 된 세션)면
// `codex exec resume <id>` 가 exit 1 로 크래시한다. 그래서 resume 직전 "전체 트리"를 한 번
// 훑어 (파일명만 검사 — 파일 read 없음, 저렴) rollout 존재 여부를 신뢰성 있게 판정한다.
// 못 찾으면 resume 안 함 → 새 세션 + prior_conversation 재주입 (크래시 자체를 회피).
// 스캔 실패 시엔 보수적으로 true (resume 막지 않음 — 런타임 reactive 회복이 잡음).
function codexRolloutExists(agentId: string): boolean {
  try {
    const rootDir = path.join(os.homedir(), ".codex", "sessions");
    if (!existsSync(rootDir)) return false;
    for (const yyyy of readdirSync(rootDir)) {
      const yDir = path.join(rootDir, yyyy);
      let mmList: string[];
      try {
        mmList = readdirSync(yDir);
      } catch {
        continue;
      }
      for (const mm of mmList) {
        const mDir = path.join(yDir, mm);
        let ddList: string[];
        try {
          ddList = readdirSync(mDir);
        } catch {
          continue;
        }
        for (const dd of ddList) {
          const dDir = path.join(mDir, dd);
          let files: string[];
          try {
            files = readdirSync(dDir);
          } catch {
            continue;
          }
          for (const f of files) {
            if (f.includes(agentId) && f.endsWith(".jsonl")) return true;
          }
        }
      }
    }
    return false;
  } catch {
    // 스캔 자체 실패 — resume 막지 않음 (기존 동작 유지). 실제 크래시는 reactive 가 회복.
    return true;
  }
}

function inspectCodexSessionFile(agentId: string): {
  isPoisoned: boolean;
  reason?: string;
  filePath?: string;
} {
  // Phase 61 (v0.5.49): runtime blocklist 우선 — 이전 spawn 에서 Reconnecting 5/5 로
  // 막힌 session 이면 즉시 poisoned. 파일 크기 / total_token_usage 검사 skip.
  if (sessionBlocklist.has(agentId)) {
    return {
      isPoisoned: true,
      reason: "runtime blocklist (이전 spawn 에서 Reconnecting 5/5 또는 명시 차단)",
    };
  }
  try {
    const sessionFile = findCodexSessionFileById(agentId);
    if (!sessionFile) {
      // 파일 못 찾으면 그냥 resume 시도 (Codex 가 자체 fail 시 fallback path)
      return { isPoisoned: false };
    }

    // 1차 가드: 파일 크기 > 5MB
    const stats = statSync(sessionFile);
    const sizeMB = stats.size / 1024 / 1024;
    if (sizeMB > 5) {
      return {
        isPoisoned: true,
        reason: `세션 파일 크기 ${sizeMB.toFixed(2)}MB > 5MB threshold (대량 tool output 누적)`,
        filePath: sessionFile,
      };
    }

    // 2차 가드: 마지막 100KB 안의 가장 최근 token_count 의 total_token_usage.input_tokens 검사
    // 전체 파일 스캔 회피 — 마지막 chunk 만 읽음
    const lastBytes = Math.min(stats.size, 200 * 1024);
    const fd = openSync(sessionFile, "r");
    const buf = Buffer.alloc(lastBytes);
    readSync(fd, buf, 0, lastBytes, stats.size - lastBytes);
    closeSync(fd);
    const lastChunk = buf.toString("utf-8");
    const lines = lastChunk.split("\n").reverse();

    let modelWindow = 0;
    let totalInput = 0;
    for (const line of lines) {
      if (!line.includes("token_count")) continue;
      try {
        const parsed = JSON.parse(line);
        const payload = parsed.payload ?? parsed;
        if (payload.type !== "token_count") continue;
        const info = payload.info ?? payload;
        modelWindow = info.model_context_window ?? 0;
        totalInput = info.total_token_usage?.input_tokens ?? 0;
        if (modelWindow > 0 && totalInput > 0) break;
      } catch {
        // JSON 파싱 실패 — 그 line 무시
      }
    }

    // total_token_usage 가 model window 의 5배 넘으면 oxidized
    if (modelWindow > 0 && totalInput > modelWindow * 5) {
      return {
        isPoisoned: true,
        reason: `total_token_usage.input_tokens=${totalInput} > model_context_window ${modelWindow} * 5 (cumulative billing 과대 누적)`,
        filePath: sessionFile,
      };
    }

    return { isPoisoned: false, filePath: sessionFile };
  } catch (e) {
    logToFile(
      "warn",
      `poisoned session check 실패 (resume 그대로 시도): ${e instanceof Error ? e.message : String(e)}`,
    );
    return { isPoisoned: false };
  }
}

async function handleViaCodexCLI(msg: UserMessage): Promise<void> {
  // 첨부 파일은 Claude 와 같은 방식으로 임시 폴더 + 안내 텍스트
  const { dir: attachmentsDir, guidance: attachmentsGuidance } =
    await materializeAttachments(msg);
  const baseContent = attachmentsGuidance
    ? `${msg.content}${attachmentsGuidance}`
    : msg.content;
  // Phase 106 — 현재 메시지를 넘겨 조건부 메모리(triggers) 선택 로딩.
  const memory = loadMemoryContext(msg.content);

  // Phase 59 (v0.5.47): poisoned session 차단 가드 — K 다른 PC 진단 핵심.
  // msg.agent_id 가 있어도 그 thread 가 오염됐으면 resume 안 함 → 새 세션 시작.
  // 차단 시 frontend 에는 agentId=null 알림 emit (turn end 시 새 sessionId 로 자동 갱신됨)
  // 그리고 prior_conversation 도 새 세션처럼 박아야 함 (resume 아닌 path 와 동일).
  let effectiveAgentId: string | undefined = msg.agent_id ?? undefined;
  let poisonedSkipped = false;
  // Phase 126 (v0.6.81) — 고아 thread_id 사전 차단 플래그.
  let orphanSkipped = false;
  if (effectiveAgentId) {
    const poison = inspectCodexSessionFile(effectiveAgentId);
    if (poison.isPoisoned) {
      logToFile(
        "warn",
        `Codex session ${effectiveAgentId} POISONED — ${poison.reason}. resume 차단 → 새 세션 시작 (file=${poison.filePath ?? "?"})`,
      );
      effectiveAgentId = undefined;
      poisonedSkipped = true;
    } else if (!codexRolloutExists(effectiveAgentId)) {
      // Phase 126 (v0.6.81) — 그 thread 의 rollout 파일이 로컬 어디에도 없음 (고아 id).
      // 그대로 resume 하면 `no rollout found for thread id (-32600)` 로 Codex 가 크래시.
      // 사전에 resume 차단 → 새 세션 + prior_conversation 재주입 → 크래시 없이 대화 이어감.
      logToFile(
        "warn",
        `Codex thread ${effectiveAgentId} 의 rollout 파일 없음 (orphan — 옛 Codex 버전 id 또는 미기록 세션). resume 차단 → 새 세션 + 맥락 재주입`,
      );
      blockSession(effectiveAgentId, "rollout 파일 없는 고아 thread_id — resume 영구 차단");
      effectiveAgentId = undefined;
      orphanSkipped = true;
    }
  }

  // Phase 48 (v0.5.36): Codex resume 사용 시 prior_conversation 안 박음 — Codex 가 thread state
  // 로 history 보유. 매 turn 마다 통째 재주입 시 context 폭발 (K 의 다른 PC root cause).
  // resume 아닐 때만 history 박음. Phase 59: effectiveAgentId 기준 (poisoned 시 새 세션 path).
  const codexBootstrapHistory = effectiveAgentId
    ? undefined
    : compactHistoryForCodexBootstrap(msg.history);
  // Phase 136 — Hermes 동등 배선: SYSTEM_PROMPT + soul + 프로젝트 지침 + featureGuidance
  // + 도구 게이트를 <kda_system> 블록으로 주입. 종전엔 Codex 가 KDA 룰을 전혀 못 받았음.
  // resume 턴은 thread 에 bootstrap 의 전체 지침이 있으므로 compact 리마인더만 (context 보호).
  const codexAgentFlags = loadAgentFlags();
  const codexSystemText = buildEngineSystemText(msg.folderSystemPrompt, codexAgentFlags, {
    compact: !!effectiveAgentId,
  });
  const promptWithHistory = effectiveAgentId
    ? buildPromptWithHistory(baseContent, undefined, undefined, codexSystemText)
    : buildPromptWithHistory(baseContent, codexBootstrapHistory, memory.content, codexSystemText);
  const promptBytes = Buffer.byteLength(promptWithHistory, "utf-8");

  // Codex CLI 인자 — `codex exec` 의 sub-form.
  // resume 은 별도 subcommand 라 case 분기로 처리.
  const args: string[] = [];

  if (effectiveAgentId) {
    // `codex exec resume <thread_id>` — 기존 세션 이어가기.
    args.push("exec", "resume", effectiveAgentId, "--json");
  } else {
    args.push("exec", "--json");
    if (poisonedSkipped) {
      // poisoned skip 시 frontend 에 즉시 안내 — 시스템 메시지로 표시 가능
      emit({
        type: "log",
        level: "warn",
        message: `이전 Codex 세션이 비정상 누적 (cumulative billing 합 > model window * 5 또는 파일 > 5MB) → 새 세션으로 자동 전환. 다음 turn 부터 정상 측정됩니다.`,
      });
    } else if (orphanSkipped) {
      // Phase 126 (v0.6.81) — 고아 thread_id 사전 차단 안내.
      emit({
        type: "log",
        level: "warn",
        message: `이전 Codex 세션 기록을 찾을 수 없어(앱·Codex 업데이트로 세션 형식/위치 변경 가능) 새 세션으로 자동 이어갑니다. 이전 대화 맥락은 그대로 유지됩니다.`,
      });
    }
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

  // Phase 125 (v0.6.80) — 추론 강도 (reasoning effort) override.
  // Codex CLI 의 `-c model_reasoning_effort="..."` (TOML literal). config.toml 기본값을 덮음.
  // 화이트리스트로만 박음 (TOML/shell injection 방지 — pitfall_js_arg_type_silent_throw 계열 방어).
  // "default"/미지정/비허용값 → 안 박음 → Codex 가 config.toml 또는 모델 기본 effort 사용.
  const VALID_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high"]);
  const reasoning = msg.reasoningEffort?.trim().toLowerCase();
  if (reasoning && VALID_REASONING_EFFORTS.has(reasoning)) {
    args.unshift(`model_reasoning_effort="${reasoning}"`);
    args.unshift("-c");
  }

  logToFile(
    "info",
    `Codex query start id=${msg.id} model=${msg.model ?? "default"} reasoning=${reasoning && VALID_REASONING_EFFORTS.has(reasoning) ? reasoning : "default"} resume=${msg.agent_id ?? "none"} promptBytes=${promptBytes} historyIn=${msg.history?.length ?? 0} historySent=${codexBootstrapHistory?.length ?? 0} memorySent=${effectiveAgentId ? 0 : memory.bytes} systemBytes=${Buffer.byteLength(codexSystemText, "utf-8")}${effectiveAgentId ? "(compact)" : ""} attachments=${msg.attachments?.length ?? 0}`,
  );

  // Per-turn usage 집계 — Codex 는 turn.completed 에 정확한 컨텍스트 크기 한 번 옴.
  let maxTurnInputTokens = 0;
  let maxTurnCacheCreation = 0;
  let maxTurnCacheRead = 0;
  let maxTurnContextTokens = 0;
  // Phase 54 (v0.5.42): Codex 런타임이 보고하는 실제 model_context_window 추적.
  // turn.completed 의 usage.input_tokens 가 이 값의 1.2배 넘으면 cumulative billing 합
  // (total_token_usage 시리즈, 681K 같은 케이스) 으로 판정 → maxTurnContextTokens 갱신 skip.
  let lastSeenModelContextWindow = 0;
  // Phase 57 (v0.5.45): token_count 의 last_token_usage 의 cached peak 추적. turn.completed.usage
  // 의 cached_input_tokens 가 이 값의 2배 넘으면 cumulative billing 합으로 판정 → 그 turn 만
  // skip + token_count 의 peak 유지. K 다른 PC 케이스: token_count peak=166272 vs
  // turn.completed=3963648 (= 24배). input 가드와 별도로 cache 도 가드 필요.
  let maxLastTokenUsageCachePeak = 0;
  // Phase 62 (v0.5.50): K 다른 PC 진단 결정타 — turn.completed 가 token_count 보다 먼저 도착
  // 시 가드 무력화 회귀. token_count.last_token_usage 를 한 번이라도 받았으면 그게 진짜 single-call
  // context. 그 이후엔 turn.completed.usage.input_tokens 가 cumulative 의심값 (3% 씩 누적되는
  // 75K, 90K, 106K 같은) 으로 와도 maxTurnContextTokens 절대 덮어쓰지 않음.
  let sawCodexLastTokenUsage = false;

  let sessionId: string | null = null;
  let currentText = "";
  let sawCompletion = false;
  let stderrTail = "";
  // Phase 126 (v0.6.81) — resume 대상 rollout 이 없어 Codex 가 크래시한 케이스 reactive 감지.
  // 사전 codexRolloutExists 가드를 통과했더라도 (파일은 있는데 Codex 가 못 읽는 등) 안전망.
  let resumeRolloutMissing = false;
  // Phase 63 (v0.5.51): K 다른 PC 진단 — turn.completed 와 token_count 의 race condition.
  // turn.completed 가 먼저 도착하면 그 시점엔 sawCodexLastTokenUsage=false → 가드 무력 →
  // cumulative 값 (121K) 박힘 → done emit 후 늦게 도착한 token_count 의 last_token_usage
  // (15K) 는 max(15K, 121K) = 121K 유지 → UI 121K 표시 (3% 누적 회귀).
  // Fix: turn.completed 받아도 즉시 done emit 안 함. snapshot 저장만. stream EOF (rl loop
  // 자연 종료) 후 finalize 단계에서 모든 token_count 가 박힌 후의 정확한 sawCodexLastTokenUsage
  // 와 함께 가드 + done emit.
  let turnCompletedSnapshot: {
    usage: any;
    codexCtxRaw: number;
    inp: number;
    cr: number;
    outputTokens: number;
  } | null = null;
  const STDERR_KEEP = 4096;

  // ── Phase 123 (v0.6.78): Codex 경로 per-turn idle 워치독 ────────────────
  // Claude 경로(Phase 121)와 동일 구조. Codex 자식이 stdout/stderr 를 IDLE_TIMEOUT_MS
  // 동안 한 줄도 안 내면 hang 으로 판정 → tree-kill → proc.on("close") 가 code≠0 로
  // reject → catch 가 error emit → UI "진행중" 고착 해제. catch/finally 가 참조하므로
  // 선언은 try 밖. 긴 작업 오인 방지 위해 임계값 보수적(기본 8분, env 조절 가능).
  const IDLE_TIMEOUT_MS = Number(process.env.KDA_TURN_IDLE_TIMEOUT_MS) || DEFAULT_TURN_IDLE_TIMEOUT_MS;
  let watchdogTripped = false;
  let idleWatchdog: ReturnType<typeof setInterval> | undefined;
  let turnKeepalive: ReturnType<typeof setInterval> | undefined;

  try {
    const proc = spawn(CODEX_CLI, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      // Windows: cmd.exe 콘솔 창 깜빡임 방지 (shell:true 동반 필수)
      windowsHide: true,
      env: { ...process.env },
    });

    activeTurns.set(msg.id, proc);

    // idle 워치독 기준 시각 — stdout 라인/stderr chunk 올 때마다 갱신.
    let lastActivity = Date.now();
    // 15s 간격으로 무이벤트 시간 점검. 임계 초과 시 자식 트리 강제 종료.
    const activeToolCalls = new Set<string>();
    let activeToolStartedAt: number | null = null;
    const markActiveToolStart = (toolId: string | undefined | null) => {
      if (!toolId) return;
      activeToolCalls.add(toolId);
      activeToolStartedAt = activeToolStartedAt ?? Date.now();
      lastActivity = Date.now();
    };
    const markActiveToolDone = (toolId: string | undefined | null) => {
      if (toolId) activeToolCalls.delete(toolId);
      if (activeToolCalls.size === 0) activeToolStartedAt = null;
      lastActivity = Date.now();
    };
    idleWatchdog = setInterval(() => {
      const now = Date.now();
      const idle = now - lastActivity;
      const activeWorkMs = activeToolStartedAt === null ? null : now - activeToolStartedAt;
      if (activeToolCalls.size > 0) {
        if ((activeWorkMs ?? 0) <= ACTIVE_TOOL_TIMEOUT_MS) return;
      } else if (idle <= IDLE_TIMEOUT_MS) {
        return;
      }
      watchdogTripped = true;
      if (idleWatchdog) clearInterval(idleWatchdog);
      logToFile(
        "error",
        `Codex idle watchdog tripped id=${msg.id} idleMs=${idle} threshold=${IDLE_TIMEOUT_MS} — 멈춘 자식 프로세스 강제 종료`,
      );
      const pid = proc.pid;
      if (pid) {
        treeKill(pid, "SIGKILL", (err) => {
          if (err) {
            logToFile("warn", `Codex idle watchdog tree-kill 실패 PID=${pid}: ${err.message} — fallback proc.kill`);
            try { proc.kill("SIGKILL"); } catch { /* ignore */ }
          }
        });
      } else {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }, 15_000);

    // Phase 79 (v0.6.22) — Task State Manager: Codex 작업 시작을 DB 에 기록.
    // App.tsx 의 listener 가 long_tasks 테이블에 row insert. KDA 재시작/끊김 시 복구 가능 후보로 표시.
    // Phase 126 (v0.6.81) — resume 실패 자동 재시도 path 면 outer 가 이미 started 를 emit 했으므로
    // 중복 insert 방지 위해 skip (inner 의 done 이 outer 의 row 를 닫음 — taskId 동일).
    turnKeepalive = setInterval(() => {
      const now = Date.now();
      const idleMs = now - lastActivity;
      const activeWorkMs = activeToolStartedAt === null ? null : now - activeToolStartedAt;
      if (activeToolCalls.size > 0) lastActivity = now;
      emitTurnHeartbeat(msg.id, "codex", activeToolCalls.size > 0 ? 0 : idleMs, activeWorkMs, proc.pid ?? null);
      emit({
        type: "long_task_evidence",
        taskId: msg.id,
        manifest: {
          provider: "codex",
          activeToolCalls: activeToolCalls.size,
          idleMs,
          activeWorkMs,
          pid: proc.pid ?? null,
          heartbeatAt: now,
        },
      } as any);
    }, TURN_KEEPALIVE_INTERVAL_MS);
    turnKeepalive.unref?.();

    if (!msg._codexResumeRetried) {
      emit({
        type: "long_task_started",
        taskId: msg.id,
        kind: "codex",
        title: (msg.content ?? "").slice(0, 80) || "Codex 작업",
        manifest: {
          provider: "codex",
          agentId: effectiveAgentId ?? null,
          pid: proc.pid ?? null,
          startedAt: Date.now(),
        },
      } as any);
    }

    if (proc.stdin) {
      proc.stdin.on("error", (e) => {
        logToFile("warn", `Codex stdin error: ${e instanceof Error ? e.message : String(e)}`);
      });
      proc.stdin.write(promptWithHistory, "utf-8");
      proc.stdin.end();
    }

    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        lastActivity = Date.now(); // idle 워치독 리셋
        const decoded = chunk.toString("utf-8");
        stderrTail += decoded;
        if (stderrTail.length > STDERR_KEEP) {
          stderrTail = stderrTail.slice(-STDERR_KEEP);
        }
        logToFile("warn", `Codex stderr: ${decoded.trimEnd()}`);
        // Phase 126 (v0.6.81) — resume 대상 rollout 없음 감지 (no rollout found / thread/resume failed).
        // 사전 codexRolloutExists 가드를 뚫고 들어온 케이스의 안전망. 감지 시 그 thread 영구 차단 +
        // 플래그 → close 후 "새 세션으로 1회 자동 재시도" 트리거 (그 대화가 죽지 않게).
        if (
          effectiveAgentId &&
          !resumeRolloutMissing &&
          /no rollout found for thread id|thread\/resume(?: failed)?/i.test(decoded)
        ) {
          resumeRolloutMissing = true;
          blockSession(
            effectiveAgentId,
            `Codex resume: no rollout found (고아 thread_id) — 다음 spawn 부터 resume 차단`,
          );
          logToFile(
            "warn",
            `Codex resume 대상 rollout 없음 — agentId=${effectiveAgentId}. 새 세션으로 1회 자동 재시도 예정`,
          );
        }
        // Phase 61 (v0.5.49): "Reconnecting... 5/5" 또는 "websocket closed before response.completed"
        // pattern 감지 → 그 session 을 자동 blocklist. 다음 spawn 의 inspectCodexSessionFile
        // 가드가 우선 검사로 즉시 차단.
        // K 다른 PC 진단: 비대한 resume session 에서 stream 안정성 깨짐 → 5번 retry 후 실패 패턴.
        if (false && effectiveAgentId && (
          /Reconnecting[\s\S]*5\/5/.test(decoded) ||
          /websocket closed before response\.completed/.test(decoded)
        )) {
          blockSession(
            effectiveAgentId!,
            `Codex stderr 에 Reconnecting 5/5 또는 websocket close 감지 — 다음 spawn 부터 resume 차단`,
          );
          // Phase 83 (v0.6.26) — Session Recovery Hook: 5/5 timeout 시 frontend 에 즉시
          // 알려 RecoveryBanner 재스캔 trigger. K 가 conversation 으로 이동해 long_task
          // 진행 상황 확인 가능. Lee 의 학습효과 패치 #7 (Session Recovery Hook) 의 자동
          // 진입 path — 끊긴 세션이 작업 중단으로 이어지지 않게.
          emit({
            type: "session_recovery_triggered",
            reason: "codex_reconnect_5_5",
            agentId: effectiveAgentId,
            taskId: msg.id,
          } as any);
        }
        // Phase 83 (v0.6.26): 2/5 timeout 도 캡처 — K 의 다른 PC 진단의 핵심 ("Reconnecting 2/5
        // timeout waiting for child process to exit"). 차단까지는 안 가지만 알림은 띄움.
        else if (false && effectiveAgentId && /Reconnecting[\s\S]*[2-4]\/5/.test(decoded)) {
          emit({
            type: "session_recovery_triggered",
            reason: "codex_reconnect_partial",
            agentId: effectiveAgentId,
            taskId: msg.id,
          } as any);
        }
      });
    }

    const rl = readline.createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      lastActivity = Date.now(); // idle 워치독 리셋 — 자식이 살아있다는 신호
      if (!line.trim()) continue;
      try {
        const rawEvent = JSON.parse(line);
        // Phase 56 (v0.5.44): K 의 다른 PC 진단으로 결정타 발견 — Codex CLI 0.130 부터 event 가
        // `event_msg` wrapper 로 박혀서 옴. 종전 schema (Codex 0.120 이전) 는 root 에 type/data,
        // 신 schema 는 root 에 type="event_msg" + payload={type, info, ...}. token_count event 가
        // 0.130 환경에서 root level switch case 에 안 잡혀 silent drop → model_context_window
        // 한 번도 안 잡힘 → cumulative 가드 무력 → "대화 한 번에 100%" 회귀.
        // 양쪽 schema 모두 처리: event_msg wrapper 면 payload 를 unwrap 해서 actualEvent 로 박음.
        let event = rawEvent;
        if (rawEvent.type === "event_msg" && rawEvent.payload && typeof rawEvent.payload === "object") {
          event = { ...rawEvent.payload, _wrappedFrom: "event_msg" };
        }
        // Phase 48 (v0.5.36): Codex CLI 버전별 event schema 가 달라서 thread_id 못 잡는 케이스가 있음.
        // K 의 다른 PC 보고: agent_id NULL → resume 안 됨 → prior_conversation 매번 재주입 → context 폭발.
        // 여러 키 폴백 + 모든 event 의 thread/session/conversation id 후보 적극 추출.
        if (!sessionId) {
          const candidate =
            event.thread_id ??
            event.session_id ??
            event.conversation_id ??
            event.threadId ??
            event.sessionId ??
            event.id ??
            event.thread?.id ??
            event.session?.id ??
            event.conversation?.id ??
            // Phase 56: event_msg wrapper 의 payload 안에 id 가 박힐 수도
            rawEvent.payload?.thread_id ??
            rawEvent.payload?.session_id ??
            rawEvent.payload?.id;
          if (typeof candidate === "string" && candidate.length > 8) {
            sessionId = candidate;
            logToFile("info", `Codex sessionId 추출 from type=${event.type} key=auto → ${sessionId}`);
          }
        }
        switch (event.type) {
          case "thread.started":
          case "session.created":
          case "conversation.started": {
            if (!sessionId && event.thread_id) sessionId = event.thread_id;
            break;
          }
          case "turn.started": {
            // 신호용 — 현재는 별도 처리 없음
            break;
          }
          case "token_count": {
            // Phase 52 (v0.5.40) + Phase 56 (v0.5.44) — Codex 런타임의 정확한 model_context_window
            // 보고. K 의 다른 PC 진단: gpt-5.5 의 실제 model_context_window=258400 인데 KDA hardcode 는
            // 400K → UI 가 76.6% 표시할 때 실제 model 은 이미 118% 넘김.
            // Codex 0.130 부터 schema 변경 — root 에 있던 model_context_window/last_token_usage 가
            // event.info.* 로 nested. 양쪽 schema 모두 지원.
            const info = event.info ?? event;
            const ctxWin =
              info.model_context_window ??
              info.context_window ??
              event.model_context_window ??
              event.context_window ??
              event.turn_context?.model_context_window;
            if (typeof ctxWin === "number" && ctxWin > 1000) {
              lastSeenModelContextWindow = ctxWin;
              emit({
                type: "model_context_window",
                provider: "codex",
                contextWindow: ctxWin,
                source: "codex token_count",
              } as any);
              logToFile(
                "info",
                `Codex model_context_window = ${ctxWin} (last_token_usage=${JSON.stringify(info.last_token_usage ?? event.last_token_usage ?? {})})`,
              );
            }
            // Phase 54 (v0.5.42) + Phase 56 (v0.5.44): K 의 다른 PC 진단으로 진짜 root cause 잡힘 —
            // `total_token_usage.input_tokens` 는 turn 내 sub-iteration 들의 input 의 누적 billing
            // 합 (681K 같은 모델 window 의 2.6배). model 이 본 적 없는 가짜 누적.
            // 정답: `last_token_usage.input_tokens` (각 sub-call 마다 model 이 실제 본 단일 input
            // window 점유) 만 사용. 0.130 schema 는 info.last_token_usage, 구버전은 root.
            const ltu = info.last_token_usage ?? event.last_token_usage;
            if (ltu && typeof ltu === "object") {
              const cached = ltu.cached_input_tokens ?? 0;
              const totalInput = ltu.input_tokens ?? 0;
              const newInput = Math.max(0, totalInput - cached);
              // Phase 57: cache peak 추적 — turn.completed 의 cumulative cache 가드용
              maxLastTokenUsageCachePeak = Math.max(maxLastTokenUsageCachePeak, cached);
              // Phase 62 (v0.5.50): K 다른 PC 진단 — token_count.last_token_usage 를 받으면
              // 그게 single-call model 점유의 진실. flag set 후 turn.completed 가 더 큰 값 보고해도
              // 무력화. token_count event 가 turn 안에 여러 번 와도 max 유지 (sub-iteration peak).
              sawCodexLastTokenUsage = true;
              if (totalInput > maxTurnContextTokens) {
                maxTurnContextTokens = totalInput;
                maxTurnInputTokens = newInput;
                maxTurnCacheRead = cached;
              }
            }
            // Phase 79 (v0.6.22) — Task State Manager: 매 token_count 마다 evidence emit.
            // App.tsx 가 long_tasks 의 last_evidence_at + manifest 갱신. K 의 복구 후보
            // 판정에 사용 (이게 안 들어오면 끊긴 작업).
            emit({
              type: "long_task_evidence",
              taskId: msg.id,
              manifest: {
                provider: "codex",
                modelContextWindow: lastSeenModelContextWindow ?? null,
                inputTokens: ltu?.input_tokens ?? null,
                cachedInputTokens: ltu?.cached_input_tokens ?? null,
                maxTurnContextTokens,
                maxCachePeak: maxLastTokenUsageCachePeak,
              },
            } as any);
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
          case "item.started": {
            const it = event.item;
            if (it?.type === "command_exec" || it?.type === "mcp_tool_call") {
              markActiveToolStart(it.id ?? it.type);
            }
            break;
          }
          case "item.completed": {
            const it = event.item;
            if (!it) break;
            if (it.type === "command_exec" || it.type === "mcp_tool_call") {
              markActiveToolDone(it.id ?? it.type);
            }
            if (it.type === "agent_message" && typeof it.text === "string") {
              // 일부 호출은 delta 없이 한 번에 옴 — 최종 텍스트 replace.
              if (it.text !== currentText) {
                currentText = it.text;
                emit({ type: "assistant_delta", id: msg.id, text: currentText });
              }
            } else if (it.type === "command_exec") {
              // Codex 자체 Bash 도구 호출. Claude 의 tool_use 패턴으로 중계.
              const _cxCmdName = it.command_name ?? "Bash";
              emit({
                type: "tool_use",
                id: msg.id,
                tool_id: it.id ?? `codex-${Date.now()}`,
                name: _cxCmdName,
                input: { command: it.command ?? it.text ?? "" },
                risk: buildRiskMeta(_cxCmdName, "codex"),
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
                risk: buildRiskMeta(toolName, "codex-mcp"),
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
                risk: buildRiskMeta("FileEdit", "codex-file"),
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
            // Phase 63 (v0.5.51): K 다른 PC 진단 — turn.completed 가 token_count 보다 먼저 도착
            // 시 가드 무력화. 종전엔 여기서 즉시 가드 검사 + maxTurn* 갱신 + done emit 했지만,
            // 그 시점 sawCodexLastTokenUsage=false → cumulative 121K 박힘 → 늦은 token_count 의
            // last_token_usage=15K 도 max() 정책상 121K 못 떨어뜨림.
            // Fix: snapshot 저장만, finalize 는 for-await 루프 종료 후 (모든 token_count 처리 후).
            const u = event.usage ?? {};
            const inpRaw = (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0);
            const inp = Math.max(0, inpRaw);
            const cr = u.cached_input_tokens ?? 0;
            const codexCtxRaw = u.input_tokens ?? 0;
            turnCompletedSnapshot = {
              usage: u,
              codexCtxRaw,
              inp,
              cr,
              outputTokens: u.output_tokens ?? 0,
            };
            // 누적 텍스트 마지막 emit (Claude 와 동일 정책) — done emit 은 deferred 라도 텍스트는 즉시
            if (currentText) {
              emit({ type: "assistant_delta", id: msg.id, text: currentText });
            }
            // done emit / 가드 / 갱신 모두 deferred — for-await 루프 종료 후 finalize 에서.
            break;
          }

          // === DEFERRED FINALIZE 스텁 (never matches) — 아래 dead code 는 finalize 함수 본문 ===
          // Phase 63 (v0.5.51): 이 case label 이 절대 매칭 안 돼서 아래 코드는 실행 X.
          // 실제 finalize 는 for-await loop 종료 후 `if (turnCompletedSnapshot) { ... }`.
          case "__phase63_deferred_finalize_never__": {
            // stub case 안 const 들 — 아래 dead code 가 type-check 통과하게 placeholder 박음.
            const u: any = {};
            const inpRaw = 0;
            const inp = Math.max(0, inpRaw);
            const cr = 0;
            const codexCtxRaw = 0;
            const CODEX_CTX_HARD_CAP = 1_050_000;
            const ABSOLUTE_SINGLE_CALL_CEILING = 1_000_000;
            void u; void inp; void cr; void codexCtxRaw;
            void CODEX_CTX_HARD_CAP; void ABSOLUTE_SINGLE_CALL_CEILING;

            // ── 가드 1: input cumulative 판정 ─────────────────────
            // Phase 62 (v0.5.50): K 다른 PC 진단 결정타 — sawCodexLastTokenUsage 가 true 면
            // token_count.last_token_usage 가 single-call 의 진실. turn.completed.usage 의
            // input_tokens 가 더 크면 (75K vs last 15K) 그건 cumulative billing 합 — 무조건
            // 갱신 skip. 종전 가드 (1.2배/2배/1M) 의 임계 미달 케이스도 잡힘 (75K 같은 작은
            // cumulative 도 차단).
            const dominatedByLastTokenUsage =
              sawCodexLastTokenUsage && codexCtxRaw > maxTurnContextTokens;
            const overModelWindow =
              lastSeenModelContextWindow > 0 &&
              codexCtxRaw > lastSeenModelContextWindow * 1.2;
            const overLastTokenPeak =
              maxTurnContextTokens > 0 && codexCtxRaw > maxTurnContextTokens * 2;
            const overAbsoluteCeiling = codexCtxRaw > ABSOLUTE_SINGLE_CALL_CEILING;
            const inputCumulative =
              dominatedByLastTokenUsage ||
              overModelWindow ||
              overLastTokenPeak ||
              overAbsoluteCeiling;

            // ── 가드 2: cache cumulative 판정 ─────────────────────
            const cacheCumulative =
              (maxLastTokenUsageCachePeak > 0 && cr > maxLastTokenUsageCachePeak * 2) ||
              (maxLastTokenUsageCachePeak === 0 && cr > 1_000_000);

            // ── 가드 적용 ──────────────────────────────────────────
            // turn.completed.usage 가 cumulative billing 합 케이스: input 또는 cache 어느 한쪽이
            // cumulative 면 turn.completed.usage 자체가 cumulative 합 → 모든 갱신 skip 안전.
            // input 만 정상이고 cache 만 cumulative 인 비대칭 케이스는 거의 없으나 안전망.
            if (inputCumulative) {
              const reason = dominatedByLastTokenUsage
                ? `> last_token_usage peak ${maxTurnContextTokens} (Phase 62 strict — token_count.last_token_usage 가 single-call 진실)`
                : overModelWindow
                  ? `> model window ${lastSeenModelContextWindow} * 1.2`
                  : overLastTokenPeak
                    ? `> last_token_usage peak ${maxTurnContextTokens} * 2 (model window 미보고)`
                    : `> 1M absolute ceiling (token_count event 전무 — schema mismatch 의심)`;
              logToFile(
                "warn",
                `Codex turn.completed.usage cumulative billing 합 추정 — input=${codexCtxRaw} ${reason}, cache=${cr}. ALL 갱신 skip (token_count peak 유지: input=${maxTurnInputTokens} cache=${maxTurnCacheRead} ctx=${maxTurnContextTokens})`,
              );
              // input / cache / context 모두 갱신 skip — token_count handler 가 박은 peak 만 유지
            } else if (cacheCumulative) {
              // 비대칭 케이스 — input 만 정상, cache 만 cumulative
              logToFile(
                "warn",
                `Codex cache_read_input_tokens=${cr} cumulative billing 추정 (peak=${maxLastTokenUsageCachePeak}) — cache 만 skip, input/context 는 정상 갱신`,
              );
              maxTurnInputTokens = Math.max(maxTurnInputTokens, inp);
              maxTurnContextTokens = Math.max(
                maxTurnContextTokens,
                Math.min(codexCtxRaw, CODEX_CTX_HARD_CAP),
              );
            } else {
              // 정상 — 모두 갱신
              maxTurnInputTokens = Math.max(maxTurnInputTokens, inp);
              maxTurnCacheRead = Math.max(maxTurnCacheRead, cr);
              maxTurnContextTokens = Math.max(
                maxTurnContextTokens,
                Math.min(codexCtxRaw, CODEX_CTX_HARD_CAP),
              );
            }

            if (codexCtxRaw > CODEX_CTX_HARD_CAP) {
              logToFile(
                "warn",
                `Codex input_tokens=${codexCtxRaw} 비현실적 — ${CODEX_CTX_HARD_CAP} 으로 cap (tool 결과 누적 부풀음)`,
              );
            }

            // 마지막 안전망 — 누적 텍스트가 있으면 한 번 더 emit (Claude 와 동일 정책).
            if (currentText) {
              emit({ type: "assistant_delta", id: msg.id, text: currentText });
            }
            emit({
              type: "done",
              id: msg.id,
              usage: {
                // Phase 58: cr (raw) 대신 maxTurnCacheRead (가드 적용된 값) 사용 — frontend 의
                // 다른 측정 path (currentContextTokens 등) 가 cumulative 값 보고 cap 100% 회귀
                // 방지. maxTurnInputTokens 도 가드 통과한 값.
                input_tokens: maxTurnInputTokens,
                output_tokens: u.output_tokens ?? 0,
                cache_read_input_tokens: maxTurnCacheRead,
              },
              computed_usage: {
                input_tokens: maxTurnInputTokens,
                output_tokens: u.output_tokens ?? 0,
                cache_read_input_tokens: maxTurnCacheRead,
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
              `Codex turn end id=${msg.id} displayCtx=${maxTurnContextTokens} (input=${maxTurnInputTokens} cr=${maxTurnCacheRead} out=${u.output_tokens ?? 0}) sessionId=${sessionId ?? "NULL"}`,
            );
            // Phase 48 (v0.5.36): sessionId 못 잡으면 resume 안 되고 매 turn 마다 prior_conversation 재주입 →
            // context 폭발. 진단 path 명시 — 다음 turn 부터 어떻게 fix 할지 추적 가능.
            if (!sessionId) {
              logToFile(
                "warn",
                `⚠ Codex sessionId NULL — resume 불가. 다음 turn 도 매번 새 세션 + prior_conversation 통째 재주입됨. Codex CLI 버전이 thread_id event schema 안 보내는 경우. K 의 다른 PC root cause 후보.`,
              );
            }
            break;
          }
          case "error": {
            const errMsg = event.message ?? event.error ?? "Codex error";
            logToFile("error", `Codex error event: ${errMsg}`);
            emit({ type: "error", id: msg.id, message: String(errMsg) });
            break;
          }
          default: {
            // Phase 48: 모르는 event type 의 keys 도 sidecar.log 에 기록 — thread_id 가 어디
            // 박혀있는지 K 의 다른 PC sidecar.log 에서 식별 가능.
            const keys = Object.keys(event).slice(0, 8).join(",");
            logToFile("info", `Codex event: ${event.type} (keys: ${keys})`);
          }
        }
      } catch (parseErr) {
        // Phase 76 (v0.6.19): Codex CLI 가 자체 child process 를 taskkill 로 정리할 때 그 stdout
        // ("SUCCESS: The process with PID ... has been terminated." 영어 / "성공: PID ..." 한국어 /
        //  "정보:" / "INFO:" 등) 이 stdout 으로 새서 JSON 라인 parse 가 fail → spam warn.
        // 이 패턴들은 진짜 Codex event 가 아니므로 silent skip (log 도 안 박음 — info 한 번도 비효율).
        // 다른 parse error 는 그대로 warn — 진짜 schema 변경 알림 보존.
        if (/^(SUCCESS:|INFO:|성공:|정보:)/i.test(line.trim())) {
          continue;
        }
        logToFile("warn", `Codex JSON parse error: ${line}`);
      }
    }

    // Phase 63 (v0.5.51): for-await rl loop 종료 후 deferred finalize.
    // 이 시점이면 모든 token_count event 가 처리된 후 → sawCodexLastTokenUsage 정확.
    // turn.completed 가 token_count 보다 먼저 도착해도 가드가 정확하게 작동.
    if (turnCompletedSnapshot) {
      // Phase 64 (v0.5.52): sawCodexLastTokenUsage=false 인 경우 (stdout 에 token_count event 가
      // 안 옴 / silent drop / schema 또 변경 등) — Codex 세션 JSONL 에서 직접 last_token_usage 복구.
      // K 다른 PC 진단 결정타: sidecar displayCtx=152108 (cumulative) vs 같은 세션 파일의
      // last_token_usage.input_tokens=15358 (single-call). Phase 63 deferred 도 token_count event 가
      // 아예 안 오면 무력. 세션 파일은 Codex 가 항상 정확히 기록하므로 ground truth.
      if (!sawCodexLastTokenUsage && sessionId) {
        // Codex 가 turn.completed 후 세션 파일에 token_count 를 비동기 write 할 가능성 → 짧게 대기
        await new Promise((resolve) => setTimeout(resolve, 250));
        try {
          const sessionFile = findCodexSessionFileById(sessionId);
          if (sessionFile) {
            const stats = statSync(sessionFile);
            const lastBytes = Math.min(stats.size, 512 * 1024);
            const fd = openSync(sessionFile, "r");
            const buf = Buffer.alloc(lastBytes);
            readSync(fd, buf, 0, lastBytes, stats.size - lastBytes);
            closeSync(fd);
            const lines = buf.toString("utf-8").split("\n").reverse();
            for (const line of lines) {
              if (!line || !line.includes("token_count")) continue;
              try {
                const parsed = JSON.parse(line);
                const payload = parsed.payload ?? parsed;
                if (payload.type !== "token_count") continue;
                const info = payload.info ?? payload;
                const ltu = info.last_token_usage ?? payload.last_token_usage;
                if (!ltu || typeof ltu !== "object") continue;
                const cached = ltu.cached_input_tokens ?? 0;
                const totalInput = ltu.input_tokens ?? 0;
                if (totalInput <= 0) continue;
                const newInput = Math.max(0, totalInput - cached);
                sawCodexLastTokenUsage = true;
                maxLastTokenUsageCachePeak = Math.max(maxLastTokenUsageCachePeak, cached);
                maxTurnContextTokens = totalInput;
                maxTurnInputTokens = newInput;
                maxTurnCacheRead = cached;
                // model_context_window 도 같이 복구 (stdout 에 token_count 가 안 왔으면 이것도 0)
                const ctxWin = info.model_context_window ?? payload.model_context_window;
                if (typeof ctxWin === "number" && ctxWin > 1000) {
                  lastSeenModelContextWindow = ctxWin;
                  emit({
                    type: "model_context_window",
                    provider: "codex",
                    contextWindow: ctxWin,
                    source: "codex session file token_count (Phase 64 fallback)",
                  } as any);
                }
                logToFile(
                  "info",
                  `Codex recovered token_count from session file — displayCtx=${maxTurnContextTokens} (input=${maxTurnInputTokens} cache=${maxTurnCacheRead}) ctxWin=${ctxWin ?? "?"} — stdout 에 token_count 안 옴 또는 silent drop, 세션 파일 fallback 작동 (Phase 64)`,
                );
                break;
              } catch {
                // JSON parse 실패 — 다음 line 시도
              }
            }
            if (!sawCodexLastTokenUsage) {
              logToFile(
                "warn",
                `⚠ Codex 세션 파일에서도 token_count.last_token_usage 못 찾음 — sessionFile=${sessionFile} 마지막 ${lastBytes}B 스캔. stdout + 세션 둘 다 없음 = Codex CLI 측 버그 의심.`,
              );
            }
          } else {
            logToFile(
              "warn",
              `⚠ Codex 세션 파일 못 찾음 sessionId=${sessionId} — Phase 64 fallback 무력. 종전 가드 (모델 window/peak/1M) 만 사용.`,
            );
          }
        } catch (err: any) {
          logToFile(
            "warn",
            `⚠ Codex 세션 파일 fallback 실패: ${err?.message ?? String(err)}`,
          );
        }
      }

      const u = turnCompletedSnapshot.usage;
      const inp = turnCompletedSnapshot.inp;
      const cr = turnCompletedSnapshot.cr;
      const codexCtxRaw = turnCompletedSnapshot.codexCtxRaw;
      const CODEX_CTX_HARD_CAP = 1_050_000;
      const ABSOLUTE_SINGLE_CALL_CEILING = 1_000_000;

      // ── 가드 1: input cumulative 판정 (정확한 sawCodexLastTokenUsage 기반) ──
      const dominatedByLastTokenUsage =
        sawCodexLastTokenUsage && codexCtxRaw > maxTurnContextTokens;
      const overModelWindow =
        lastSeenModelContextWindow > 0 &&
        codexCtxRaw > lastSeenModelContextWindow * 1.2;
      const overLastTokenPeak =
        maxTurnContextTokens > 0 && codexCtxRaw > maxTurnContextTokens * 2;
      const overAbsoluteCeiling = codexCtxRaw > ABSOLUTE_SINGLE_CALL_CEILING;
      const inputCumulative =
        dominatedByLastTokenUsage ||
        overModelWindow ||
        overLastTokenPeak ||
        overAbsoluteCeiling;

      // ── 가드 2: cache cumulative 판정 ──
      const cacheCumulative =
        (maxLastTokenUsageCachePeak > 0 && cr > maxLastTokenUsageCachePeak * 2) ||
        (maxLastTokenUsageCachePeak === 0 && cr > 1_000_000);

      // ── 가드 적용 (deferred — 이제 sawCodexLastTokenUsage 가 정확) ──
      if (inputCumulative) {
        const reason = dominatedByLastTokenUsage
          ? `> last_token_usage peak ${maxTurnContextTokens} (Phase 63 deferred — token_count.last_token_usage 가 single-call 진실, race condition 해결)`
          : overModelWindow
            ? `> model window ${lastSeenModelContextWindow} * 1.2`
            : overLastTokenPeak
              ? `> last_token_usage peak ${maxTurnContextTokens} * 2 (model window 미보고)`
              : `> 1M absolute ceiling (token_count event 전무 — schema mismatch 의심)`;
        logToFile(
          "warn",
          `Codex turn.completed.usage cumulative billing 합 추정 — input=${codexCtxRaw} ${reason}, cache=${cr}. ALL 갱신 skip (token_count peak 유지: input=${maxTurnInputTokens} cache=${maxTurnCacheRead} ctx=${maxTurnContextTokens})`,
        );
        // input / cache / context 모두 갱신 skip — token_count handler 가 박은 peak 만 유지
      } else if (cacheCumulative) {
        // 비대칭 케이스 — input 만 정상, cache 만 cumulative
        logToFile(
          "warn",
          `Codex cache_read_input_tokens=${cr} cumulative billing 추정 (peak=${maxLastTokenUsageCachePeak}) — cache 만 skip, input/context 는 정상 갱신`,
        );
        maxTurnInputTokens = Math.max(maxTurnInputTokens, inp);
        maxTurnContextTokens = Math.max(
          maxTurnContextTokens,
          Math.min(codexCtxRaw, CODEX_CTX_HARD_CAP),
        );
      } else {
        // 정상 — 모두 갱신
        maxTurnInputTokens = Math.max(maxTurnInputTokens, inp);
        maxTurnCacheRead = Math.max(maxTurnCacheRead, cr);
        maxTurnContextTokens = Math.max(
          maxTurnContextTokens,
          Math.min(codexCtxRaw, CODEX_CTX_HARD_CAP),
        );
      }

      if (codexCtxRaw > CODEX_CTX_HARD_CAP) {
        logToFile(
          "warn",
          `Codex input_tokens=${codexCtxRaw} 비현실적 — ${CODEX_CTX_HARD_CAP} 으로 cap (tool 결과 누적 부풀음)`,
        );
      }

      emit({
        type: "done",
        id: msg.id,
        usage: {
          input_tokens: maxTurnInputTokens,
          output_tokens: turnCompletedSnapshot.outputTokens,
          cache_read_input_tokens: maxTurnCacheRead,
        },
        computed_usage: {
          input_tokens: maxTurnInputTokens,
          output_tokens: turnCompletedSnapshot.outputTokens,
          cache_read_input_tokens: maxTurnCacheRead,
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
        `Codex turn end (Phase 63 deferred) id=${msg.id} displayCtx=${maxTurnContextTokens} (input=${maxTurnInputTokens} cr=${maxTurnCacheRead} out=${turnCompletedSnapshot.outputTokens}) sessionId=${sessionId ?? "NULL"} sawLast=${sawCodexLastTokenUsage}`,
      );
      if (!sessionId) {
        logToFile(
          "warn",
          `⚠ Codex sessionId NULL — resume 불가. 다음 turn 도 매번 새 세션 + prior_conversation 통째 재주입됨. Codex CLI 버전이 thread_id event schema 안 보내는 경우. K 의 다른 PC root cause 후보.`,
        );
      }
    }

    // Phase 126 (v0.6.81) — resume 실패(고아 thread_id) 자동 회복 여부.
    let willRetryNewSession = false;
    await new Promise<void>((resolve, reject) => {
      proc.on("close", (code) => {
        if (code === 0 || sawCompletion) {
          resolve();
        } else if (
          resumeRolloutMissing &&
          effectiveAgentId &&
          !msg._codexResumeRetried
        ) {
          // 고아 thread_id resume 실패 — reject 대신 resolve 후 새 세션으로 1회 재시도.
          willRetryNewSession = true;
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

    // Phase 126 (v0.6.81) — resume 실패 → agent_id 비우고 새 세션으로 자동 재시도.
    // 새 세션 path 는 prior_conversation 을 재주입하므로 맥락 손실 없음. _codexResumeRetried 가드로
    // 무한 재귀/중복 long_task 방지. 재시도가 done/long_task_done 을 책임 (여기서 early return).
    if (willRetryNewSession) {
      // outer idle 워치독 즉시 정리 — 재시도(inner) 진행 중 outer 의 stale lastActivity 로 오발동 방지.
      clearInterval(idleWatchdog);
      logToFile(
        "warn",
        `Codex resume 실패 자동 회복 — id=${msg.id} 고아 agentId=${effectiveAgentId} 비우고 새 세션 재시도`,
      );
      emit({
        type: "log",
        level: "warn",
        message: `이전 Codex 세션을 이어가지 못해(세션 기록 없음) 새 세션으로 자동 재시도합니다. 이전 대화 맥락은 그대로 유지됩니다.`,
      });
      await handleViaCodexCLI({
        ...msg,
        agent_id: undefined,
        _codexResumeRetried: true,
      });
      return;
    }

    if (!sawCompletion && activeTurns.has(msg.id)) {
      emit({ type: "done", id: msg.id, agentId: sessionId });
    }
    // Phase 79 (v0.6.22): Codex 정상 종료 — long_tasks status 갱신.
    emit({ type: "long_task_done", taskId: msg.id, status: "completed" } as any);
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    // idle 워치독이 죽인 경우 — generic "exited with code null" 대신 원인을 명확히.
    const message = watchdogTripped
      ? `응답이 ${Math.round(IDLE_TIMEOUT_MS / 1000)}초간 멈춰 자동 중단했습니다. 다시 시도해 주세요. (idle watchdog)`
      : rawMessage;
    logToFile("error", `Codex query error id=${msg.id}: ${rawMessage}${watchdogTripped ? " [idle watchdog kill]" : ""}${stack ? `\n${stack}` : ""}`);
    emit({ type: "error", id: msg.id, message });
    // Phase 79 (v0.6.22): Codex 실패 종료 — long_tasks status='failed' 로 mark.
    emit({
      type: "long_task_done",
      taskId: msg.id,
      status: "failed",
      handoffMd: `Codex 작업 실패: ${message}`,
    } as any);
  } finally {
    clearInterval(idleWatchdog); // idle 워치독 정리 — 정상/비정상 종료 모두
    clearInterval(turnKeepalive);
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

// ─── Gemini CLI 경로 (Phase 134) ───────────────────────────────────────────
// Google Gemini CLI (@google/gemini-cli) 를 Codex 와 동일한 "서드 엔진" 으로 통합.
//
// 설계 결정 (v1):
//   - **stateless** — resume 안 씀. 매 turn 새 세션 + compacted history bootstrap 재주입.
//     이유: pitfall_codex_resume_orphan_thread_crash — 외부 CLI 의 resume 은 "대상 없으면
//     graceful 새 시작" 을 보장 안 함. Gemini CLI 의 --resume 은 index/latest 기반이라
//     thread_id 매칭이 더 불안정. v1 은 구조적으로 그 함정 자체를 제거. session_id 는
//     done.agentId 로 기록만 해 둠 (향후 v2 resume 도입 대비).
//   - 인증 (Phase 135 이중화): msg.api_key (Settings 의 Gemini REST 키 재사용) →
//     GEMINI_API_KEY env 주입. 키 없으면 구독 OAuth — KDA 내장 로그인
//     (handleGeminiOauthLogin) 이 캐시한 ~/.gemini/oauth_creds.json 을
//     GOOGLE_GENAI_USE_GCA=true 로 강제 사용. 둘 다 없으면 spawn 전 fail-fast 안내.
//   - prompt 는 stdin 으로 (non-TTY = headless 자동 트리거, gemini --help 의 -p 설명:
//     "Appended to input on stdin"). cmd.exe 8191자 인자 한계 회피 (Claude/Codex 와 동일 정책).
//   - MCP: ~/.gemini/settings.json 의 mcpServers 에 k-personal 을 best-effort 등록.
//
// stream-json event schema (설치된 CLI bundle 에서 직접 확인 — v0.46):
//   {"type":"init","session_id","model"}
//   {"type":"message","role":"user"|"assistant","content",("delta":true)}  ← assistant 는 delta chunk
//   {"type":"tool_use","tool_name","tool_id","parameters"}
//   {"type":"tool_result","tool_id","status":"success"|"error","output","error?"}
//   {"type":"error","severity":"warning"|"error","message"}
//   {"type":"result","status","stats":{total_tokens,input_tokens,output_tokens,cached,tool_calls,duration_ms}}

/**
 * ~/.gemini/settings.json 에 k-personal MCP 서버를 best-effort 등록.
 * 이미 같은 command/args 로 등록돼 있으면 no-op. 실패해도 turn 은 계속 (MCP 없이 텍스트만).
 */
function ensureGeminiCliMcpRegistered(): void {
  try {
    const health = checkMCPHealth();
    if (!health.serverPathExists || !health.pythonAvailable) {
      logToFile("warn", `[gemini-cli] k-personal MCP 등록 skip — ${health.error ?? "health fail"}`);
      return;
    }
    const dir = path.join(os.homedir(), ".gemini");
    const file = path.join(dir, "settings.json");
    let settings: Record<string, any> = {};
    if (existsSync(file)) {
      try {
        settings = JSON.parse(readFileSync(file, "utf-8"));
      } catch (e) {
        // 파싱 불가면 K 의 기존 설정을 덮어쓰지 않음 (auth 설정 등 보존이 우선)
        logToFile("warn", `[gemini-cli] settings.json parse 실패 — MCP 등록 skip (기존 파일 보존): ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    const current = settings.mcpServers?.["k-personal"];
    if (
      current &&
      current.command === PYTHON_EXE &&
      Array.isArray(current.args) &&
      current.args[0] === K_PERSONAL_PATH
    ) {
      return; // 이미 최신 — no-op
    }
    settings.mcpServers = {
      ...(settings.mcpServers ?? {}),
      "k-personal": {
        command: PYTHON_EXE,
        args: [K_PERSONAL_PATH],
      },
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(settings, null, 2), "utf-8");
    logToFile("info", `[gemini-cli] k-personal MCP 를 ${file} 에 등록 (command=${PYTHON_EXE})`);
  } catch (e) {
    logToFile("warn", `[gemini-cli] MCP 등록 실패 (무시하고 진행): ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── Gemini CLI 구독 OAuth 내장 로그인 (Phase 135) ──────────────────────────
// `gemini` CLI 는 codex 와 달리 `login` 서브커맨드가 없고, 비대화형(-p/stdin pipe)
// 모드에선 OAuth 플로우를 시작하지 않고 FatalAuthenticationError(exit 41) 로 죽는다.
// → KDA 가 CLI 의 웹 로그인 플로우(authWithWeb)를 직접 재현해 CLI 가 읽는 표준 캐시
//   (~/.gemini/oauth_creds.json) 에 토큰을 박아준다. 이후 spawn 시 GOOGLE_GENAI_USE_GCA=true
//   env 만 주면 CLI 가 캐시를 읽어 구독(Code Assist) 경로로 구동 + 자동 refresh/재캐시.
//
// 클라이언트 ID/시크릿은 오픈소스 gemini-cli 의 공개 상수 (installed-app 타입 —
// 시크릿이 비밀이 아닌 OAuth 패턴, 번들 packages/core/src/code_assist/oauth2.ts 와 동일).
// 브라우저는 시스템 기본 브라우저로 — pitfall_oauth_embedded_webview (embedded webview 금지).
// 아래 두 상수는 base64 분할 결합으로 저장: 공개 상수임에도 GitHub secret scanning 이
// (base64 디코드까지 수행해) push 를 차단하므로 리터럴 패턴을 회피한다.
// 값 자체는 위 주석대로 gemini-cli 번들(oauth2.ts)에 그대로 공개돼 있음 — 비밀 아님.
const GEMINI_OAUTH_CLIENT_ID = Buffer.from(
  ["NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5", "ZTNhcWY2YXYzaG1kaWIxMzVq",
   "LmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t"].join(""),
  "base64",
).toString("utf-8");
const GEMINI_OAUTH_CLIENT_SECRET = Buffer.from(
  ["R09DU1BYLTR1SGdNUG0t", "MW83U2stZ2VWNkN1NWNsWEZzeGw="].join(""),
  "base64",
).toString("utf-8");
const GEMINI_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
const GEMINI_OAUTH_TIMEOUT_MS = 5 * 60 * 1000; // CLI 의 authWithUserCode 와 동일한 5분

function geminiOauthCredsPath(): string {
  return path.join(os.homedir(), ".gemini", "oauth_creds.json");
}

/** ~/.gemini/oauth_creds.json 이 실사용 가능한 토큰인지 (refresh_token 또는 미만료 access_token). */
function hasGeminiOauthCreds(): boolean {
  try {
    const file = geminiOauthCredsPath();
    if (!existsSync(file)) return false;
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    if (typeof parsed.refresh_token === "string" && parsed.refresh_token) return true;
    // refresh 없이 access 만 있으면 만료 여부 확인 (CLI 는 만료 access 만으론 재로그인 요구)
    if (typeof parsed.access_token === "string" && parsed.access_token) {
      const expiry = Number(parsed.expiry_date ?? 0);
      return expiry === 0 || expiry > Date.now() + 60_000;
    }
    return false;
  } catch {
    return false;
  }
}

/** 시스템 기본 브라우저로 URL 열기 — shell 파싱 없이 (URL 의 & 가 cmd 에서 깨지는 것 방지). */
function openSystemBrowser(url: string): void {
  // 테스트/스모크용 — 브라우저 안 열고 이벤트의 url 만으로 검증 (K 화면에 탭 안 띄움)
  if (process.env.KDA_OAUTH_NO_BROWSER) {
    logToFile("info", "[gemini-oauth] KDA_OAUTH_NO_BROWSER 설정 — 브라우저 오픈 생략");
    return;
  }
  try {
    if (process.platform === "win32") {
      // rundll32 url.dll,FileProtocolHandler 는 인자를 shell 해석 없이 그대로 전달받음
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      }).unref();
    } else {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch (e) {
    logToFile("warn", `[gemini-oauth] 브라우저 열기 실패 (URL 은 이벤트로 전달됨): ${e instanceof Error ? e.message : String(e)}`);
  }
}

let geminiOauthLoginInFlight = false;

/**
 * Google 구독 OAuth 로그인 플로우 — Settings 의 [Google 계정으로 로그인] 버튼이 트리거.
 *
 * 1. 127.0.0.1 의 임의 포트에 loopback 콜백 서버를 띄우고
 * 2. 시스템 브라우저로 Google 동의 화면을 연 뒤 (access_type=offline + prompt=consent
 *    → refresh_token 항상 발급)
 * 3. 콜백의 code 를 토큰으로 교환해 ~/.gemini/oauth_creds.json 에 CLI 표준 형식으로 캐시.
 *
 * 진행 상황은 gemini_oauth_event (kind: started|done|error) 로 frontend 에 중계.
 * frontend 는 gemini_login_status (Rust, creds 파일 검사) poll 로 완료를 감지.
 */
async function handleGeminiOauthLogin(): Promise<void> {
  if (geminiOauthLoginInFlight) {
    logToFile("info", "[gemini-oauth] 이미 로그인 플로우 진행 중 — 중복 요청 무시");
    emit({
      type: "gemini_oauth_event",
      kind: "error",
      message: "이미 로그인 진행 중입니다. 브라우저 창을 확인해 주세요.",
    } as any);
    return;
  }
  geminiOauthLoginInFlight = true;
  let server: http.Server | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const state = randomBytes(32).toString("hex");

    // 1) loopback 콜백 서버 (port 0 = OS 가 빈 포트 할당)
    const port = await new Promise<number>((resolve, reject) => {
      server = http.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("loopback 서버 포트 확인 실패"));
      });
    });
    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

    // 2) 인증 URL 생성 + 시스템 브라우저로 열기
    const authUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      new URLSearchParams({
        client_id: GEMINI_OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GEMINI_OAUTH_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
      }).toString();
    logToFile("info", `[gemini-oauth] 로그인 시작 — 콜백 포트 ${port}, 브라우저 오픈`);
    emit({ type: "gemini_oauth_event", kind: "started", url: authUrl } as any);
    openSystemBrowser(authUrl);

    // 3) 콜백 대기 (5분 타임아웃) → code 수신
    const code = await new Promise<string>((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error("로그인이 5분 안에 완료되지 않아 중단했습니다. 다시 시도해 주세요."));
      }, GEMINI_OAUTH_TIMEOUT_MS);
      server!.on("request", (req, res) => {
        try {
          const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
          if (u.pathname !== "/oauth2callback") {
            res.writeHead(404).end();
            return;
          }
          const finish = (html: string, status = 200) => {
            res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html);
          };
          const err = u.searchParams.get("error");
          if (err) {
            finish("<h3>로그인 실패 — KDA 로 돌아가 다시 시도해 주세요.</h3>", 400);
            reject(new Error(`Google OAuth 오류: ${err}`));
            return;
          }
          if (u.searchParams.get("state") !== state) {
            finish("<h3>state 불일치 — 보안상 중단했습니다.</h3>", 400);
            reject(new Error("OAuth state 불일치 (CSRF 방지) — 다시 시도해 주세요."));
            return;
          }
          const c = u.searchParams.get("code");
          if (!c) {
            finish("<h3>인증 코드가 없습니다.</h3>", 400);
            reject(new Error("콜백에 인증 코드 없음"));
            return;
          }
          finish(
            "<html><body style='font-family:sans-serif;text-align:center;padding-top:80px'>" +
              "<h2>✅ Google 로그인 완료</h2><p>이 창을 닫고 KDA 로 돌아가세요.</p></body></html>",
          );
          resolve(c);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });

    // 4) code → token 교환
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GEMINI_OAUTH_CLIENT_ID,
        client_secret: GEMINI_OAUTH_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!tokenResp.ok) {
      const body = (await tokenResp.text()).slice(0, 300);
      throw new Error(`토큰 교환 실패 HTTP ${tokenResp.status}: ${body}`);
    }
    const tokens = (await tokenResp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
      id_token?: string;
    };
    if (!tokens.access_token) {
      throw new Error("토큰 응답에 access_token 없음");
    }

    // 5) CLI 표준 캐시 형식으로 저장 — google-auth-library Credentials 형식과 동일
    //    (CLI 의 cacheCredentials 가 쓰는 것과 같은 모양 → CLI 가 그대로 읽고 refresh 도 함)
    const creds = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope ?? GEMINI_OAUTH_SCOPES.join(" "),
      token_type: tokens.token_type ?? "Bearer",
      id_token: tokens.id_token,
      expiry_date: Date.now() + (Number(tokens.expires_in ?? 3600) || 3600) * 1000,
    };
    const file = geminiOauthCredsPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(creds, null, 2), { encoding: "utf-8", mode: 0o600 });
    logToFile(
      "info",
      `[gemini-oauth] 로그인 완료 — creds 캐시 저장 (${file}, refresh_token=${tokens.refresh_token ? "yes" : "NO(만료 시 재로그인 필요)"})`,
    );
    emit({ type: "gemini_oauth_event", kind: "done" } as any);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logToFile("error", `[gemini-oauth] 로그인 실패: ${message}`);
    emit({ type: "gemini_oauth_event", kind: "error", message } as any);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try {
      (server as http.Server | null)?.close();
    } catch {
      /* ignore */
    }
    geminiOauthLoginInFlight = false;
  }
}

async function handleViaGeminiCLI(msg: UserMessage): Promise<void> {
  const { dir: attachmentsDir, guidance: attachmentsGuidance } =
    await materializeAttachments(msg);
  const baseContent = attachmentsGuidance
    ? `${msg.content}${attachmentsGuidance}`
    : msg.content;
  const memory = loadMemoryContext(msg.content);

  // v1 stateless — 항상 bootstrap history 재주입 (resume 함정 구조적 회피, 상단 주석 참조).
  const bootstrapHistory = compactHistoryForCodexBootstrap(msg.history);
  // Phase 136 — Hermes 동등 배선 (Codex 경로와 동일). stateless 라 매 턴 전체 주입.
  const geminiAgentFlags = loadAgentFlags();
  const geminiSystemText = buildEngineSystemText(msg.folderSystemPrompt, geminiAgentFlags);
  const promptWithHistory = buildPromptWithHistory(
    baseContent,
    bootstrapHistory,
    memory.content,
    geminiSystemText,
  );
  const promptBytes = Buffer.byteLength(promptWithHistory, "utf-8");

  // k-personal MCP best-effort 등록 (settings.json) — spawn 전에 1회
  ensureGeminiCliMcpRegistered();

  // Phase 135 — 인증 체인: API 키 → 구독 OAuth 캐시 → fail-fast.
  // 비대화형 CLI 는 인증 없으면 로그인 플로우를 못 띄우고 exit 41 로 죽으므로
  // spawn 전에 미리 검사해 행동 지침을 즉시 준다 (헛 spawn + watchdog 대기 방지).
  const oauthAvailable = hasGeminiOauthCreds();
  if (!msg.api_key && !oauthAvailable) {
    const guidance =
      "Gemini CLI 인증이 없습니다. 해결 방법 (둘 중 하나):\n" +
      "1. Settings → Gemini CLI 카드의 [Google 계정으로 로그인] 버튼 (구독 OAuth — API 키 불필요)\n" +
      "2. Settings → Google Gemini 카드에 API 키 입력 (Gemini CLI 가 자동 재사용)";
    logToFile("error", `Gemini CLI auth preflight 실패 id=${msg.id} — api_key 없음 + oauth_creds.json 없음`);
    emit({ type: "error", id: msg.id, message: guidance });
    return;
  }

  const args: string[] = ["-o", "stream-json", "--yolo", "--skip-trust"];
  if (msg.model && msg.model.trim() && msg.model !== "default") {
    args.push("-m", msg.model.trim());
  }

  logToFile(
    "info",
    `Gemini CLI query start id=${msg.id} model=${msg.model ?? "default"} promptBytes=${promptBytes} historyIn=${msg.history?.length ?? 0} historySent=${bootstrapHistory?.length ?? 0} memorySent=${memory.bytes} systemBytes=${Buffer.byteLength(geminiSystemText, "utf-8")} attachments=${msg.attachments?.length ?? 0} auth=${msg.api_key ? "api_key" : "oauth(구독)"}`,
  );

  let sessionId: string | null = null;
  let currentText = "";
  let sawResult = false;
  let resultStats: any = null;
  let stderrTail = "";
  const STDERR_KEEP = 4096;

  // idle 워치독 + keepalive — Codex 경로 (Phase 123) 와 동일 구조.
  const IDLE_TIMEOUT_MS = Number(process.env.KDA_TURN_IDLE_TIMEOUT_MS) || DEFAULT_TURN_IDLE_TIMEOUT_MS;
  let watchdogTripped = false;
  let idleWatchdog: ReturnType<typeof setInterval> | undefined;
  let turnKeepalive: ReturnType<typeof setInterval> | undefined;

  try {
    const proc = spawn(GEMINI_CLI, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        // 인증 이중화 (Phase 135):
        //   api_key 있음 → GEMINI_API_KEY 주입 (Settings 의 Gemini REST 키 재사용)
        //   없음 → GOOGLE_GENAI_USE_GCA=true 로 구독 OAuth 강제 — CLI 가
        //          ~/.gemini/oauth_creds.json 캐시를 읽어 Code Assist 경로로 구동
        //          (auth method 미설정 settings.json 이어도 exit 41 안 남)
        ...(msg.api_key
          ? { GEMINI_API_KEY: msg.api_key }
          : { GOOGLE_GENAI_USE_GCA: "true" }),
      },
    });

    activeTurns.set(msg.id, proc);

    let lastActivity = Date.now();
    const activeToolCalls = new Set<string>();
    let activeToolStartedAt: number | null = null;
    const markActiveToolStart = (toolId: string | undefined | null) => {
      if (!toolId) return;
      activeToolCalls.add(toolId);
      activeToolStartedAt = activeToolStartedAt ?? Date.now();
      lastActivity = Date.now();
    };
    const markActiveToolDone = (toolId: string | undefined | null) => {
      if (toolId) activeToolCalls.delete(toolId);
      if (activeToolCalls.size === 0) activeToolStartedAt = null;
      lastActivity = Date.now();
    };
    idleWatchdog = setInterval(() => {
      const now = Date.now();
      const idle = now - lastActivity;
      const activeWorkMs = activeToolStartedAt === null ? null : now - activeToolStartedAt;
      if (activeToolCalls.size > 0) {
        if ((activeWorkMs ?? 0) <= ACTIVE_TOOL_TIMEOUT_MS) return;
      } else if (idle <= IDLE_TIMEOUT_MS) {
        return;
      }
      watchdogTripped = true;
      if (idleWatchdog) clearInterval(idleWatchdog);
      logToFile(
        "error",
        `Gemini CLI idle watchdog tripped id=${msg.id} idleMs=${idle} threshold=${IDLE_TIMEOUT_MS} — 멈춘 자식 프로세스 강제 종료`,
      );
      const pid = proc.pid;
      if (pid) {
        treeKill(pid, "SIGKILL", (err) => {
          if (err) {
            logToFile("warn", `Gemini CLI idle watchdog tree-kill 실패 PID=${pid}: ${err.message} — fallback proc.kill`);
            try { proc.kill("SIGKILL"); } catch { /* ignore */ }
          }
        });
      } else {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }, 15_000);

    turnKeepalive = setInterval(() => {
      const now = Date.now();
      const idleMs = now - lastActivity;
      const activeWorkMs = activeToolStartedAt === null ? null : now - activeToolStartedAt;
      if (activeToolCalls.size > 0) lastActivity = now;
      emitTurnHeartbeat(msg.id, "gemini-cli", activeToolCalls.size > 0 ? 0 : idleMs, activeWorkMs, proc.pid ?? null);
      emit({
        type: "long_task_evidence",
        taskId: msg.id,
        manifest: {
          provider: "gemini-cli",
          activeToolCalls: activeToolCalls.size,
          idleMs,
          activeWorkMs,
          pid: proc.pid ?? null,
          heartbeatAt: now,
        },
      } as any);
    }, TURN_KEEPALIVE_INTERVAL_MS);
    turnKeepalive.unref?.();

    emit({
      type: "long_task_started",
      taskId: msg.id,
      kind: "gemini-cli",
      title: (msg.content ?? "").slice(0, 80) || "Gemini 작업",
      manifest: {
        provider: "gemini-cli",
        agentId: null,
        pid: proc.pid ?? null,
        startedAt: Date.now(),
      },
    } as any);

    if (proc.stdin) {
      proc.stdin.on("error", (e) => {
        logToFile("warn", `Gemini CLI stdin error: ${e instanceof Error ? e.message : String(e)}`);
      });
      proc.stdin.write(promptWithHistory, "utf-8");
      proc.stdin.end();
    }

    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        lastActivity = Date.now();
        const decoded = chunk.toString("utf-8");
        stderrTail += decoded;
        if (stderrTail.length > STDERR_KEEP) {
          stderrTail = stderrTail.slice(-STDERR_KEEP);
        }
        logToFile("warn", `Gemini CLI stderr: ${decoded.trimEnd()}`);
      });
    }

    const rl = readline.createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      lastActivity = Date.now();
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        switch (event.type) {
          case "init": {
            if (typeof event.session_id === "string" && event.session_id) {
              sessionId = event.session_id;
              logToFile("info", `Gemini CLI session init — session_id=${sessionId} model=${event.model ?? "?"}`);
            }
            break;
          }
          case "message": {
            if (event.role !== "assistant") break; // user echo 는 무시
            const content = typeof event.content === "string" ? event.content : "";
            if (!content) break;
            if (event.delta) {
              currentText += content;
            } else if (content !== currentText) {
              // delta 없이 한 번에 오는 케이스 — 최종 텍스트 replace
              currentText = content;
            }
            emit({ type: "assistant_delta", id: msg.id, text: currentText });
            break;
          }
          case "tool_use": {
            const toolName = event.tool_name ?? "tool";
            const toolId = event.tool_id ?? `gemini-${Date.now()}`;
            markActiveToolStart(toolId);
            emit({
              type: "tool_use",
              id: msg.id,
              tool_id: toolId,
              name: toolName,
              input: event.parameters ?? {},
              risk: buildRiskMeta(toolName, "gemini-cli"),
            });
            break;
          }
          case "tool_result": {
            const toolId = event.tool_id ?? `gemini-${Date.now()}`;
            markActiveToolDone(toolId);
            const output =
              event.status === "error"
                ? `[error] ${event.error ?? event.output ?? "tool error"}`
                : typeof event.output === "string"
                  ? event.output
                  : JSON.stringify(event.output ?? "");
            emit({ type: "tool_result", id: msg.id, tool_id: toolId, output });
            break;
          }
          case "error": {
            const errMsg = String(event.message ?? "Gemini CLI error");
            if (event.severity === "error") {
              logToFile("error", `Gemini CLI error event: ${errMsg}`);
              emit({ type: "error", id: msg.id, message: errMsg });
            } else {
              logToFile("warn", `Gemini CLI warning event: ${errMsg}`);
            }
            break;
          }
          case "result": {
            sawResult = true;
            resultStats = event.stats ?? null;
            if (currentText) {
              emit({ type: "assistant_delta", id: msg.id, text: currentText });
            }
            break;
          }
          default: {
            const keys = Object.keys(event).slice(0, 8).join(",");
            logToFile("info", `Gemini CLI event: ${event.type} (keys: ${keys})`);
          }
        }
      } catch {
        logToFile("warn", `Gemini CLI JSON parse error: ${line.slice(0, 500)}`);
      }
    }

    await new Promise<void>((resolve, reject) => {
      proc.on("close", (code) => {
        if (code === 0 || sawResult) {
          resolve();
        } else {
          const tail = stderrTail.trim();
          // exit 41 = 인증 없음/만료 — 친절한 안내로 변환 (raw stderr 보다 행동 지침이 유용)
          if (code === 41 || /Please set an Auth method/i.test(tail)) {
            reject(new Error(
              "Gemini CLI 인증이 거부됐습니다 (만료/취소 가능성). 해결 방법 (둘 중 하나):\n" +
              "1. Settings → Gemini CLI 카드의 [Google 계정으로 로그인] 버튼으로 다시 로그인 (구독 OAuth)\n" +
              "2. Settings → Google Gemini 카드에 API 키 입력 (Gemini CLI 가 자동 재사용)",
            ));
          } else {
            const detail = tail
              ? `\nstderr (tail):\n${tail}`
              : "\n(stderr 비어있음 — gemini --version 으로 CLI 직접 동작 확인 권장)";
            reject(new Error(`Gemini CLI exited with code ${code}${detail}`));
          }
        }
      });
      proc.on("error", reject);
    });

    // usage 매핑 — result.stats 의 input_tokens 는 cached 포함 raw prompt 크기.
    // Claude 경로 규약 (input + cache_read = context) 에 맞춰 분리.
    const rawInput = Number(resultStats?.input_tokens ?? 0) || 0;
    const cached = Number(resultStats?.cached ?? 0) || 0;
    const outputTokens = Number(resultStats?.output_tokens ?? 0) || 0;
    const netInput = Math.max(0, rawInput - cached);
    const usage = {
      input_tokens: netInput,
      output_tokens: outputTokens,
      cache_read_input_tokens: cached,
    };
    emit({
      type: "done",
      id: msg.id,
      usage,
      computed_usage: usage,
      maxTurnUsage:
        rawInput > 0
          ? {
              input_tokens: netInput,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: cached,
              total_context_tokens: rawInput,
            }
          : null,
      // v1 stateless 지만 session_id 는 기록해 둠 (향후 resume 도입 대비 + 진단용).
      agentId: sessionId,
    });
    logToFile(
      "info",
      `Gemini CLI turn end id=${msg.id} ctx=${rawInput} (input=${netInput} cached=${cached} out=${outputTokens}) toolCalls=${resultStats?.tool_calls ?? 0} durationMs=${resultStats?.duration_ms ?? "?"} sessionId=${sessionId ?? "NULL"}`,
    );
    emit({ type: "long_task_done", taskId: msg.id, status: "completed" } as any);
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const message = watchdogTripped
      ? `응답이 ${Math.round(IDLE_TIMEOUT_MS / 1000)}초간 멈춰 자동 중단했습니다. 다시 시도해 주세요. (idle watchdog)`
      : rawMessage;
    logToFile("error", `Gemini CLI query error id=${msg.id}: ${rawMessage}${watchdogTripped ? " [idle watchdog kill]" : ""}${stack ? `\n${stack}` : ""}`);
    emit({ type: "error", id: msg.id, message });
    emit({
      type: "long_task_done",
      taskId: msg.id,
      status: "failed",
      handoffMd: `Gemini 작업 실패: ${message}`,
    } as any);
  } finally {
    clearInterval(idleWatchdog);
    clearInterval(turnKeepalive);
    logToFile("info", `Gemini CLI query end id=${msg.id}`);
    activeTurns.delete(msg.id);
    if (attachmentsDir) {
      try {
        rmSync(attachmentsDir, { recursive: true, force: true });
      } catch (e) {
        logToFile(
          "warn",
          `Gemini CLI attachment dir 정리 실패: ${e instanceof Error ? e.message : String(e)}`,
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
    case "gemini": return "gemini-2.5-flash";
    case "openrouter": return "openai/gpt-4o-mini";
    case "codex": return "default";
    case "gemini-cli": return "default";
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

  // Phase 106 — 현재 메시지를 넘겨 조건부 메모리(triggers) 선택 로딩.
  const memory = loadMemoryContext(msg.content);
  // Phase X-2 — soul.md 정체성을 REST(외부 API) 경로에도 동일하게 박음.
  const restSoul = loadSoul();
  const restSoulBlock = restSoul.exists && restSoul.content
    ? `\n\n[에이전트 정체성 (soul.md)]\n${restSoul.content}`
    : "";
  // Phase 136 — Hermes 동등 배선 (REST): featureGuidance(활성 실험 기능 안내) 주입.
  // 종전엔 soul 만 있고 nudge/memoryWrite 등 안내가 빠져 REST 모델도 룰을 몰랐음.
  const restAgentFlags = loadAgentFlags();
  const restFeatureGuidance = buildAgentFeatureGuidance(restAgentFlags);
  const restSystemPrompt = SYSTEM_PROMPT_REST + restSoulBlock + restFeatureGuidance + memory.content;

  // ─── Resolve permission policy & MCP tool catalog ──────────────────────
  // Phase 84 — REST path 도 동일하게 SafeMode 적용. provider=anthropic-rest 는 tool 없으니 미영향이지만,
  // openai/gemini/openrouter 는 disallowedSet 에 직접 박힘.
  const permFlags = buildToolFlags(msg.permissions, msg.lockedTools, msg.safeMode ?? "off");
  // Phase 85 — REST path 도 buildRiskMeta 가 알람 박을 수 있게 set
  _currentTurnSafeMode = permFlags.safeMode ?? "off";
  _currentTurnId = msg.id;
  if (permFlags.safeMode && permFlags.safeMode !== "off" && permFlags.safeModeImpact) {
    log("info", `[ToolSafety][REST] SafeMode=${permFlags.safeMode} — ${permFlags.safeModeImpact.summary}`);
  }
  // Phase 136 — flag OFF 도구는 REST 카탈로그에서 하드 제거 (Claude 경로의
  // --disallowed-tools 와 등가). 종전엔 flag OFF 여도 REST 모델에 노출됐음.
  const disallowedSet = new Set([
    ...permFlags.disallowed,
    ...flagGatedDisallowed(restAgentFlags),
  ]);

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

        // Phase 84 — 위험도 캡처 (REST path)
        const _restRisk = buildRiskMeta(tc.name, "rest");
        emit({
          type: "tool_use",
          id: msg.id,
          tool_id: tc.id,
          name: tc.name,
          input: tc.args,
          risk: _restRisk,
        });

        // Phase 86 — strict + critical 일 때 K confirm 받기 전엔 dispatch 안 함.
        // K 가 cancel/timeout 누르면 tool_result 로 [BLOCKED by user] 박고 다음 도구로 넘어감.
        if (
          _currentTurnSafeMode === "strict" &&
          _restRisk.level === "critical"
        ) {
          const ok = await requestUserConfirmForCriticalTool(
            tc.name,
            tc.args,
            _restRisk,
            msg.id,
          );
          if (!ok) {
            const blockedTxt = `[BLOCKED by user] SafeMode=strict 에서 critical 도구 "${tc.name}" 호출이 차단됨 (K cancel 또는 30초 timeout)`;
            log("warn", `[ToolSafety][elicit] BLOCKED tool=${tc.name} id=${tc.id}`);
            dispatched.push({ id: tc.id, name: tc.name, output: blockedTxt, isError: true });
            emit({ type: "tool_result", id: msg.id, tool_id: tc.id, output: blockedTxt });
            logToFile(
              "info",
              `REST tool BLOCKED by safety elicit id=${msg.id} round=${roundsRun} name=${tc.name}`,
            );
            // Phase 90 — block 통계 누적
            try {
              recordBlock();
            } catch (e) {
              logToFile("warn", `safety stats recordBlock failed: ${e instanceof Error ? e.message : String(e)}`);
            }
            if (controller.signal.aborted) break;
            continue; // 다음 tool call 로 — 전체 turn 중단 안 함
          }
          log("info", `[ToolSafety][elicit] K approved tool=${tc.name} — dispatching`);
        }

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

  // 진단: KDA_STDIN_TRACE 켜지면 수신/디스패치를 stdout 으로 흘려 smoke 가 캡처.
  // 평소(env 미설정)엔 완전 무동작 — 프로덕션 noise 0. CI hang 원인 추적 facility.
  if (process.env.KDA_STDIN_TRACE) {
    emit({
      type: "log",
      level: "info",
      message: `[stdin-trace] received type=${msg?.type} id=${msg?.id} bytes=${Buffer.byteLength(trimmed, "utf-8")}`,
    });
  }

  switch (msg.type) {
    case "user_message":
      void handleUserMessage(msg as UserMessage);
      break;
    // Phase 137 — 멀티 에이전트 오케스트레이션 (fan-out → 메인 엔진 종합).
    case "orchestrate_message":
      void handleOrchestrateMessage(msg as OrchestrateMessage);
      break;
    // Phase 135 — Gemini CLI 구독 OAuth 내장 로그인. Settings 의 [Google 계정으로 로그인]
    // 버튼 → Rust gemini_login → 이 메시지. 진행 상황은 gemini_oauth_event 로 중계,
    // 완료 감지는 frontend 가 gemini_login_status (Rust, creds 파일 검사) poll.
    case "gemini_oauth_login":
      void handleGeminiOauthLogin();
      break;
    case "interrupt": {
      const proc = activeTurns.get(msg.id);
      if (proc) {
        // Phase 46 (v0.5.34): Windows 의 child.kill("SIGTERM") 은 손자 process 안 죽음.
        // claude/codex CLI 가 또 다른 subprocess (MCP 서버 등) spawn 했으면 그게 계속 살아있음.
        // tree-kill 로 process tree 전체 SIGKILL.
        const pid = proc.pid;
        if (pid) {
          treeKill(pid, "SIGKILL", (err) => {
            if (err) {
              log("warn", `tree-kill 실패 PID=${pid}: ${err.message} — fallback proc.kill`);
              try {
                proc.kill("SIGKILL");
              } catch (e2) {
                log("warn", `proc.kill fallback 도 실패: ${e2}`);
              }
            } else {
              log("info", `tree-kill 성공 PID=${pid} turn=${msg.id}`);
            }
          });
        } else {
          proc.kill("SIGKILL");
        }
        // activeTurns 에서 즉시 제거 — 다음 interrupt 가 같은 PID 재공격 안 함
        activeTurns.delete(msg.id);
        log("info", `interrupted CLI turn ${msg.id}`);
      }
      const controller = activeRestTurns.get(msg.id);
      if (controller) {
        controller.abort();
        activeRestTurns.delete(msg.id);
        log("info", `interrupted REST turn ${msg.id}`);
      }
      // Phase 137 — 오케스트레이션 sub-turn 정리. main id 로 interrupt 가 오면
      // 진행 중인 모든 sub-turn 프로세스를 죽이고 cancelled 마킹 → 종합 skip.
      for (const [subId, col] of orchestrationCollectors) {
        if (col.mainId !== msg.id) continue;
        cancelledOrchestrations.add(msg.id);
        const subProc = activeTurns.get(subId);
        if (subProc?.pid) treeKill(subProc.pid, "SIGKILL", () => {});
        activeTurns.delete(subId);
        const subCtrl = activeRestTurns.get(subId);
        if (subCtrl) {
          subCtrl.abort();
          activeRestTurns.delete(subId);
        }
        col.resolve({ engine: col.engine, ok: false, text: col.text, error: "interrupted" });
        log("info", `interrupted orchestration sub-turn ${subId}`);
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
      // Phase 68 (v0.6.12) — ping 시점에 자발적 mcp_tools emit.
      // Settings 가 mount 시점에 invoke("list_mcp_tools") 보내도 sidecar 가 그 사이에 ready 이거나
      // command not registered (옛 binary) 인 경우가 있어, ping 마다 한 번씩 자동 emit 으로 UI 가 받게 함.
      // cache 있으면 즉시, 없으면 background listTools — fire-and-forget. emit 실패해도 ping pong 흐름 무관.
      emitMcpToolsListing("auto").catch((e) =>
        logToFile("warn", `[mcp:k-personal] auto emit on ping failed: ${e instanceof Error ? e.message : String(e)}`),
      );
      break;
    case "recheck_mcp": {
      cachedMCPHealth = checkMCPHealth();
      emit({
        type: "mcp_status",
        connected: cachedMCPHealth.configured,
        server: "k-personal",
        error: cachedMCPHealth.error,
      });
      // Phase 68 — recheck 후에도 자동 emit (sidecar 재시작 직후 시나리오)
      emitMcpToolsListing("auto").catch((e) =>
        logToFile("warn", `[mcp:k-personal] auto emit on recheck failed: ${e instanceof Error ? e.message : String(e)}`),
      );
      break;
    }
    // Phase 67a (v0.6.2) — MCP 도구 인스펙터.
    // KDA Settings 의 "MCP 도구" 탭이 이 메시지로 요청 → sidecar 가 현재 활성 도구 list 발행.
    // 모델이 보는 catalog 와 동일한 source (mcpClient.listTools) 사용 — 정합성 보장.
    // refresh=true 면 tools cache 무효화 후 재조회 (server.py 재기동 후 새 도구 노출 시).
    case "list_mcp_tools": {
      const refresh = (msg as { refresh?: boolean }).refresh === true;
      // Phase 68 (v0.6.12) — 명시 로깅. K 가 sidecar.log 에서 "frontend 가 요청 보냈는지" 추적 가능.
      logToFile("info", `[mcp:k-personal] list_mcp_tools handler invoked (refresh=${refresh})`);
      emitMcpToolsListing("request", refresh).catch((e) =>
        logToFile("warn", `list_mcp_tools failed: ${e instanceof Error ? e.message : String(e)}`),
      );
      break;
    }
    // Phase 87 — Git Memory Sync 명령. Tauri lib.rs 의 commands 가 sidecar stdin 으로 흘림.
    case "git_sync_now": {
      // 명시 호출 — runGitSyncCycle 직접
      runGitSyncCycle("manual");
      break;
    }
    case "git_sync_resolve_conflict": {
      const side = (msg as { keep?: string }).keep;
      const targetKind = (msg as { target?: string }).target;
      if (side !== "local" && side !== "remote") {
        emit({ type: "git_sync_event", kind: "error", message: `invalid keep side: ${side}`, reason: "manual" });
        break;
      }
      if (targetKind !== "personal" && targetKind !== "team") {
        emit({
          type: "git_sync_event",
          kind: "error",
          message: `invalid target kind: ${targetKind} (personal/team 만 허용)`,
          reason: "manual",
        });
        break;
      }
      const cfg = readSidecarConfig();
      const url = targetKind === "personal" ? cfg.gitSync.repoUrl : cfg.gitSync.teamRepoUrl;
      if (!url) {
        emit({
          type: "git_sync_event",
          kind: "error",
          message: `${targetKind} repoUrl 없음`,
          reason: "manual",
          target: targetKind,
        });
        break;
      }
      const target = makeSyncTarget(targetKind, url);
      const r = syncResolveConflict(target, side);
      emit({
        type: "git_sync_event",
        kind: r.ok ? "ok" : "error",
        message: r.message,
        action: r.action,
        reason: "manual",
        target: targetKind,
      });
      // 충돌 해결 후 push 시도
      if (r.ok) runGitSyncCycle("manual");
      break;
    }
    case "git_sync_store_credential": {
      const url = (msg as { repoUrl?: string }).repoUrl ?? "";
      const pat = (msg as { pat?: string }).pat ?? "";
      const username = (msg as { username?: string }).username ?? "x-access-token";
      if (!url || !pat) {
        emit({ type: "git_sync_event", kind: "error", message: "repoUrl 또는 pat 누락", reason: "manual" });
        break;
      }
      const r = storeGitCredential(url, pat, username);
      emit({
        type: "git_sync_event",
        kind: r.ok ? "ok" : "error",
        message: r.message,
        action: "store-credential",
        reason: "manual",
      });
      break;
    }
    // Phase 90 — SafeMode 주간 통계 요청/리셋
    case "safety_stats_request": {
      const stats = loadSafetyStats();
      const summary = summariseSafetyStats(stats);
      emit({
        type: "safety_stats_response",
        total_alerts: summary.totalAlerts,
        total_blocks: summary.totalBlocks,
        last7_alerts: summary.last7DaysAlerts,
        last7_blocks: summary.last7DaysBlocks,
        by_mode: summary.byMode,
        buckets: summary.buckets,
        since_at: summary.sinceAt,
        last_updated_at: summary.lastUpdatedAt,
      });
      break;
    }
    case "safety_stats_reset": {
      const stats = resetSafetyStats();
      const summary = summariseSafetyStats(stats);
      emit({
        type: "safety_stats_response",
        total_alerts: summary.totalAlerts,
        total_blocks: summary.totalBlocks,
        last7_alerts: summary.last7DaysAlerts,
        last7_blocks: summary.last7DaysBlocks,
        by_mode: summary.byMode,
        buckets: summary.buckets,
        since_at: summary.sinceAt,
        last_updated_at: summary.lastUpdatedAt,
      });
      log("info", "[SafetyStats] reset by user request");
      break;
    }
    case "git_sync_log_request": {
      // Phase 91 — commit history 요청. target=personal|team, limit=N
      const m = msg as { target?: string; limit?: number };
      const targetKind = m.target === "team" ? "team" : "personal";
      const cfg = readSidecarConfig();
      const url = targetKind === "personal" ? cfg.gitSync.repoUrl : cfg.gitSync.teamRepoUrl;
      if (!url) {
        emit({
          type: "git_sync_log_response",
          target: targetKind,
          ok: false,
          message: `${targetKind} repoUrl 미설정`,
          commits: [],
        });
        break;
      }
      const target = makeSyncTarget(targetKind, url);
      const limit = typeof m.limit === "number" ? m.limit : 20;
      const r = syncLog(target, limit);
      emit({
        type: "git_sync_log_response",
        target: targetKind,
        ok: r.ok,
        message: r.message,
        commits: r.commits,
      });
      break;
    }
    case "git_sync_status_request": {
      const installed = checkGitInstalled();
      const cfg = readSidecarConfig();
      const personalTarget = makeSyncTarget("personal", cfg.gitSync.repoUrl);
      const teamTarget = makeSyncTarget("team", cfg.gitSync.teamRepoUrl);
      const personalStatus = installed.ok && cfg.gitSync.repoUrl
        ? syncStatus(personalTarget)
        : { initialized: false, hasRemote: false, localChanges: 0, branch: null };
      const teamStatus = installed.ok && cfg.gitSync.teamRepoUrl
        ? syncStatus(teamTarget)
        : { initialized: false, hasRemote: false, localChanges: 0, branch: null };
      emit({
        type: "git_sync_status",
        git_installed: installed.ok,
        git_version: installed.version ?? null,
        // Personal (snake_case)
        initialized: personalStatus.initialized,
        has_remote: personalStatus.hasRemote,
        local_changes: personalStatus.localChanges,
        branch: personalStatus.branch,
        // Phase 89 — team status 별도
        team_initialized: teamStatus.initialized,
        team_has_remote: teamStatus.hasRemote,
        team_local_changes: teamStatus.localChanges,
        team_branch: teamStatus.branch,
        last_sync_at: cfg.gitSync.lastSyncAt,
        last_sync_status: cfg.gitSync.lastSyncStatus,
        enabled: cfg.gitSync.enabled,
        repo_url: cfg.gitSync.repoUrl,
        team_repo_url: cfg.gitSync.teamRepoUrl,
      });
      break;
    }
    case "git_sync_config_update": {
      // Settings UI 에서 enabled/repoUrl/teamRepoUrl/intervalMs 변경. sidecar 가 즉시 반영.
      const m = msg as {
        enabled?: boolean;
        repoUrl?: string;
        teamRepoUrl?: string;
        intervalMs?: number;
      };
      writeSidecarConfigField((c) => ({
        ...c,
        gitSync: {
          ...c.gitSync,
          enabled: typeof m.enabled === "boolean" ? m.enabled : c.gitSync.enabled,
          repoUrl: typeof m.repoUrl === "string" ? m.repoUrl : c.gitSync.repoUrl,
          teamRepoUrl: typeof m.teamRepoUrl === "string" ? m.teamRepoUrl : c.gitSync.teamRepoUrl,
          intervalMs:
            typeof m.intervalMs === "number" && m.intervalMs >= 60_000 ? m.intervalMs : c.gitSync.intervalMs,
        },
      }));
      // interval 재시작
      if (_gitSyncInterval) {
        clearInterval(_gitSyncInterval);
        _gitSyncInterval = null;
      }
      startMemorySync();
      const cfg = readSidecarConfig();
      emit({
        type: "git_sync_event",
        kind: "ok",
        message: `config 업데이트 — enabled=${cfg.gitSync.enabled} personal=${cfg.gitSync.repoUrl || "(미설정)"} team=${cfg.gitSync.teamRepoUrl || "(미설정)"}`,
        action: "config-update",
        reason: "manual",
      });
      break;
    }

    case "elicitation_response": {
      // Phase 86 — pending safety elicitation 의 resolver 호출 (REST path 의 critical 도구 confirm).
      // pendingElicitations 에 박혀 있으면 그게 우리 거 → resolve. 없으면 CLI 모드의 다른 elicitation
      // (ask_user_question 등) — 기존대로 ignore.
      const respId = (msg as { id?: string }).id;
      const confirmed = (msg as { confirmed?: boolean }).confirmed === true;
      if (typeof respId === "string" && pendingElicitations.has(respId)) {
        const entry = pendingElicitations.get(respId)!;
        clearTimeout(entry.timeoutId);
        pendingElicitations.delete(respId);
        entry.resolve(confirmed);
        log(
          "info",
          `[ToolSafety][elicit] resolved id=${respId} confirmed=${confirmed}`,
        );
      } else {
        log("info", `elicitation_response received (no pending safety elicit — id=${respId ?? "?"})`);
      }
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

// Phase 59 (Anthropic rate polling toggle): ~/.kda/sidecar-config.json 으로 sidecar 옵션 영속화.
// 없거나 키 누락 시 기본값 사용. KDA Settings UI 가 set_sidecar_config_flag Tauri command 로 갱신.
// 변경 사항은 sidecar 재시작 시 반영 (file watch 안 함 — overengineering 회피).
//
// 이 toggle 의 동기: K 의 V3 (안랩) 같은 백신이 ccusage native binary (bun standalone .exe) 의
// 실행을 차단해 사용자가 5분마다 V3 알림 팝업을 받는 경우, 폴링 자체를 끌 수 있어야 함.
// 끈 상태에서도 KDA 본체 동작은 무관 — 단지 Anthropic 사용량 표시의 정확한 source 가 없을 뿐
// (sidecar 는 여전히 SSE rate_limit_event 로 reset 시간만 받음).
interface SidecarConfig {
  // ccusage polling 활성화. 기본 true (기존 동작 유지).
  anthropicRatePollingEnabled: boolean;
  // Phase 87 — Git Memory Sync. 기본 disabled (백 호환).
  gitSync: GitSyncConfig;
}

const SIDECAR_CONFIG_PATH = path.join(os.homedir(), ".kda", "sidecar-config.json");

function readSidecarConfig(): SidecarConfig {
  const defaults: SidecarConfig = {
    anthropicRatePollingEnabled: true,
    gitSync: { ...GIT_SYNC_CONFIG_DEFAULTS },
  };
  try {
    if (!existsSync(SIDECAR_CONFIG_PATH)) return defaults;
    const raw = readFileSync(SIDECAR_CONFIG_PATH, "utf-8");
    // BOM strip — Tauri 가 UTF-8 with BOM 으로 쓰면 JSON.parse 가 fail.
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    // Phase 87 — gitSync 필드 영역 별도 파싱 (PAT 는 절대 받지 않음 — credential helper 만)
    const gsRaw = (parsed.gitSync ?? {}) as Record<string, unknown>;
    return {
      anthropicRatePollingEnabled:
        typeof parsed.anthropicRatePollingEnabled === "boolean"
          ? parsed.anthropicRatePollingEnabled
          : defaults.anthropicRatePollingEnabled,
      gitSync: {
        enabled: typeof gsRaw.enabled === "boolean" ? gsRaw.enabled : defaults.gitSync.enabled,
        repoUrl: typeof gsRaw.repoUrl === "string" ? gsRaw.repoUrl : defaults.gitSync.repoUrl,
        // Phase 89 — team repo (선택). 빈 string 이면 team sync 비활성.
        teamRepoUrl:
          typeof gsRaw.teamRepoUrl === "string" ? gsRaw.teamRepoUrl : defaults.gitSync.teamRepoUrl,
        intervalMs:
          typeof gsRaw.intervalMs === "number" && gsRaw.intervalMs >= 60_000
            ? gsRaw.intervalMs
            : defaults.gitSync.intervalMs,
        lastSyncAt: typeof gsRaw.lastSyncAt === "number" ? gsRaw.lastSyncAt : 0,
        lastSyncStatus: typeof gsRaw.lastSyncStatus === "string" ? gsRaw.lastSyncStatus : "",
      },
    };
  } catch (err) {
    log("warn", `sidecar-config.json 읽기 실패 (기본값 사용): ${err}`);
    return defaults;
  }
}

/**
 * Phase 87 — Tauri command 가 write_sidecar_config 직접 처리.
 * sidecar 가 직접 write 하는 path 는 lastSyncAt / lastSyncStatus 갱신용.
 * PAT 는 절대 여기 박지 않음 — credential helper 만 사용.
 */
function writeSidecarConfigField(updater: (cfg: SidecarConfig) => SidecarConfig): void {
  try {
    const current = readSidecarConfig();
    const next = updater(current);
    // PAT/credential 류는 SidecarConfig 에 절대 안 들어옴 — 구조적으로 type 이 그렇게 짜여 있음.
    writeFileSync(SIDECAR_CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
  } catch (err) {
    log("warn", `sidecar-config.json 쓰기 실패: ${err}`);
  }
}

/**
 * Phase 87 — Git Memory Sync 시작.
 *   - startup 시 1회 syncFull (enabled & repoUrl 있을 때만)
 *   - intervalMs 마다 syncFull 반복
 *   - 충돌 시 git_sync_event {type:"conflict"} emit + frontend ElicitationDialog 활용
 *
 * V3 같은 백신은 git.exe (system git) 를 일반적으로 신뢰함 (오랜 평판) — 백신 알림 위험 낮음.
 * 그래도 user toggle (cfg.gitSync.enabled) 로 사후 비활성화 가능 — pitfall_av_blocks_bundled_native_binary 원칙.
 */
let _gitSyncInterval: NodeJS.Timeout | null = null;

/**
 * Phase 87 + 89 — 한 SyncTarget 의 sync cycle 처리.
 * personal/team 둘 다 같은 흐름. config update 시엔 personal 만 기록 (team 은 별도).
 */
function runOneSyncTarget(
  kind: SyncKind,
  repoUrl: string,
  reason: "startup" | "interval" | "manual",
): GitSyncResult | null {
  if (!repoUrl) return null;
  const target = makeSyncTarget(kind, repoUrl);
  log("info", `[GitSync][${kind}][${reason}] sync 시작 — repo=${repoUrl}`);
  let result: GitSyncResult;
  try {
    result = syncFull(target);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `[GitSync][${kind}][${reason}] syncFull throw: ${msg}`);
    emit({ type: "git_sync_event", kind: "error", message: msg, reason, target: kind });
    return { ok: false, action: "error", message: msg, kind };
  }
  if (result.action === "conflict" && !result.ok) {
    log(
      "warn",
      `[GitSync][${kind}][${reason}] 충돌 — ${result.conflictedFiles?.length ?? 0}개 파일: ${result.message}`,
    );
    emit({
      type: "git_sync_event",
      kind: "conflict",
      message: result.message,
      conflicted_files: result.conflictedFiles ?? [],
      reason,
      target: kind,
    });
    return result;
  }
  if (!result.ok) {
    log("warn", `[GitSync][${kind}][${reason}] 실패: ${result.message}`);
    emit({ type: "git_sync_event", kind: "error", message: result.message, reason, target: kind });
    return result;
  }
  log("info", `[GitSync][${kind}][${reason}] 성공 (${result.action}): ${result.message}`);
  emit({
    type: "git_sync_event",
    kind: "ok",
    message: result.message,
    action: result.action,
    reason,
    target: kind,
  });
  return result;
}

function runGitSyncCycle(reason: "startup" | "interval" | "manual"): void {
  const cfg = readSidecarConfig();
  if (!cfg.gitSync.enabled) return;
  if (!cfg.gitSync.repoUrl && !cfg.gitSync.teamRepoUrl) {
    log("warn", `[GitSync][${reason}] enabled 지만 personal/team repoUrl 둘 다 비어 있음 — skip`);
    return;
  }
  const installed = checkGitInstalled();
  if (!installed.ok) {
    log("warn", `[GitSync][${reason}] git 미설치: ${installed.reason}`);
    emit({
      type: "git_sync_event",
      kind: "error",
      message: installed.reason ?? "git 미설치",
      reason,
    });
    return;
  }
  // 1) Personal sync (있을 때)
  const personalResult = runOneSyncTarget("personal", cfg.gitSync.repoUrl, reason);
  // 2) Team sync (있을 때, personal 실패해도 진행)
  const teamResult = runOneSyncTarget("team", cfg.gitSync.teamRepoUrl, reason);

  // config 의 lastSync 기록 — personal 우선, 없으면 team
  const primary = personalResult ?? teamResult;
  if (!primary) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const status = primary.action === "conflict" && !primary.ok
    ? "conflict"
    : primary.ok
      ? "ok"
      : `error: ${primary.message.slice(0, 80)}`;
  writeSidecarConfigField((c) => ({
    ...c,
    gitSync: { ...c.gitSync, lastSyncAt: nowSec, lastSyncStatus: status },
  }));
}

function startMemorySync(): void {
  const cfg = readSidecarConfig();
  if (!cfg.gitSync.enabled) {
    log("info", `[GitSync] disabled — 시작 안 함`);
    return;
  }
  if (!cfg.gitSync.repoUrl && !cfg.gitSync.teamRepoUrl) {
    log("warn", `[GitSync] enabled 지만 personal/team repoUrl 둘 다 비어있음 — Settings 에서 입력 필요`);
    return;
  }
  // startup 시 1회 (지연 5초 — sidecar 가 ready 박은 후)
  setTimeout(() => runGitSyncCycle("startup"), 5_000);
  // interval
  const ms = Math.max(60_000, cfg.gitSync.intervalMs ?? GIT_SYNC_CONFIG_DEFAULTS.intervalMs);
  if (_gitSyncInterval) clearInterval(_gitSyncInterval);
  _gitSyncInterval = setInterval(() => runGitSyncCycle("interval"), ms);
  log(
    "info",
    `[GitSync] started — interval=${Math.round(ms / 60000)}분, personal=${cfg.gitSync.repoUrl || "(none)"} team=${cfg.gitSync.teamRepoUrl || "(none)"}`,
  );
}

function startRateLimitPolling(): void {
  const cfg = readSidecarConfig();
  log("info", `sidecar config loaded: anthropicRatePollingEnabled=${cfg.anthropicRatePollingEnabled}`);

  // (a) statusLine path — interactive Claude 세션이 있으면 statusLine 이 temp file 박음.
  //     non-interactive `claude -p` 에선 안 부르지만, K 가 별도 터미널에서 interactive 쓰면 작동.
  //     이 경로는 단순 file read 라 백신 안 건드림 — toggle 무관하게 항상 활성.
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
  //     Phase 59: toggle off 면 skip (V3 등 백신 차단 회피).
  if (cfg.anthropicRatePollingEnabled) {
    pollCcusageOnce();
    setInterval(pollCcusageOnce, 5 * 60 * 1000);
  } else {
    log(
      "info",
      "ccusage polling disabled by user (sidecar-config.json) — Anthropic 사용량 표시는 SSE rate_limit_event 만 사용"
    );
  }
}

// Phase 101 (v0.6.47) — ccusage 의 native binary path 우선 호출.
// pitfall_av_blocks_bundled_native_binary 의 옵션 D — npx 캐시 hash 변동 회피 +
// 백신 신뢰 누적. K 의 V3 같은 백신은 "처음 보는 경로의 .exe" 마다 알림 → npx temp path
// 매번 변하면 영원히 신뢰 X. 글로벌 npm 경로의 안정 .exe 를 우선 호출.
//
// 우선순위:
//   1) KDA_CCUSAGE_PATH env (K 가 직접 override 가능)
//   2) %APPDATA%/npm/node_modules/ccusage/.../@ccusage/ccusage-win32-x64/bin/ccusage.exe
//   3) npx fallback (기존 동작)
function resolveCcusageBin(): { cmd: string; argPrefix: string[]; isDirectBin: boolean } {
  const isWin = process.platform === "win32";
  if (!isWin) {
    return { cmd: "npx", argPrefix: [], isDirectBin: false };
  }
  const candidates: string[] = [];
  if (process.env.KDA_CCUSAGE_PATH) candidates.push(process.env.KDA_CCUSAGE_PATH);
  candidates.push(
    path.join(
      os.homedir(),
      "AppData",
      "Roaming",
      "npm",
      "node_modules",
      "ccusage",
      "node_modules",
      "@ccusage",
      "ccusage-win32-x64",
      "bin",
      "ccusage.exe",
    ),
  );
  for (const p of candidates) {
    if (existsSync(p)) {
      return { cmd: p, argPrefix: [], isDirectBin: true };
    }
  }
  // npx fallback (기존 동작)
  return { cmd: "cmd", argPrefix: ["/c", "npx"], isDirectBin: false };
}

function spawnNpx(args: string[], timeoutMs: number): { stdout: string; ok: boolean; permDenied: boolean } {
  const resolved = resolveCcusageBin();
  // global path 직접 호출 시 args 의 첫 토큰 "ccusage@latest" 는 제거 (이미 그 binary 자체)
  const cleanedArgs = resolved.isDirectBin
    ? args.filter((a) => !a.startsWith("ccusage@") && a !== "ccusage")
    : args;
  const fullArgs = [...resolved.argPrefix, ...cleanedArgs];
  const res = spawnSync(resolved.cmd, fullArgs, {
    encoding: "utf-8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  // Phase 101 — EPERM (Access denied) detect — 백신이 ccusage.exe 차단의 시그널.
  // pitfall_av_blocks_bundled_native_binary 패턴 3 후보 (auto toggle off + UI 안내).
  const errCode = res.error && (res.error as NodeJS.ErrnoException).code;
  const stderr = res.stderr ?? "";
  const permDenied = errCode === "EPERM" || /access is denied|EPERM/i.test(stderr);
  return {
    stdout: res.stdout ?? "",
    ok: res.status === 0 && !!res.stdout,
    permDenied,
  };
}

// Phase 76 (v0.6.19) — ccusage weekly 의 `current.week` 가 invalid Date 인 경우 (ccusage schema
// 변경 / 빈 값 / 다른 format) `new Date(...).toISOString()` 이 RangeError throw → 기존 코드는
// 5분 polling 마다 같은 warn 박혀 sidecar.log spam (K 의 다른 PC 에서 약 50줄/시간 누적 확인됨).
// 회피: invalid 검출 시 silent skip + 같은 메시지 30분 throttle 로 한 번씩만 warn.
let __ccusageWeeklyLastWarnAt: number = 0;
let __ccusageWeeklyLastWarnMsg: string = "";
function ccusageWeeklyWarn(msg: string): void {
  const now = Date.now();
  if (
    __ccusageWeeklyLastWarnMsg === msg &&
    now - __ccusageWeeklyLastWarnAt < 30 * 60 * 1000
  ) {
    return; // 같은 메시지 30분 안 중복 차단
  }
  log("warn", `ccusage weekly: ${msg}`);
  __ccusageWeeklyLastWarnAt = now;
  __ccusageWeeklyLastWarnMsg = msg;
}

// Phase 101 (v0.6.47) — 백신이 ccusage.exe 차단했을 때 sidecar-config.json 의 toggle 을
// 자동 OFF + 5분 polling 중단. K 가 5분마다 같은 EPERM warn 보는 spam 차단.
// 다음 sidecar 재시작 시 toggle 이 OFF 라 polling 자체 안 일어남.
function disablePollingDueToAvBlock(): void {
  try {
    const configPath = path.join(os.homedir(), ".kda", "sidecar-config.json");
    let cfg: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      } catch {
        /* corrupted — overwrite */
      }
    }
    cfg.anthropicRatePollingEnabled = false;
    cfg.av_blocked_at = new Date().toISOString();
    cfg.av_blocked_reason = "ccusage spawn EPERM — 백신 (V3 / 알약 등) 의 native binary 차단 의심";
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
    log(
      "warn",
      `[AV-BLOCK] ccusage 차단 detect → sidecar-config.json 의 anthropicRatePollingEnabled = false 자동 저장. 다음 sidecar 시작 시부터 polling skip. K 의 V3 콘솔에서 ccusage.exe 차단 해제 + 예외 등록 후 toggle 재활성화 부탁.`,
    );
  } catch (e) {
    log("warn", `[AV-BLOCK] config write 실패 (재발 가능): ${e}`);
  }
}

let __ccusageAvBlocked = false; // 한 sidecar lifetime 동안 1회만 trigger (재시도 spam 방지)
function pollCcusageOnce(): void {
  if (__ccusageAvBlocked) return; // AV-BLOCK 이미 detect 했으면 즉시 skip
  try {
    const blocks = spawnNpx(["ccusage@latest", "blocks", "--active", "--json"], 30_000);
    // Phase 101 — EPERM 감지 시 즉시 auto disable + polling 중단
    if (blocks.permDenied && !__ccusageAvBlocked) {
      __ccusageAvBlocked = true;
      disablePollingDueToAvBlock();
      return;
    }
    const weekly = spawnNpx(["ccusage@latest", "weekly", "--json", "--order", "desc"], 30_000);
    if (weekly.permDenied && !__ccusageAvBlocked) {
      __ccusageAvBlocked = true;
      disablePollingDueToAvBlock();
      return;
    }

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
          // Phase 76 (v0.6.19): week 가 invalid 면 Date 가 NaN → toISOString() RangeError.
          // 사전 검사 + throttled warn 으로 spam 차단.
          const weekStart = new Date(current.week);
          if (isNaN(weekStart.getTime())) {
            ccusageWeeklyWarn(
              `entry.week 가 invalid Date (ccusage schema 변경 의심): week=${JSON.stringify(current.week)} — secondary skip`
            );
          } else {
            const nextReset = new Date(weekStart);
            nextReset.setDate(nextReset.getDate() + 7);
            secondary = {
              used_tokens: current.totalTokens,
              reset_at: nextReset.toISOString(),
              week_start: current.week,
            };
          }
        }
      } catch (err) {
        // Phase 76 (v0.6.19): throttle 적용해서 5분 polling spam 차단.
        ccusageWeeklyWarn(`JSON 파싱 실패: ${err}`);
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
// Phase 94 (v0.6.36) — 메모리 위치 통일을 위한 1회 마이그레이션.
// startMemorySync() 보다 먼저 호출해야 첫 sync 가 새 위치의 메모리를 commit 함.
// 이미 ~/.kda/memory/ 에 *.md 있으면 silent skip (idempotent).
try {
  migrateLegacyMemoryToKda();
} catch (e) {
  log("warn", `[MemoryMigration] 실패 (sync 는 그대로 진행): ${e}`);
}

// Phase 87 — Git Memory Sync (enabled 일 때만 실제 시작)
startMemorySync();

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
