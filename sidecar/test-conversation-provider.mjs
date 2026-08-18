#!/usr/bin/env node
/**
 * Phase 144 (v0.7.20) — W1(대화별 provider) / W2(provider 별 agent_id) / W3(task-watch 오배송) 회귀 테스트.
 *
 * 왜 이 테스트가 필요한가:
 *   provider 선택은 DB(db.ts) + 해석(providerResolve.ts) + 5개 send 경로(App.tsx) + UI(Sidebar.tsx)
 *   에 걸쳐 있다. 어느 한 곳에서 전역 localStorage 를 직접 다시 읽어버리면 그 경로만 조용히
 *   "전역 provider" 로 되돌아간다 — 화면상 증상이 없어 발견이 늦다. 특히 task-watch 는
 *   마커가 A 대화를 지정해도 그 순간 전역에 켜진 엔진으로 turn 이 나가는 **오배송**이 된다.
 *
 * 구성:
 *   [A] 행위 테스트 — 전역 provider 를 대화별 값과 **반대로** 세팅하고 실제 함수를 호출해
 *       대화별 값이 이기는지 확인. (providerResolveBehavior.mjs 를 strip-types 로 spawn)
 *   [B] 배선 정적 검사 — 5개 send 경로가 전부 buildSendSettings(convId) 를 쓰는지,
 *       그리고 전역 localStorage 직접 읽기가 send 경로에 다시 기어들어오지 않았는지.
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
const resolveTs = read("src/providerResolve.ts");
const sidebarTsx = read("src/components/Sidebar.tsx");
const typesTs = read("src/types.ts");
const sidecarTs = read("sidecar/src/index.ts");

/**
 * 주석/문자열을 제외한 "실제 코드"만 남긴다.
 * 개수를 세는 검사(인자 없는 호출 0건, 전역 직접 읽기 ≤N)는 주석에 같은 문구가 적혀 있으면
 * 오탐이 난다. 검사를 느슨하게 만드는 게 아니라 **세는 대상을 코드로 한정**하는 것이다.
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
    // 문자열 내부
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

console.log("Phase 144 — 대화별 provider (W1/W2/W3) 회귀 테스트\n");

/**
 * 현재 런타임이 TS 타입 스트리핑(.ts 직접 import)을 지원하는가.
 * node >=22.6 --experimental-strip-types, >=22.18 기본 활성. node 20 엔 아예 없음.
 * [함정 2026-08-18] CI(node 20)에서 [A] 만 조용히 FAIL 해 36/37 이 되고 릴리스가
 * 게이트에서 차단됐다(run 32093301024). 런타임을 감지해 "미지원 = SKIP",
 * "지원하는데 실패 = FAIL" 로 분리한다. 커버리지 손실은 아래 [A0] 잠금 검사가 막는다.
 */
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split(".").map(Number);
const STRIP_TYPES_SUPPORTED = NODE_MAJOR > 22 || (NODE_MAJOR === 22 && NODE_MINOR >= 6);

// ── [A0] CI Node 버전 잠금 ───────────────────────────────────────────────
// [A] 를 SKIP 가능하게 만든 대가로, CI 가 실제로 [A] 를 "돌리는" Node 를 쓰는지 잠근다.
// 누가 release.yml 의 node-version 을 20 으로 되돌리면 여기서 FAIL 한다.
console.log("[A0] CI Node 버전 — 행위 테스트가 실제로 실행되는 런타임인가");
{
  const wf = read(".github/workflows/release.yml");
  const m = /node-version:\s*'?"?(\d+)/.exec(wf);
  const major = m ? Number(m[1]) : 0;
  check(
    "release.yml node-version >= 22 (TS 타입 스트리핑 필요)",
    major >= 22,
    `현재 node-version: ${m ? m[1] : "미검출"} — 20 이면 [A] 행위 22개가 CI 에서 SKIP 되어 무방비`,
  );
}

