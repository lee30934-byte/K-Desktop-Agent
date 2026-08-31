#!/usr/bin/env node
/**
 * Phase 145 — 대화창 오염(응답이 다른 대화창에 나옴) 근본 대책 회귀 테스트.
 *
 * 사고 요약 (2026-08-31 실측, 3,679 턴 스캔에서 10건 확인):
 *   도구 하나에 12분 넘게 머문 긴 턴이 끝나면, 그 최종 답변이 K 가 그때 보고 있던
 *   *다른* 대화창에 저장됐다 (61/66/42/41/40/19/12/12분 …).
 *
 * 인과 3단 — 이 테스트는 세 고리를 각각 못박는다:
 *   ① 라우팅 진실이 프론트 휘발성 메모리(turnToConvMap)에만 있었다
 *      → sidecar 가 모든 이벤트에 conversation_id 를 찍는다.  [A: 런타임 실측]
 *   ② 12분 무이벤트 워치독이 turnToConvMap 을 통째로 clear 했다 (살아 있는 턴까지)
 *      → 일괄 clear 제거.                                        [C: 소스 불변식]
 *   ③ 맵 miss 시 activeConversationIdRef 로 폴백해 남의 대화에 영구 저장했다
 *      → 폴백 제거, 모르면 drop + warn.                          [B: 소스 불변식]
 *
 * A 는 소스 패턴이 아니라 **실제로 sidecar 를 띄워 stdin/stdout 으로 왕복**시켜
 * 검증한다 (정규식은 "코드가 있다" 만 증명하지 "동작한다" 는 증명 못 한다).
 * API 키 없는 REST provider 로 턴을 보내면 sidecar 가 외부 CLI 없이 즉시
 * error + done 을 뱉으므로, 네트워크·구독 없이 스탬프 경로를 통과시킬 수 있다.
 */

import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
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

let pass = 0;
let fail = 0;
let skipped = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const appTsx = read("src/App.tsx");
const indexTs = read("sidecar/src/index.ts");
const typesTs = read("src/types.ts");

// ─── A. sidecar conversation_id 스탬프 — 런타임 실측 ──────────────────────
//
// 프로토콜: stdin 에 line-delimited JSON. api_key 없는 REST provider 는
// handleViaRestAPI 초입에서 error + done 을 즉시 emit 하고 리턴한다.
// 두 이벤트 모두 rawEmit 을 지나므로 스탬프가 찍혀야 한다.

const CONV = "CONV-ORIGIN-145";
const TURN = "TURN-145-A";
const OTHER_TURN = "TURN-145-UNKNOWN"; // 등록 안 된 턴 — 스탬프가 없어야 한다

