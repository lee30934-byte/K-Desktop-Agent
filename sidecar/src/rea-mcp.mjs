// REA (Reverse Engineer Anything) MCP 선택적 연동 — 순수 정책 모듈.
//
// 원칙 (K 승인 2026-10-15, 범위 "전부"):
//   - REA 의 전역 setup(~/.claude.json · ~/.codex/config.toml · ~/.gemini 수정)은 쓰지 않는다.
//     KDA 가 매 turn 에만 주입하므로 다른 대화의 컨텍스트 비용은 0.
//   - 켜지는 조건 4개 모두 충족 시에만 주입:
//       agent-flags reaMcp ON + projectMode ON + 폴더 프로필 mcpServers 에 "rea"
//       + ~/.kda/tools/rea 에 고정 버전(REA_PINNED_VERSION) 설치 확인.
//   - 버전 고정: 설치본 버전이 다르면 주입하지 않는다(런타임 도구 목록이 버전에 묶여 있음).
//   - 런타임/파괴적 도구(REA_RUNTIME_TOOLS)는 프로필 allowReaRuntime=true 일 때만 노출.
//   - Gemini CLI 는 전역 settings.json 외 주입 경로가 없어 미지원.
//
// 이 파일은 빌드 없이 테스트(sidecar/test-rea-mcp.mjs)가 import 하도록 .mjs 로 둔다
// (pitfall_dist_import_kills_prebuild_gate). 타입은 rea-mcp.d.mts.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const REA_SERVER_NAME = "rea";
export const REA_PINNED_VERSION = "6.5.0";
export const REA_NODE_MIN = [22, 19];

// 실측 2026-10-15 (rea-agents 6.5.0, tools/list 207개):
//   스키마 full/full = 3,087,933B, compact/off = 214,796B (-93%).
export const REA_SERVER_ENV = Object.freeze({
  REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
});

// rea-agents 6.5.0 tools/list 실측에서 annotations.destructiveHint=true 이거나
// 디버거/계측/기기 제어(frida·gdb·rizin debug·cutter·adb) 인 도구 59개.
// 대상 앱 실행·주입·기기 변경·분석 DB 쓰기 가능성이 있어 기본 차단한다.
export const REA_RUNTIME_TOOLS = Object.freeze([
  "annotate_native_function", "capture_adb_screen", "capture_browser_scenario",
  "capture_electron_scenario", "capture_native_ui_scenario", "capture_process_scenario",
  "close_binary", "close_frida_session", "close_gdb_session", "close_rizin_debug_session",
  "collect_adb_bugreport", "cutter_command", "execute_rizin_command", "export_evidence_bundle",
  "frida_session_status", "gdb_console", "gdb_session_status", "inspect_adb_client",
  "inspect_adb_device", "inspect_adb_display", "inspect_adb_package", "inspect_adb_window",
  "install_adb_package", "instrument_with_frida", "list_adb_devices", "list_adb_directory",
  "list_adb_features", "list_adb_packages", "list_adb_processes", "list_adb_services",
  "list_cutter_sessions", "list_frida_devices", "list_frida_processes", "load_frida_script",
  "observe_native_calls", "observe_web_execution", "pull_adb_file", "pull_adb_package",
  "push_adb_file", "read_adb_logcat", "read_adb_setting", "resolve_adb_packages",
  "resume_frida_session", "rizin_debug_command", "rizin_debug_session_status",
  "set_address_name", "set_addresses_names", "set_bookmark", "set_comment",
  "set_inline_comment", "start_adb_activity", "start_adb_app", "start_frida_session",
  "start_gdb_session", "start_rizin_debug_session", "stop_adb_app", "uninstall_adb_package",
  "unload_frida_script", "unset_bookmark",
]);

/** 설치 위치: <home>/.kda/tools/rea (npm --prefix 형태, package.json 고정 버전). */
export function reaInstallRoot(home) {
  return path.join(home, ".kda", "tools", "rea");
}

/**
 * 고정 설치본 탐지. throw 하지 않는다.
 * @returns {{ok: true, entry: string, version: string} | {ok: false, reason: string, version?: string}}
 */