// ── [A] 행위 테스트 (전역 ↔ 대화별 반대 세팅) ────────────────────────────
console.log("\n[A] 행위 — 전역을 반대값으로 세팅해도 대화별 provider 가 이긴다");
if (!STRIP_TYPES_SUPPORTED) {
  console.log(
    `  ⏭️  SKIP — node ${process.versions.node} 는 TS 타입 스트리핑 미지원(>=22.6 필요). ` +
      `CI 런타임은 [A0] 가 잠근다.`,
  );
} else {
  const behaviorFile = path.join(__dirname, "providerResolveBehavior.mjs");
  // TS 순수 모듈을 실제로 import 해 실행한다 (소스 문자열 검사 아님).
  let r = spawnSync(process.execPath, ["--experimental-strip-types", behaviorFile], {
    cwd: __dirname,
    encoding: "utf8",
  });
  // 미래 node 에서 플래그가 사라져도(기본 지원) 죽지 않도록 1회 폴백.
  if (r.status !== 0 && /bad option|not allowed|Unknown option/i.test((r.stderr || ""))) {
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
    // 행위 assertion 을 총계에 합산 (게이트 집계에 실제 개수가 잡히도록)
    pass += Number(m[1]);
    fail += Number(m[2]) - Number(m[1]);
  }
}

// ── [B] providerResolve — 폴백 규칙이 소스에 남아 있는지 ──────────────────
console.log("\n[B] providerResolve — 폴백/키 선택 규칙");
check("pin 우선 + 전역 폴백", /const provider = pinnedProvider \|\| globalProvider;/.test(resolveTs));
check("확정 provider 기준 apiKey", /if \(provider !== "claude"\)[\s\S]{0,400}keys\[provider\]/.test(resolveTs));
check("gemini-cli → gemini 키 재사용", /provider === "gemini-cli" && !apiKey/.test(resolveTs));
check("source 표기(conversation/global)", /source: "conversation" \| "global"/.test(resolveTs));

// ── [C] DB 마이그레이션 ──────────────────────────────────────────────────
console.log("\n[C] DB — 컬럼 추가 + 접근자");
check("ALTER conversations ADD COLUMN provider", /ALTER TABLE conversations ADD COLUMN provider TEXT/.test(dbTs));
check("ALTER conversations ADD COLUMN model", /ALTER TABLE conversations ADD COLUMN model TEXT/.test(dbTs));
check("agent_id_claude/codex/gemini 컬럼",
  /ADD COLUMN agent_id_claude TEXT/.test(dbTs) &&
  /ADD COLUMN agent_id_codex TEXT/.test(dbTs) &&
  /ADD COLUMN agent_id_gemini TEXT/.test(dbTs));
