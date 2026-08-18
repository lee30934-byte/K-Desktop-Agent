#!/usr/bin/env node
/**
 * Phase 145 (v0.7.22) — 폴더 프로젝트 지침(권한 경계) 전 send 경로 주입 회귀 테스트.
 *
 * 왜 이 테스트가 필요한가 (실제 사고, 2026-08-18 / cae-automation):
 *   폴더 지침 해석이 handleSendMessage 안에만 인라인으로 있었다. 그래서 **사람이 직접
 *   입력한 turn 만** 프로젝트 지침(= 수정 금지 경로, git 금지 목록, 판정 권한 없음)을
 *   받았고, 자동 주입 경로(task-watch / 텔레그램 / 예약·remote trigger / resume)는
 *   지침 없이 실행됐다 — 에러도 경고도 없이 조용히. 주입된 실행자 turn 이 통째로
 *   무권한 상태로 굴러갔고, 회피책은 "프롬프트에 경계를 손으로 매번 동봉" 이라
 *   한 번만 빠뜨려도 재발하는 구조였다.
 *
 * 구성:
 *   [A] 행위 테스트 — 실제 resolveFolderContext 를 import 해 호출 (문자열 검사 아님).
 *   [B] 배선 정적 검사 — 5개 send 경로가 전부 buildFolderContext 를 거쳐
 *       folderSystemPrompt 를 send_message 에 싣는지, 인라인 조회로 되돌아가지 않았는지.
 */

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function read(rel) {
  const p = path.resolve(root, rel);
  if (!existsSync(p)) {
    console.error(`source not found: ${p}`);
    process.exit(1);
  }
  return readFileSync(p, "utf-8");
}

const appTsx = read("src/App.tsx");
const dbTs = read("src/db.ts");
const folderCtxTs = read("src/folderContext.ts");
const libRs = read("src-tauri/src/lib.rs");