async function runtimeStampTest() {
  const dist = path.resolve(root, "sidecar/dist/index.js");
  if (!existsSync(dist)) {
    // 0.7.28 — 그룹 A 는 "빌드된 sidecar 를 spawn 하는" 환경 의존 검사다.
    // 깨끗한 체크아웃(CI 의 release:gate:fast 단계는 sidecar 빌드보다 먼저 돈다)엔
    // dist 가 없으므로 하드 FAIL 이 아니라 SKIP 한다. 소스 정적 검사(B~E)는 그대로 돈다.
    // CI 는 sidecar 빌드 뒤 게이트를 한 번 더 돌려 이 그룹까지 실측한다(release.yml).
    // 근본 원인: 새 테스트를 만들 때 "모든 test-*.mjs 는 정적 검사"라는 가정을 따랐음.
    skipped += 6;
    console.log(`  ⏭️  A그룹 6건 SKIP — sidecar/dist/index.js 없음 (npm run build 선행 필요)`);
    console.log(`      ${dist}`);
    return;
  }

  const events = [];
  const child = spawn(process.execPath, [dist], {
    cwd: path.resolve(root, "sidecar"),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, KDA_HEADLESS: "1" },
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const done = new Promise((resolve) => {
    const timer = setTimeout(resolve, 20_000); // 안전망 — 무한 대기 금지
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t.startsWith("{")) return;
      let ev;
      try { ev = JSON.parse(t); } catch { return; }
      events.push(ev);
      // 두 턴의 done 을 모두 받으면 종료
      const doneIds = events.filter((e) => e.type === "done").map((e) => e.id);
      if (doneIds.includes(TURN) && doneIds.includes(OTHER_TURN)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", () => { clearTimeout(timer); resolve(); });
  });

  // ready 를 기다리지 않고 바로 써도 stdin 라인 리더가 받는다(등록은 모듈 init 시점).
  child.stdin.write(JSON.stringify({
    type: "user_message", id: TURN, conversation_id: CONV,
    content: "ping", provider: "anthropic", history: [],
  }) + "\n");
  // conversation_id 없는 턴 — 없는 정보를 지어내지 않는지 확인
  child.stdin.write(JSON.stringify({
    type: "user_message", id: OTHER_TURN,
    content: "ping", provider: "anthropic", history: [],
  }) + "\n");

  await done;
  try { child.kill("SIGKILL"); } catch { /* already gone */ }

  const mine = events.filter((e) => e.id === TURN);
  check(`A① 턴 이벤트 수신 (실제 ${mine.length}건)`, mine.length >= 2,
    JSON.stringify(events.slice(0, 6)));

  const stampedAll = mine.length > 0 && mine.every((e) => e.conversation_id === CONV);
  check("A② 그 턴의 *모든* 이벤트에 conversation_id 스탬프", stampedAll,
    JSON.stringify(mine.map((e) => [e.type, e.conversation_id])));

  const doneEv = mine.find((e) => e.type === "done");
  check("A③ done 이벤트에 스탬프 (오염의 핵심 지점)",
    !!doneEv && doneEv.conversation_id === CONV,
    doneEv ? JSON.stringify(doneEv) : "done 없음");

  const errEv = mine.find((e) => e.type === "error");
  check("A④ error 이벤트에 스탬프",
    !!errEv && errEv.conversation_id === CONV,
    errEv ? JSON.stringify(errEv) : "error 없음");

  const others = events.filter((e) => e.id === OTHER_TURN);
  check("A⑤ conversation_id 미상 턴에는 스탬프를 지어내지 않음",
    others.length > 0 && others.every((e) => e.conversation_id === undefined),
    JSON.stringify(others.map((e) => [e.type, e.conversation_id])));

  // 다른 대화의 턴에 남의 conv 가 새지 않는지
  check("A⑥ 턴 간 conv 누수 없음",
    others.every((e) => e.conversation_id !== CONV));
}

// ─── B. 프론트: 맵 miss 시 활성 대화로 폴백하지 않음 ──────────────────────
// 이벤트 핸들러 영역에서 `?? activeConversationIdRef.current` 가 사라졌는지.
// (문자열 하나만 남아도 그 경로로 오염이 재발한다.)
const fallbackHits = (appTsx.match(/turnToConvMap\.current\.get\([^)]*\)\s*\?\?\s*activeConversationIdRef\.current/g) || []);
check(`B① turnToConvMap → activeConversationIdRef 폴백 제거 (잔존 ${fallbackHits.length}곳)`,
  fallbackHits.length === 0, fallbackHits.join(" | "));

check("B② 통합 라우팅 해석기 resolveEventConv 존재", /const resolveEventConv\s*=/.test(appTsx));
check("B③ 해석기가 sidecar 스탬프를 1순위로 사용",
  /const stamped = \(ev as \{ conversation_id\?: string \}\)\.conversation_id;[\s\S]{0,120}if \(stamped\) return stamped;/.test(appTsx));
const resolverBody = (appTsx.match(/const resolveEventConv = useStableCallback\(\(ev: SidecarEvent\): string \| null =>[\s\S]*?\n  \}\);/) || [""])[0];
check("B④ 해석기가 실패 시 null 반환 (활성 대화 추측 금지)",
  resolverBody.length > 0
    && /return null;/.test(resolverBody)
    && !/activeConversationIdRef/.test(resolverBody),
  resolverBody ? "본문에 activeConversationIdRef 가 섞였거나 return null 누락" : "resolveEventConv 본문 추출 실패");

// 귀속 불명 이벤트를 조용히 삼키지 않고 경고 (회귀 탐지 가능성 유지)
check("B⑤ 귀속 불명 이벤트 경고 경로 존재", /warnUnroutable/.test(appTsx));
const dropSites = (appTsx.match(/if \(!convForTurn\) \{ warnUnroutable\(ev\); break; \}/g) || []).length;
check(`B⑥ 저장 경로 drop 가드 ≥4곳 (실제 ${dropSites})`, dropSites >= 4);

// done/error 는 UI 잠금 해제가 필요해 break 대신 warn 후 진행 — 저장은 conv 있을 때만.
check("B⑦ done 핸들러: null 이면 active 로 오인하지 않음",
  /const isActiveConv = !!convForTurn && convForTurn === activeConversationIdRef\.current;/.test(appTsx));
check("B⑧ error 핸들러: turn id 있으면 폴백 없이 해석",
  /const convForErr = ev\.id \? resolveEventConv\(ev\) : activeConversationIdRef\.current;/.test(appTsx));
check("B⑨ 귀속 불명이어도 입력 잠금은 해제 (안전한 방향의 실패)",
  /if \(!convForTurn && ev\.id && ev\.id === currentTurnIdRef\.current\)/.test(appTsx));

