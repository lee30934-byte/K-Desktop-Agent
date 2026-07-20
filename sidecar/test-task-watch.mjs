#!/usr/bin/env node
/**
 * v0.7.17 — task-watch (장기 분리작업 완료 자동 이어가기) 회귀 테스트.
 *
 * 기능이 Rust(lib.rs) + 프론트(App.tsx) + SYSTEM_PROMPT(index.ts) 3곳에 걸쳐 있어
 * 어느 한 곳의 wiring 이 빠지면 기능이 silent 하게 죽는다. 그 wiring 불변식을
 * 실제 배포 소스에서 검증한다(사본 아님):
 *   ① Rust: task_watch_scan/clear/log 함수 정의 + invoke_handler 등록
 *   ② Rust: PID 생존검사(OpenProcess/WaitForSingleObject) + Cargo Win32_System_Threading feature
 *   ③ Rust: clear id 새니타이즈(경로탈출 차단)
 *   ④ 프론트: task_watch_scan 폴링 하트비트 + 마커삭제→주입 순서 + busy/tick gate
 *   ⑤ 프론트: done/error 양 경로에서 taskWatchTurnsRef 정리 (gate 영구 잠금 방지)
 *   ⑥ SYSTEM_PROMPT: task-watch 등록법(마커 경로/스키마) 주입 → 에이전트가 실제 사용 가능
 */

import { readFileSync, existsSync } from "node:fs";
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

