#!/usr/bin/env node
/**
 * K Desktop Agent — PreToolUse Overwrite Guard
 *
 * Claude Code CLI 의 PreToolUse hook 으로 호출됨. (`--settings` 로 주입)
 *
 * 목적
 *   "file_delete=manual" 카테고리 토글이 잠겨 있을 때, Write/Edit/MultiEdit 가
 *   "기존 파일을 덮어쓰는 행위" 도 함께 차단한다 (의미적으로 데이터 삭제와 동등).
 *   신규 파일 생성은 file_write 토글로만 통제 — 이쪽은 통과.
 *
 * 입력 (stdin, JSON 한 덩어리)
 *   {
 *     "session_id": "...",
 *     "transcript_path": "...",
 *     "cwd": "...",
 *     "hook_event_name": "PreToolUse",
 *     "tool_name": "Write" | "Edit" | "MultiEdit",
 *     "tool_input": { "file_path": "...", ... }
 *   }
 *
 * 출력
 *   - exit 0  → 통과 (신규 파일이거나 권한 통과)
 *   - exit 2  → 차단 (stderr 메시지가 모델에 피드백되어 "왜 막혔는지" 인지)
 *
 * 환경변수 (sidecar 가 Claude CLI spawn 시 주입)
 *   KDA_FILE_DELETE_LEVEL = "auto" | "ask" | "manual"  (기본 auto)
 *   KDA_OVERWRITE_GUARD   = "1" (활성) | "0" (비활성, 디버그용)
 *
 * 실패 안전성
 *   stdin 파싱 실패 / 알 수 없는 도구 / 경로 미상 → 통과(exit 0).
 *   가드는 "확실히 막아야 할 때만 막는다" 원칙 — false positive 보다 false negative 우선.
 *   (false negative 가 나도 카테고리 토글의 hard 차단이 fallback)
 */

import { existsSync, statSync } from "node:fs";

const GUARD_ENABLED = (process.env.KDA_OVERWRITE_GUARD ?? "1") !== "0";
const FILE_DELETE_LEVEL = process.env.KDA_FILE_DELETE_LEVEL ?? "auto";

// stdin JSON 한 덩어리 읽기 (Claude Code hook 은 한 번에 모든 입력을 보냄)
let raw = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  try {
    main(raw);
  } catch (err) {
    // 가드 자체의 에러는 자동화를 막지 않도록 통과 (로그만 남기고)
    process.stderr.write(
      `[overwriteGuard] internal error (passing through): ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    process.exit(0);
  }
});

function main(raw) {
  if (!GUARD_ENABLED) {
    process.exit(0);
  }
  if (!raw.trim()) {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // hook 입력이 깨졌으면 통과 (자동화 우선)
    process.exit(0);
  }

  const toolName = payload?.tool_name;
  const watched = ["Write", "Edit", "MultiEdit"];
  if (!watched.includes(toolName)) {
    process.exit(0);
  }

  const input = payload?.tool_input ?? {};
  // Write/Edit 둘 다 file_path 필드 사용 (Claude Code 표준)
  const target = input.file_path ?? input.path;
  if (!target || typeof target !== "string") {
    process.exit(0);
  }

  // 존재하는 정규 파일인지 확인. 디렉토리/심볼릭링크/없는 파일은 통과.
  let isExistingFile = false;
  try {
    if (existsSync(target)) {
      const st = statSync(target);
      isExistingFile = st.isFile();
    }
  } catch {
    // stat 실패 → 안전하게 통과
    process.exit(0);
  }

  if (!isExistingFile) {
    // 신규 파일 생성 — file_write 권한으로만 통제됨 (이미 카테고리 토글이 처리)
    process.exit(0);
  }

  // 여기까지 왔다면: 기존 파일에 대한 Write/Edit/MultiEdit
  // → file_delete 권한과 의미적으로 매핑
  if (FILE_DELETE_LEVEL === "manual") {
    process.stderr.write(
      `[K Desktop Agent guard] '${toolName}' 가 기존 파일을 덮어쓰려고 합니다 (target='${target}'). ` +
        `'파일 삭제' 권한이 manual(수동만)로 잠겨 있어 차단됩니다. ` +
        `K님이 환경설정 → 권한에서 '파일 삭제' 를 자동 또는 매번 으로 풀거나, ` +
        `K님이 직접 처리해주세요. (신규 파일 생성은 영향 없음)\n`
    );
    process.exit(2);
  }

  // ask / auto 는 통과 (기존 시스템 프롬프트 안내가 ask 의 soft enforcement 담당)
  process.exit(0);
}
