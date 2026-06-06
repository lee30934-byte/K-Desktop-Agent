#!/usr/bin/env node
/**
 * K Desktop Agent — PreToolUse Pitfall Guard (Phase 9 step 4)
 *
 * Claude Code CLI 의 PreToolUse hook 으로 호출됨.
 *
 * 목적
 *   memory/pitfall_*.md 에 등록된 "K 와 합의했거나 직접 겪은 함정" 패턴을 도구 호출 직전에 감지해
 *   동일 실수를 반복하지 않도록 차단한다. 회피책을 stderr 로 모델에 피드백.
 *
 * 패턴 (2단계)
 *   1) memory/pitfall_*.md frontmatter 의 `guard_pattern` 을 자동 로드 (Phase X-1)
 *      → 새 함정을 코드 수정 없이 .md 파일만 추가/수정해 차단 가능.
 *      frontmatter 키:
 *        guard_pattern : 차단할 정규식 (필수, 이게 있어야 가드 대상)
 *        guard_tool    : 적용할 도구 이름 (기본 "Bash")
 *        guard_field   : tool_input 의 검사 필드 (기본 "command")
 *        guard_flags   : 정규식 플래그 (기본 "i")
 *        guard_remedy  : 회피책 (선택, 없으면 파일 경로 안내)
 *      reason 은 frontmatter `description` 을 사용.
 *   2) 파일 로드 실패/누락 시를 대비한 하드코딩 fallback (아래 FALLBACK_PITFALLS)
 *      - powershell-secret-bom : `Get-Content -Raw ... | gh secret set` (BOM 주입)
 *      - tauri-key-rotation    : `tauri signer generate` (인앱 updater 끊김 사고)
 *      같은 id 가 .md 에서 로드되면 .md 가 우선 (fallback 은 덮어쓰기됨).
 *
 * 입력 (stdin, JSON 한 덩어리)
 *   { tool_name: "Bash", tool_input: { command: "...", ... }, ... }
 *
 * 출력
 *   - exit 0 : 통과 (패턴 미적중)
 *   - exit 2 : 차단 + stderr 메시지 (모델이 이유와 회피책을 인지)
 *
 * 환경변수
 *   KDA_PITFALL_GUARD = "1" (활성, 기본) | "0" (비활성, 디버그)
 *
 * 실패 안전성
 *   stdin 파싱 실패 / 알 수 없는 도구 / 패턴 매칭 자체 에러 → 통과 (자동화 우선).
 *   "확실히 막아야 할 때만 막는다" 원칙. false positive 보다 false negative 우선.
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GUARD_ENABLED = (process.env.KDA_PITFALL_GUARD ?? "1") !== "0";

// memory 디렉터리 (frontmatter guard_pattern 자동 로드 대상)
const MEMORY_DIR =
  process.env.KDA_MEMORY_DIR && process.env.KDA_MEMORY_DIR.trim()
    ? process.env.KDA_MEMORY_DIR.trim()
    : join(homedir(), ".kda", "memory");

// ─── 하드코딩 fallback 패턴 ────────────────────────────────────
// memory/pitfall_*.md 의 guard_pattern 로드가 실패하거나 해당 id 가 누락된
// 경우에도 핵심 2개 함정은 항상 막히도록 보장한다.
// id              : pitfall 메모 파일명 매칭용 (.md guard 와 dedupe 키)
// match(toolName, input) : 적중 시 true
// reason          : stderr 로 모델에 전달할 차단 사유
// remedy          : 회피책 (반드시 명시 — "왜 막혔는지" 와 "어떻게 우회하는지" 둘 다 제공)
const FALLBACK_PITFALLS = [
  {
    id: "powershell-secret-bom",
    match: (toolName, input) => {
      if (toolName !== "Bash") return false;
      const cmd = String(input?.command ?? "");
      // PowerShell `Get-Content -Raw` 가 UTF-8 BOM 을 포함한 채 stdout 으로 흘러
      // gh secret set 의 stdin 으로 들어가면 비밀의 첫 3바이트가 0xEF 0xBB 0xBF 가 된다.
      // 이게 GitHub Actions 의 Tauri signing 단계에서 키 비밀번호를 깨뜨려 빌드 실패.
      return /Get-Content\s+-Raw[^|]*\|\s*gh\s+secret\s+set/i.test(cmd);
    },
    reason:
      "PowerShell 의 `Get-Content -Raw` 출력은 UTF-8 BOM 을 포함합니다. " +
      "이 출력을 `gh secret set` 의 stdin 으로 파이핑하면 비밀 값 앞에 0xEF 0xBB 0xBF 3바이트가 주입되어 " +
      "Tauri signing 같은 BOM 민감 워크플로우가 깨집니다 (memory/pitfall_powershell_secret_bom.md).",
    remedy: [
      "회피책 셋 중 하나를 사용하세요:",
      "  1) gh secret set <NAME> --body-file <path>          # 가장 안전 (BOM 무관)",
      "  2) cmd /c \"type <path>\" | gh secret set <NAME> --body -   # cmd type 은 BOM 미포함",
      "  3) [System.IO.File]::ReadAllText('<path>').TrimStart([char]0xFEFF) | gh secret set <NAME> --body -",
    ].join("\n"),
  },
  {
    id: "tauri-key-rotation",
    match: (toolName, input) => {
      if (toolName !== "Bash") return false;
      const cmd = String(input?.command ?? "");
      // `tauri signer generate` / `npx tauri signer generate` / `pnpm tauri signer generate` 등.
      // 키 로테이션은 K 의 기존 설치본이 새 .sig 를 검증 못해 인앱 updater 가 죽는다.
      return /(?:^|[\s&|;])(?:npx\s+)?(?:pnpm\s+)?(?:yarn\s+)?(?:cargo\s+)?tauri\s+signer\s+generate/i.test(
        cmd,
      );
    },
    reason:
      "`tauri signer generate` 는 새 keypair 를 만들어 K 의 기존 설치본이 새 .sig 를 검증할 수 없게 됩니다. " +
      "결과: 인앱 updater 가 'Signature verification failed' 로 멈추고 K 가 setup.exe 를 수동 설치해야 합니다 " +
      "(memory/pitfall_tauri_signing_key_rotation.md — v0.4.3 → v0.4.6 사고 참조).",
    remedy: [
      "정말 키 로테이션이 필요한지 K 와 먼저 확인하세요. 대부분의 경우 다음으로 충분합니다:",
      "  - 기존 키 비밀번호가 깨졌으면, 비밀번호만 다시 GitHub Actions secret 에 정확히 저장 (BOM 없이)",
      "  - 새 키가 정말 필요하면, K 에게 \"setup.exe 수동 1회 설치\" 가 필요함을 명시하고 동의받기",
      "  - override 방법: KDA_PITFALL_GUARD=0 으로 sidecar 재기동 시 가드 해제",
    ].join("\n"),
  },
];

// ─── frontmatter 파서 (최소 구현) ──────────────────────────────
// `---` 로 감싼 블록을 key: value 로 파싱. value 의 양끝 따옴표는 제거.
// YAML single-quoted scalar 에서는 backslash 가 리터럴이라 정규식 그대로 보존됨.
function parseFrontmatter(rawText) {
  // CRLF 정규화: 마지막 블록 라인에 남는 \r 이 정규식 `$` 앵커를 깨뜨림
  const text = rawText.replace(/\r\n/g, "\n");
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const block = text.slice(3, end);
  const out = {};
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let val = m[2].trim();
    if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
      // YAML single-quoted scalar: '' → ' (그 외 backslash 등은 리터럴)
      val = val.slice(1, -1).replace(/''/g, "'");
    } else if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

// ─── memory/pitfall_*.md 에서 guard_pattern 동적 로드 ──────────
// 반환: [{ id, match, reason, remedy }]  — FALLBACK 과 동일 형태.
function loadPitfallsFromMemory() {
  let files;
  try {
    files = readdirSync(MEMORY_DIR).filter(
      (f) => f.startsWith("pitfall_") && f.endsWith(".md"),
    );
  } catch {
    return [];
  }
  const loaded = [];
  for (const file of files) {
    let fm;
    try {
      const text = readFileSync(join(MEMORY_DIR, file), "utf-8");
      fm = parseFrontmatter(text);
    } catch {
      continue;
    }
    if (!fm || !fm.guard_pattern) continue;

    const tool = fm.guard_tool || "Bash";
    const field = fm.guard_field || "command";
    const flags = fm.guard_flags || "i";
    let re;
    try {
      re = new RegExp(fm.guard_pattern, flags);
    } catch {
      // 잘못된 정규식 → 이 항목만 건너뜀 (가드 전체는 계속)
      continue;
    }
    // id: 파일명에서 pitfall_ 접두/.md 제거 후 _ → -  (fallback id 와 dedupe)
    const id =
      (fm.guard_id && fm.guard_id.trim()) ||
      file.replace(/^pitfall_/, "").replace(/\.md$/, "").replace(/_/g, "-");

    loaded.push({
      id,
      match: (toolName, input) => {
        if (toolName !== tool) return false;
        return re.test(String(input?.[field] ?? ""));
      },
      reason:
        (fm.description && fm.description.trim()) ||
        `memory/${file} 에 등록된 함정 패턴이 감지되었습니다.`,
      // guard_remedy 는 단일 라인 YAML 에 \n 리터럴로 줄바꿈을 표현 → 실제 개행으로 복원
      remedy: fm.guard_remedy
        ? fm.guard_remedy.trim().replace(/\\n/g, "\n")
        : `회피책은 memory/${file} 를 참고하세요. (override: KDA_PITFALL_GUARD=0)`,
    });
  }
  return loaded;
}

// ─── 최종 PITFALLS = fallback + 동적 (동일 id 는 동적이 우선) ──
function buildPitfalls() {
  const byId = new Map();
  for (const p of FALLBACK_PITFALLS) byId.set(p.id, p);
  for (const p of loadPitfallsFromMemory()) byId.set(p.id, p); // .md 우선
  return [...byId.values()];
}

const PITFALLS = buildPitfalls();

// ─── stdin 처리 ─────────────────────────────────────────────────
let raw = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  try {
    main(raw);
  } catch (err) {
    // 가드 자체 에러는 자동화를 막지 않도록 통과
    process.stderr.write(
      `[pitfallGuard] internal error (passing through): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    process.exit(0);
  }
});

function main(raw) {
  if (!GUARD_ENABLED) process.exit(0);
  if (!raw.trim()) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = payload?.tool_name;
  const input = payload?.tool_input ?? {};
  if (!toolName) process.exit(0);

  for (const p of PITFALLS) {
    let hit = false;
    try {
      hit = !!p.match(toolName, input);
    } catch {
      hit = false;
    }
    if (hit) {
      process.stderr.write(
        [
          `[K Desktop Agent pitfall guard] '${p.id}' 패턴이 감지되어 차단됩니다.`,
          "",
          `[이유] ${p.reason}`,
          "",
          p.remedy,
        ].join("\n") + "\n",
      );
      process.exit(2);
    }
  }

  process.exit(0);
}