// ─── C. 워치독이 살아 있는 턴의 매핑을 지우지 않음 ────────────────────────
// 주석 안의 설명(“여기 있던 …clear() 가 원인이었다”)까지 세면 영원히 FAIL 하므로
// 실행되는 코드 줄만 대상으로 한다.
const codeLines = appTsx.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
const clearHits = codeLines.filter((l) => /turnToConvMap\.current\.clear\(\)/.test(l));
check(`C① turnToConvMap 일괄 clear 완전 제거 (실행 코드 잔존 ${clearHits.length}곳)`,
  clearHits.length === 0, clearHits.join(" | "));
// 잠금 해제 자체는 유지돼야 한다 (지우기만 하고 기능을 죽이면 안 됨)
check("C② 12분 강제 잠금해제는 그대로 동작", /STREAM_FORCE_UNLOCK_MS/.test(appTsx) &&
  /if \(idleMs > STREAM_FORCE_UNLOCK_MS\)[\s\S]{0,1200}setIsStreaming\(false\)/.test(appTsx));
check("C③ 매핑 무한증가 방지 상한 존재", /TURN_CONV_MAP_MAX/.test(appTsx));

// ─── D. sidecar 측 배선 ───────────────────────────────────────────────────
check("D① turnConversations 맵 선언", /const turnConversations = new Map<string, string>\(\)/.test(indexTs));
check("D② rawEmit 단일 지점에서 스탬프",
  /function rawEmit\([\s\S]{0,400}?conversationIdForTurn\(obj\.id\)/.test(indexTs));
check("D③ 명시된 conversation_id 는 덮어쓰지 않음",
  /if \(obj\.conversation_id === undefined\)/.test(indexTs));
check("D④ handleUserMessage 가 emit 이전에 등록",
  /async function handleUserMessage\(msg: UserMessage\): Promise<void> \{\s*\n\s*\/\/[^\n]*\n\s*rememberTurnConversation\(msg\.id, msg\.conversation_id\);/.test(indexTs));
check("D⑤ 오케스트레이션 main turn 도 등록",
  /rememberTurnConversation\(raw\.id, raw\.conversation_id\)/.test(indexTs));
check("D⑥ sub-turn(`{mainId}#{engine}`) 은 main 으로 귀속",
  /const hash = id\.indexOf\("#"\);[\s\S]{0,200}turnConversations\.get\(id\.slice\(0, hash\)\)/.test(indexTs));
const releaseCount = (indexTs.match(/releaseTurnConversation\(msg\.id\)/g) || []).length;
check(`D⑦ 모든 provider 경로에서 유예 해제 ≥4 (실제 ${releaseCount})`, releaseCount >= 4);
check("D⑧ 즉시 삭제가 아니라 유예 (늦게 오는 이벤트 보호)",
  /TURN_CONV_RETAIN_MS/.test(indexTs) && /setTimeout\(\(\) => turnConversations\.delete\(id\), TURN_CONV_RETAIN_MS\)/.test(indexTs));
check("D⑨ 유예 타이머 unref (프로세스 종료 차단 금지)", /unref\?\.\(\)/.test(indexTs));

// ─── E. 타입 ─────────────────────────────────────────────────────────────
check("E① SidecarEvent 에 conversation_id 필드",
  /SidecarEvent = SidecarEventPayload & \{ conversation_id\?: string \}/.test(typesTs));
check("E② optional 유지 (구버전 sidecar 호환)", /conversation_id\?: string/.test(typesTs));

// ─── F. done 후 다른 대화의 행이 재기록되지 않음 (Phase 146) ───────────────
// 2026-08-31 실측: Phase 145 를 넣고 v0.7.29 로 올린 뒤에도, 외부에서 재귀속한 214행 중
// 27행이 되돌아갔다. 되돌아간 건 전부 "그때 화면에 열려 있던 대화에서 빼낸" 행이었다.
// 원인은 done 핸들러의 일괄 재저장:
//     const toSave = updated.filter(m => m.role === "assistant" || m.role === "tool");
//     toSave.forEach(m => queueMessageSave(m));      // ← convId 미지정 = 활성 대화 폴백
// `updated` 는 이번 턴이 아니라 **화면에 떠 있는 대화의 스크롤백 전체**다. saveMessage 가
// `INSERT OR REPLACE INTO messages (id, conversation_id, …)` 라, 턴이 끝날 때마다 화면의
// 모든 옛 행의 conversation_id 가 현재 대화로 덮어써졌다 = 남의 대화 행 강탈.
console.log("\nF. done 재저장이 남의 대화를 덮어쓰지 않음 (Phase 146)");

// F① 저장 대상이 이번 턴 소유 메시지로 한정됐는가 (스크롤백 전체 금지)
const doneSave = (appTsx.match(/setMessages\(\(prev\) => \{[\s\S]{0,2600}?toSave\.forEach\([\s\S]{0,120}?\}, 0\);/) || [""])[0];
check("F① done 저장 대상이 turn 소유 메시지로 한정",
  /const ownsTurn = \(id: string\) =>/.test(doneSave)
  && /toSave = updated\.filter\([\s\S]{0,200}ownsTurn\(m\.id\)/.test(doneSave),
  doneSave ? "ownsTurn 필터 없음 — 스크롤백 전체를 재저장 중" : "done 저장 블록 추출 실패");

// F② 그 저장이 활성 대화가 아니라 turn 의 대화를 명시하는가
check("F② done 일괄 저장이 convForTurn 을 명시",
  /toSave\.forEach\(\(m\) => queueMessageSave\(m, convForTurn\)\);/.test(appTsx),
  "queueMessageSave(m) — 인자 없이 호출되면 activeConversationIdRef 로 폴백한다");

// F③ 구조적 불변식 — queueMessageSave 호출은 예외 없이 대화 id 를 넘긴다.
// (한 곳만 빠져도 그 경로로 오염이 재발한다. 실제로 1882/2306/4549 세 곳이 빠져 있었다.)
const bareCalls = [...appTsx.matchAll(/queueMessageSave\(([^;]*?)\);/g)]
  .map((m) => m[1])
  .filter((args) => !args.includes(","));
check(`F③ 인자 없는 queueMessageSave 호출 0곳 (실제 ${bareCalls.length})`,
  bareCalls.length === 0, bareCalls.map((a) => `queueMessageSave(${a})`).join(" | "));

// F④ AskUserQuestion — 질문이 난 대화를 질문 시점에 굳혀둔다.
// K 가 답할 때쯤이면 그 턴은 이미 done 이라 turnToConvMap 에서 지워졌고, 그 사이 K 가
// 다른 대화창으로 옮겨 있을 수 있다. 그때 폴백하면 답이 엉뚱한 대화에 박힌다.
check("F④ ask 상태가 대화 id 를 보관", /convId: string \| null;/.test(appTsx)
  && /convId: convForAsk,/.test(appTsx));
check("F⑤ ask placeholder 저장이 convForAsk 명시",
  /queueMessageSave\(askToolMsg, convForAsk\);/.test(appTsx));
check("F⑥ ask 답 patch 가 convId 를 인자로 받음",
  /\(turnId: string, toolUseId: string, kAnswer: string, convId: string \| null\) =>/.test(appTsx)
  && /queueMessageSave\(updated, convId\);/.test(appTsx));

// F⑦ 런타임 — 소스에서 뽑은 **실제** 술어를 그대로 실행해 소유 판정을 확인한다.
//     (정규식은 "필터가 있다" 만 증명한다. 판정이 맞는지는 돌려봐야 안다.)
{
  // 종결은 첫 `;` — 본문에 다른 세미콜론이 없다. (CRLF 환경을 타지 않도록 개행에 의존 안 함)
  const src = (doneSave.match(/const ownsTurn = \(id: string\) =>[\s\S]*?;/) || [""])[0]
    .replace(/: string/g, "");
  let ok = false, detail = "ownsTurn 추출 실패";
  if (src) {
    try {
      const ev = { id: "11111111-2222-3333-4444-555555555555" };
      // eslint-disable-next-line no-new-func
      const ownsTurn = new Function("ev", `${src} return ownsTurn;`)(ev);
      const mine = [ev.id, `${ev.id}-tool-toolu_01`, `${ev.id}-orch-codex`, `${ev.id}#codex-orch-codex`];
      const theirs = ["99999999-2222-3333-4444-555555555555",
        "99999999-2222-3333-4444-555555555555-tool-toolu_02",
        "11111111-2222-3333-4444-55555555555", // 접두사만 겹치는 짧은 id
        "prefix-" + ev.id];
      const badMine = mine.filter((id) => ownsTurn(id) !== true);
      const badTheirs = theirs.filter((id) => ownsTurn(id) !== false);
      ok = badMine.length === 0 && badTheirs.length === 0;
      detail = `내 턴인데 false: [${badMine}] / 남의 턴인데 true: [${badTheirs}]`;
    } catch (e) {
      detail = String(e);
    }
  }
  check("F⑦ (런타임) ownsTurn 이 내 턴 4종 채택 / 남의 턴 4종 거부", ok, detail);
}

await runtimeStampTest();

// 0.7.29 — "결과: N/N 통과" 형식으로 낸다. release-gate.mjs 는 이 형식일 때만 건수를
// 로그에 찍는다(아니면 "통과"로만 접힘). 0.7.28 CI 로그에선 A그룹이 실제로 돌았는지
// 숫자로 확인할 수 없었다 → 이제 SKIP(23/23)과 런타임 실측(29/29)이 로그에서 구분된다.
console.log(`\n결과: ${pass}/${pass + fail} 통과${skipped ? ` (${skipped}건 SKIP — 환경 의존)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