const libRs = read("src-tauri/src/lib.rs");
const cargo = read("src-tauri/Cargo.toml");
const appTsx = read("src/App.tsx");
const indexTs = read("sidecar/src/index.ts");

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}`);
  }
}

// ── ① Rust 커맨드 정의 + 등록 ──────────────────────────────
check("① fn task_watch_scan 정의", /fn task_watch_scan\s*\(/.test(libRs));
check("① fn task_watch_clear 정의", /fn task_watch_clear\s*\(/.test(libRs));
check("① fn task_watch_log 정의", /fn task_watch_log\s*\(/.test(libRs));
check("① fn task_watch_claim 정의", /fn task_watch_claim\s*\(/.test(libRs));
check("① fn task_watch_ack 정의", /fn task_watch_ack\s*\(/.test(libRs));
check("① fn task_watch_release 정의", /fn task_watch_release\s*\(/.test(libRs));
// generate_handler! 목록에 3개 모두 등록됐는지 (등록 누락 시 invoke 가 런타임 실패)
const handlerIdx = libRs.indexOf("generate_handler!");
const handlerBlock = handlerIdx >= 0 ? libRs.slice(handlerIdx, handlerIdx + 4000) : "";
check("① handler 등록 task_watch_scan", /\btask_watch_scan\b/.test(handlerBlock));
check("① handler 등록 task_watch_clear", /\btask_watch_clear\b/.test(handlerBlock));
check("① handler 등록 task_watch_log", /\btask_watch_log\b/.test(handlerBlock));
check("① handler 등록 durable delivery", /\btask_watch_claim\b/.test(handlerBlock) && /\btask_watch_ack\b/.test(handlerBlock) && /\btask_watch_release\b/.test(handlerBlock));

// ── ② PID 생존검사 + feature ──────────────────────────────
check("② pid_alive 정의", /fn pid_alive\s*\(/.test(libRs));
check("② Windows OpenProcess 사용", /OpenProcess\(/.test(libRs));
check("② WaitForSingleObject 사용", /WaitForSingleObject\(/.test(libRs));
check("② Cargo Win32_System_Threading feature", /Win32_System_Threading/.test(cargo));
// file 감시 조건 + timeout 안전망
check("② watch type=file 존재검사", /"file"\s*=>[\s\S]{0,200}\.exists\(\)/.test(libRs));
check("② timeoutMs 안전망 발화", /timeoutMs[\s\S]{0,500}"timeout"/.test(libRs));

// ── ③ clear id 새니타이즈 (임의 파일 삭제 방지) ─────────────
check("③ sanitize_watch_id 정의", /fn sanitize_watch_id\s*\(/.test(libRs));
check("③ 경로구분자/상위참조 차단", /contains\('\/'\)|contains\('\\\\'\)|contains\("\.\."\)/.test(libRs));

// ── ④ 프론트 하트비트 wiring ───────────────────────────────
check("④ task_watch_scan 폴링", /invoke\("task_watch_scan"\)/.test(appTsx));
check("④ taskWatchTurnsRef 선언", /taskWatchTurnsRef\s*=\s*useRef/.test(appTsx));
check("④ tick 중첩방지 gate", /taskWatchTickBusyRef/.test(appTsx));
check("④ 주입 전 durable claim", /invoke\("task_watch_claim"/.test(appTsx));
check("④ done 뒤 ACK 삭제", /case "done"[\s\S]*?invoke\("task_watch_ack"/.test(appTsx));
check("④ 완료 응답 DB 저장 뒤 ACK", /saveMessage\(convForTurn[\s\S]{0,500}invoke\("task_watch_ack"/.test(appTsx));
check("④ error 뒤 retry release", /case "error"[\s\S]*?invoke\("task_watch_release"/.test(appTsx));
check("④ 주입 전 clear 금지", !/invoke\("task_watch_clear"[\s\S]{0,500}sendTaskWatchTurn/.test(appTsx));

// ── ⑤ done/error 양 경로 gate 정리 ─────────────────────────
// taskWatchTurnsRef.current.delete 가 최소 2회(done + error) 이상 등장해야 함.
const deleteCount = (appTsx.match(/taskWatchTurnsRef\.current\.delete/g) || []).length;
check(`⑤ taskWatchTurnsRef 정리 ≥2회 (done+error), 실제 ${deleteCount}회`, deleteCount >= 2);

// ── ⑥ SYSTEM_PROMPT 등록법 주입 ────────────────────────────
check("⑥ SYSTEM_PROMPT task-watch 섹션", /task-watch/.test(indexTs) && /\.kda\/task-watch/.test(indexTs));
check("⑥ 마커 스키마 watch/type/timeoutMs 안내", /"timeoutMs"/.test(indexTs) && /"type":"file"|"type": *"file"|type":"file"/.test(indexTs.replace(/\s+/g, "")));

// ── ⑦ conversationId 라우팅 (v0.7.18) — 완료 turn 이 원래 창으로 가는 체인 ──
// 이 체인 어느 한 고리라도 빠지면 마커 conversationId 가 비어 항상 ⏳ 폴백된다.
check("⑦ Rust send_message conversation_id 파라미터", /fn send_message\(([\s\S]*?)\)\s*->/.test(libRs) && /conversation_id:\s*Option<String>/.test(libRs));
check("⑦ Rust payload conversation_id 주입", /payload\["conversation_id"\]\s*=/.test(libRs));
check("⑦ sidecar KDA_CONVERSATION_ID env 노출", /KDA_CONVERSATION_ID:\s*\(msg as any\)\.conversation_id/.test(indexTs));
const conversationEnvCount = (indexTs.match(/KDA_CONVERSATION_ID:/g) || []).length;
check(`⑦ 모든 CLI provider conversation env 노출 ≥3 (실제 ${conversationEnvCount})`, conversationEnvCount >= 3);
check("⑦ SYSTEM_PROMPT KDA_CONVERSATION_ID 안내", /KDA_CONVERSATION_ID/.test(indexTs));
// 프론트 send 경로들이 conversationId 를 넘기는지 (최소 task-watch·일반·스케줄 = 3+)
const convIdInvokes = (appTsx.match(/conversationId:\s*convId/g) || []).length;
check(`⑦ 프론트 send_message conversationId 전달 ≥3 (실제 ${convIdInvokes})`, convIdInvokes >= 3);

console.log(`\n${pass}/${pass + fail} 통과`);
process.exit(fail > 0 ? 1 : 0);