check("getConversationProvider 정의", /export async function getConversationProvider\(/.test(dbTs));
check("updateConversationProvider 정의", /export async function updateConversationProvider\(/.test(dbTs));
check("getAllConversations 가 provider 매핑", /provider: row\.provider \?\? null/.test(dbTs));
check("Conversation 타입에 provider", /provider\?: string \| null;/.test(typesTs));
// W2 — claude 만 레거시 agent_id 로 폴백해야 한다 (codex 가 폴백하면 고아 thread 크래시)
check("W2 claude 만 레거시 agent_id 폴백",
  /if \(col === "agent_id_claude"\) return row\.legacy \?\? null;[\s\S]{0,80}return null;/.test(dbTs));

// ── [D] send 경로 5곳이 전부 대화별 ──────────────────────────────────────
console.log("\n[D] send 경로 — 전부 buildSendSettings(convId)");
check("buildSendSettings 가 convId 를 받는다",
  /const buildSendSettings = useStableCallback\(async \(convId\?: string\) => \{/.test(appTsx));
check("buildSendSettings 가 대화별 pin 조회", /await getConversationProvider\(convId\)/.test(appTsx));
check("buildSendSettings 가 resolveProviderSettings 사용",
  /resolveProviderSettings\(pin, localStorage\)/.test(appTsx));

// 인자 없는 호출이 남아 있으면 그 경로는 전역으로 되돌아간 것 = 결함 재발
const bareCalls = appCode.match(/buildSendSettings\(\s*\)/g) || [];
check("인자 없는 buildSendSettings() 호출 0건", bareCalls.length === 0, `${bareCalls.length}건 발견`);

const withConv = appCode.match(/buildSendSettings\(convId[^)]*\)/g) || [];
check("convId 를 넘기는 호출 5곳 이상", withConv.length >= 5, `${withConv.length}곳`);

// 각 경로별 개별 확인 (한 곳만 빠져도 잡히게). 전부 주석 제거본 기준.
check("① 직접 입력 경로", /const convSettings = await buildSendSettings\(convId \|\| undefined\);/.test(appCode));
const telegramBody = appCode.slice(appCode.indexOf("const sendTelegramTurn"), appCode.indexOf("const sendTelegramTurn") + 6000);
check("② 텔레그램 경로", /await buildSendSettings\(convId\)/.test(telegramBody));
const schedIdx = appCode.indexOf("scheduleTurnsRef.current.set");
check("③ 예약(remote trigger) 경로",
  /await buildSendSettings\(convId\)/.test(appCode.slice(Math.max(0, schedIdx - 4000), schedIdx)));
const twIdx = appCode.indexOf("taskWatchTurnsRef.current.set(turnId");
check("④ task-watch 경로 (W3 오배송 가드)",
  /await buildSendSettings\(convId\)/.test(appCode.slice(Math.max(0, twIdx - 4000), twIdx)));
check("⑤ resume 재시도 경로", /const resumeSettings = await buildSendSettings\(convId\);/.test(appCode));

// send 경로에 전역 직접 읽기가 재유입되지 않았는지.
// 허용: activeProvider state 초기화/동기화(4곳). 그 이상이면 어떤 경로가 전역으로 되돌아간 것.
const globalReads = appCode.match(/localStorage\.getItem\("kda_active_provider"\)/g) || [];
check("전역 provider 직접 읽기 ≤ 4 (표시용 state 만)", globalReads.length <= 4, `${globalReads.length}건`);

// ── [E] W2 — provider 별 세션 id ─────────────────────────────────────────
console.log("\n[E] W2 — provider 별 agent_id + Codex resume 회복");
check("turnProviderMap 존재", /const turnProviderMap = useRef<Map<string, string>>/.test(appTsx));
const setProv = appTsx.match(/turnProviderMap\.current\.set\(/g) || [];
check("send 5경로에서 turnProviderMap set", setProv.length >= 5, `${setProv.length}건`);
check("done 이 provider 별 컬럼에 저장",
  /updateConversationAgentIdFor\(convForTurn, prov, aid\)/.test(appTsx) &&
  /updateConversationAgentIdFor\(convIdForDone, provForDone, aid\)/.test(appTsx));
check("agent_id 조회도 provider 별", (appTsx.match(/getConversationAgentIdFor\(/g) || []).length >= 5);
check("resume_session_missing 회복이 provider 별 + background 포함",
  /updateConversationAgentIdFor\(convForErr, errProvider, null\)/.test(appTsx));
// sidecar 측 Codex 고아 thread 자동 회복 (Phase 126) 이 살아 있는지
check("sidecar Codex resume 고아 감지", /no rollout found for thread id\|thread\\\/resume/.test(sidecarTs));
check("sidecar Codex 새 세션 1회 재시도", /_codexResumeRetried: true,/.test(sidecarTs));

// ── [F] UI — 지정/표시 + 폴백 가시성 ────────────────────────────────────
console.log("\n[F] UI — 대화별 엔진 지정/표시");
check("컨텍스트 메뉴 항목", /🤖 엔진: \$\{providerLabel\(c\?\.provider \?\? null\)\}…/.test(sidebarTsx));
check("provider picker 렌더", /if \(kind === "provider"\)/.test(sidebarTsx));
check("스트리밍 중 안내 문구", /변경은 다음 턴부터 적용됩니다/.test(sidebarTsx));
check("고정된 대화만 배지 표시", /\{c\.provider && \(/.test(sidebarTsx));
check("App → Sidebar 배선", /onSetConversationProvider=\{handleSetConversationProvider\}/.test(appTsx));
check("해제(전역 따름) 가능", /PINNABLE_PROVIDERS/.test(sidebarTsx) && /^\s*null,$/m.test(resolveTs.slice(resolveTs.indexOf("PINNABLE_PROVIDERS"))));

console.log(`\n결과: ${pass}/${pass + fail} 통과`);
process.exit(fail === 0 ? 0 : 1);
