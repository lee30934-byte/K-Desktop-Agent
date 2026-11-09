#!/usr/bin/env node
/**
 * K Desktop Agent — PreToolUse Desktop Guard (2026-11-09)
 *
 * Claude Code CLI 의 Bash PreToolUse hook. 셸 명령으로 화면·입력을 직접 조작하려는 시도를
 * 실행 전에 막고(exit 2), k-personal 화면 도구를 쓰라는 안내를 stderr 로 돌려준다.
 *
 * 환경변수: KDA_DESKTOP_GUARD = "0" 이면 비활성.
 * 실패 안전성: 입력 파싱 실패·모듈 로드 실패는 통과(exit 0). 확실히 맞을 때만 막는다.
 */
import { detectDesktopBypass, DESKTOP_BYPASS_REMEDY } from "./desktopBypass.mjs";

if (process.env.KDA_DESKTOP_GUARD === "0") process.exit(0);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }
  const tool = payload?.tool_name;
  if (tool !== "Bash" && tool !== "PowerShell") process.exit(0);
  const command = payload?.tool_input?.command;
  const hit = detectDesktopBypass(command);
  if (!hit) process.exit(0);
  process.stderr.write(
    `[KDA desktopGuard] 차단: 셸로 화면/입력을 직접 조작하려는 명령입니다 (${hit.label}).\n${DESKTOP_BYPASS_REMEDY}\n`,
  );
  process.exit(2);
});