/**
 * 주석/문자열을 제외한 "실제 코드"만 남긴다.
 * 개수를 세는 검사는 주석에 같은 문구가 있으면 오탐이 난다 — 검사를 느슨하게 하는 게
 * 아니라 **세는 대상을 코드로 한정**하는 것이다. (test-conversation-provider.mjs 와 동일)
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  let mode = "code"; // code | line | block | sq | dq | tpl
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") { mode = "line"; i += 2; continue; }
      if (c === "/" && n === "*") { mode = "block"; i += 2; continue; }
      if (c === "'") mode = "sq";
      else if (c === '"') mode = "dq";
      else if (c === "`") mode = "tpl";
      out += c; i++; continue;
    }
    if (mode === "line") {
      if (c === "\n") { mode = "code"; out += c; }
      i++; continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") { mode = "code"; i += 2; continue; }
      if (c === "\n") out += c;
      i++; continue;
    }
    if (c === "\\") { out += c + (n ?? ""); i += 2; continue; }
    if ((mode === "sq" && c === "'") || (mode === "dq" && c === '"') || (mode === "tpl" && c === "`")) {
      mode = "code";
    }
    out += c; i++;
  }
  return out;
}

const appCode = stripComments(appTsx);

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

console.log("Phase 145 — 폴더 지침 전 경로 주입 회귀 테스트\n");

// ── [A0] 행위 테스트의 런타임 비의존성 잠금 ──────────────────────────────
// [함정 2026-08-18 / pitfall_ci_node20_type_stripping] .ts 정적 import 는 node >=22.6
// 에만 있어 CI(node 20)에서만 조용히 죽는다 → 로컬에서만 도는 테스트는 착시다.
console.log("[A0] 행위 테스트 로더 — 런타임(node 버전) 비의존인가");
{
  const behaviorSrc = read("sidecar/folderContextBehavior.mjs");
  check(
    "타입 스트리핑 미지원 런타임용 transpile 폴백 존재",
    /ERR_UNKNOWN_FILE_EXTENSION/.test(behaviorSrc) &&
      /import\("typescript"\)/.test(behaviorSrc) &&
      /transpileModule/.test(behaviorSrc),
    "폴백이 사라지면 node<22.6(CI) 에서 행위 assertion 이 통째로 죽는다",
  );
  check(
    ".ts 정적 import 재유입 없음",
    !/^import\s+\{[^}]*\}\s+from\s+"\.\.\/src\/folderContext\.ts"/m.test(behaviorSrc),
    "정적 import 로 되돌리면 구버전 런타임에서 모듈 로드 자체가 실패한다",
  );
}

// ── [A] 행위 테스트 (실제 함수 호출) ─────────────────────────────────────
console.log("\n[A] 행위 — 자동 주입 경로도 지침을 받는다");
{
  const behaviorFile = path.join(__dirname, "folderContextBehavior.mjs");
  let r = spawnSync(process.execPath, ["--experimental-strip-types", behaviorFile], {
    cwd: __dirname,
    encoding: "utf8",
  });
  // 미래 node 에서 플래그가 사라져도(기본 지원) 죽지 않도록 1회 폴백.
  if (r.status !== 0 && /bad option|not allowed|Unknown option/i.test(r.stderr || "")) {
    r = spawnSync(process.execPath, [behaviorFile], { cwd: __dirname, encoding: "utf8" });
  }
  const out = (r.stdout || "") + (r.stderr || "");
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    if (line.trim()) console.log(`  ${line.trim()}`);
  }
  const m = /BEHAVIOR-SUMMARY:\s*(\d+)\/(\d+)\s*assertions ok/.exec(out);
  check(
    "[A] 행위 테스트 전부 통과",
    r.status === 0 && !!m && m[1] === m[2],
    m ? `${m[1]}/${m[2]}` : `exit ${r.status} / ${(r.stderr || "").slice(0, 300)}`,
  );
  if (m) {
    pass += Number(m[1]);
    fail += Number(m[2]) - Number(m[1]);
  }
}

// ── [B] 순수 모듈 — 규칙이 소스에 남아 있는지 ────────────────────────────
console.log("\n[B] folderContext — 결정 규칙");
check("resolveFolderContext export", /export function resolveFolderContext\(/.test(folderCtxTs));
check("EMPTY_FOLDER_CONTEXT export", /export const EMPTY_FOLDER_CONTEXT/.test(folderCtxTs));
check(
  "지침은 첨부 옵션과 무관하게 결정 (allowAttachments 는 첨부만 가른다)",
  /const allowAttachments = options\?\.allowAttachments !== false;/.test(folderCtxTs) &&
    !/allowAttachments[\s\S]{0,120}folderSystemPrompt =/.test(folderCtxTs),
  "allowAttachments 가 지침까지 막으면 자동 주입 turn 이 다시 무권한이 된다",
);
check("첨부는 sentinel 불일치일 때만", /\(conv\?\.lastAttachedFolderId \?\? null\) !== folderId/.test(folderCtxTs));
check(
  "EMPTY 를 스프레드로 반환 (공유 객체 오염 방지)",
  (folderCtxTs.match(/\{ \.\.\.EMPTY_FOLDER_CONTEXT \}/g) || []).length >= 1,
);
check("React/Tauri/DOM 비의존 (테스트 가능성 잠금)",
  !/from "react"|@tauri-apps|localStorage|document\./.test(folderCtxTs));

// ── [C] DB — 대화 폴더 상태 조회 ─────────────────────────────────────────
console.log("\n[C] DB — 주입 경로용 폴더 상태 조회");
check("getConversationFolderState 정의", /export async function getConversationFolderState\(/.test(dbTs));
check(
  "in-memory 가 아니라 DB 에서 조회",
  /SELECT folder_id, last_attached_folder_id FROM conversations WHERE id = \?/.test(dbTs),
  "주입 turn 은 화면에 안 떠 있는 대화를 겨냥할 수 있어 state 조회로는 못 잡는다",
);

// ── [D] send 경로 5곳이 전부 폴더 지침을 싣는다 ─────────────────────────
console.log("\n[D] send 경로 — 전부 buildFolderContext 경유");
check("buildFolderContext 헬퍼 정의", /const buildFolderContext = useStableCallback\(/.test(appTsx));
check("commitFolderAttachment 헬퍼 정의", /const commitFolderAttachment = useStableCallback\(/.test(appTsx));
check("헬퍼가 순수 모듈을 쓴다", /resolveFolderContext\(convState, folder, options\)/.test(appCode));
check("지침 로드 실패가 turn 을 죽이지 않는다",
  /catch \(err\) \{[\s\S]{0,160}폴더 지침 로드 실패[\s\S]{0,120}return \{ \.\.\.EMPTY_FOLDER_CONTEXT \};/.test(appTsx));

const ctxCalls = appCode.match(/await buildFolderContext\(/g) || [];
check("buildFolderContext 호출 5곳 이상 (send 경로 전부)", ctxCalls.length >= 5, `${ctxCalls.length}곳`);

// 각 경로별 개별 확인 (한 곳만 빠져도 잡히게). 전부 주석 제거본 기준.
const near = (marker, back, fwd) => {
  const i = appCode.indexOf(marker);
  if (i < 0) return "";
  return appCode.slice(Math.max(0, i - back), i + fwd);
};

check(
  "① 직접 입력 경로",
  /const folderCtx = await buildFolderContext\(convId, \{ allowAttachments: true \}\);/.test(appCode) &&
    /^\s*folderSystemPrompt,$/m.test(appCode),
);
{
  const body = near("const sendTelegramTurn", 0, 6000);
  check("② 텔레그램 경로",
    /await buildFolderContext\(convId\)/.test(body) &&
      /folderSystemPrompt: folderCtx\.folderSystemPrompt,/.test(body));
}
{
  const body = near("scheduleTurnsRef.current.set", 4000, 3000);
  check("③ 예약(remote trigger) 경로",
    /await buildFolderContext\(convId\)/.test(body) &&
      /folderSystemPrompt: folderCtx\.folderSystemPrompt,/.test(body));
}
{
  const body = near("taskWatchTurnsRef.current.set(turnId", 4000, 3000);
  check("④ task-watch 경로 (실제 사고 지점)",
    /await buildFolderContext\(convId\)/.test(body) &&
      /folderSystemPrompt: folderCtx\.folderSystemPrompt,/.test(body));
  check("④ FIRE 로그에 지침 적재 여부 기록 (재발 시 로그로 즉시 판별)",
    /folderInstructions=\$\{folderCtx\.folderSystemPrompt \? "yes" : "no"\}/.test(appTsx));
}
{
  const body = near("await buildFolderContext(activeConversationIdRef.current)", 0, 1500);
  check("⑤ resume 재시도 경로",
    body.length > 0 && /folderSystemPrompt: folderCtx\.folderSystemPrompt,/.test(body));
}

// projectProfile 도 같은 5경로에 실려야 한다 (projectMode ON 일 때 도구 차단 근거)
const profileFields = appCode.match(/projectProfile: folderCtx\.projectProfile,/g) || [];
check("projectProfile 도 자동 주입 4경로에 적재", profileFields.length >= 4, `${profileFields.length}건`);

// 인라인 폴더 조회가 send 경로에 재유입되지 않았는지 = 결함 재발 신호.
// handleSendMessage 이후(= 모든 send 경로 + 헬퍼가 사는 영역)에서 getFolderById 는
// buildFolderContext 안의 1건뿐이어야 한다. 그 앞쪽 1건은 폴더 지침 편집 다이얼로그로 무관.
{
  const sendRegion = appCode.slice(appCode.indexOf("const handleSendMessage"));
  const inlineLookups = sendRegion.match(/getFolderById\(/g) || [];
  check(
    "send 영역의 getFolderById 는 헬퍼 1곳뿐 (인라인 조회 재유입 없음)",
    inlineLookups.length === 1,
    `${inlineLookups.length}건 — send 경로가 다시 자체 조회하면 경로별 누락이 살아난다`,
  );
}

// ── [E] Rust 수신부가 이미 필드를 받는지 (배선 끝단) ─────────────────────
console.log("\n[E] Rust — send_message 가 폴더 필드를 수신");
check("folder_system_prompt 파라미터", /folder_system_prompt/.test(libRs));
check("folder_attachment_paths 파라미터", /folder_attachment_paths/.test(libRs));
check("project_profile 파라미터", /project_profile/.test(libRs));

console.log(`\n결과: ${pass}/${pass + fail} 통과`);
process.exit(fail === 0 ? 0 : 1);