export function detectReaInstall(home, fs = { existsSync, readFileSync }) {
  try {
    const pkgDir = path.join(reaInstallRoot(home), "node_modules", "rea-agents");
    const pkgJson = path.join(pkgDir, "package.json");
    const entry = path.join(pkgDir, "scripts", "rea.mjs");
    if (!fs.existsSync(pkgJson) || !fs.existsSync(entry)) {
      return { ok: false, reason: `REA 미설치 (${reaInstallRoot(home)})` };
    }
    const raw = String(fs.readFileSync(pkgJson, "utf-8")).replace(/^﻿/, "");
    const version = JSON.parse(raw)?.version;
    if (version !== REA_PINNED_VERSION) {
      return {
        ok: false,
        version: typeof version === "string" ? version : undefined,
        reason: `REA 버전 불일치 (설치 ${version ?? "?"}, 고정 ${REA_PINNED_VERSION})`,
      };
    }
    return { ok: true, entry, version };
  } catch (e) {
    return { ok: false, reason: `REA 설치 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** "v22.19.0" / "22.19.0" → 최소 버전 충족 여부. 파싱 실패 시 false. */
export function nodeSatisfiesRea(nodeVersion) {
  const m = /^v?(\d+)\.(\d+)/.exec(String(nodeVersion ?? ""));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major === 22) return minor >= 19;
  if (major === 24) return minor >= 11;
  return major >= 26;
}

/**
 * REA 서버를 띄울 Node 선택. 설치본 KDA 의 sidecar 는 번들 Node(v20.18.0)로 돌기 때문에
 * process.execPath 를 그대로 쓰면 REA(22.19+)가 영원히 꺼진다 — 후보 중 첫 충족 런타임을 고른다.
 * @param {Array<{path: string, version: string | null}>} candidates 우선순위 순서
 * @returns {{path: string, version: string} | null}
 */
export function pickReaNode(candidates) {
  if (!Array.isArray(candidates)) return null;
  for (const c of candidates) {
    if (!c || typeof c.path !== "string" || !c.path.trim()) continue;
    if (typeof c.version === "string" && nodeSatisfiesRea(c.version)) {
      return { path: c.path, version: c.version.trim() };
    }
  }
  return null;
}

/** 프로필이 REA 를 요청했는지 (대소문자·공백 무시). */
export function profileRequestsRea(profile) {
  if (!profile || typeof profile !== "object" || !Array.isArray(profile.mcpServers)) return false;
  return profile.mcpServers.some(
    (s) => typeof s === "string" && s.trim().toLowerCase() === REA_SERVER_NAME,
  );
}

/**
 * 이번 turn 에 REA 를 주입할지 결정. 모든 조건을 순서대로 보고 첫 실패 사유를 남긴다.
 * requested=false 면 로그·안내 없이 조용히 끈다(평소 대화 zero-regression).
 * @param {{flags: {reaMcp?: boolean, projectMode?: boolean}, profile?: any, install: any, nodeVersion: string, provider: string}} input
 */
export function decideRea({ flags, profile, install, nodeVersion, provider }) {
  const requested = profileRequestsRea(profile);
  const allowRuntime = !!(profile && profile.allowReaRuntime === true);
  const off = (reason) => ({ enabled: false, requested, allowRuntime: false, reason });
  if (!requested) return off("프로필에 rea 없음");
  if (!flags || flags.projectMode !== true) return off("프로젝트 모드 꺼짐");
  if (flags.reaMcp !== true) return off("REA 연동 토글 꺼짐");
  if (provider !== "claude" && provider !== "codex") return off(`${provider} 엔진은 REA 미지원`);
  if (!nodeSatisfiesRea(nodeVersion)) return off(`Node ${nodeVersion} — REA 는 22.19+/24.11+/26+ 필요`);
  if (!install || install.ok !== true) return off(install?.reason ?? "REA 설치 확인 실패");
  return { enabled: true, requested, allowRuntime, reason: "ok", entry: install.entry };
}

/** Claude CLI --mcp-config 의 mcpServers.rea 항목. */
export function buildReaClaudeServer(nodeExe, entry) {
  return { type: "stdio", command: nodeExe, args: [entry, "mcp"], env: { ...REA_SERVER_ENV } };
}

/** Claude CLI --disallowed-tools 에 병합할 풀네임 (런타임 허용 시 빈 배열). */
export function reaClaudeDisallowed(allowRuntime) {
  return allowRuntime ? [] : REA_RUNTIME_TOOLS.map((t) => `mcp__${REA_SERVER_NAME}__${t}`);
}

/**
 * Codex app-server thread/start·thread/resume 의 config override.
 * 실측: 이 config 를 준 스레드에서만 rea 가 connected(207), disabled_tools 로 205 확인.
 */
export function buildReaCodexConfig(nodeExe, entry, allowRuntime) {
  return {
    mcp_servers: {
      [REA_SERVER_NAME]: {
        command: nodeExe,
        args: [entry, "mcp"],
        env: { ...REA_SERVER_ENV },
        startup_timeout_sec: 60,
        ...(allowRuntime ? {} : { disabled_tools: [...REA_RUNTIME_TOOLS] }),
      },
    },
  };
}

/** 시스템 텍스트 안내. 요청됐지만 꺼졌으면 사유를 알려 모델이 없는 도구를 찾지 않게 한다. */
export function buildReaGuidance(decision) {
  if (!decision || !decision.requested) return "";
  if (!decision.enabled) {
    return `\n\n[REA 리버스 엔지니어링 도구]\n이 프로젝트는 REA 를 요청했지만 이번 turn 에는 비활성입니다 (${decision.reason}). REA 도구를 찾거나 전역 설치(npx rea-agents setup)를 시도하지 말고, 필요하면 K 에게 활성화 조건을 안내하세요.`;
  }
  const runtime = decision.allowRuntime
    ? "런타임/계측/기기 제어 도구도 허용되어 있지만, 대상 앱 실행·주입·기기 변경 전에는 반드시 K 의 확인을 받으세요."
    : "정적 분석 도구만 허용됩니다. 대상 앱 실행·계측(frida/gdb/rizin debug)·adb 기기 제어·분석 DB 쓰기 도구는 차단되어 있습니다.";
  return [
    "",
    "",
    "[REA 리버스 엔지니어링 도구]",
    `이 프로젝트에는 REA ${REA_PINNED_VERSION} MCP 서버(mcp__rea__*)가 연결되어 있습니다.`,
    runtime,
    "타사 소프트웨어는 동작 원리 이해 목적으로만 분석하고, 코드를 그대로 복제하지 마세요. 결론에는 REA 가 반환한 근거와 한계를 함께 보고하세요.",
    "REA 의 전역 setup/update 명령은 실행하지 마세요 (KDA 가 버전을 고정 관리합니다).",
  ].join("\n");
}
