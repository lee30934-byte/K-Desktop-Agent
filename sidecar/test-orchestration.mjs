// Phase 137 (v0.7.9) — 멀티 에이전트 오케스트레이션 v1 정적 회귀 테스트.
// 실행: node test-orchestration.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, "src", "index.ts"), "utf-8");
const rust = readFileSync(path.join(__dirname, "..", "src-tauri", "src", "lib.rs"), "utf-8");
const appTsx = readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf-8");
const settingsTsx = readFileSync(path.join(__dirname, "..", "src", "components", "Settings.tsx"), "utf-8");
const typesTs = readFileSync(path.join(__dirname, "..", "src", "types.ts"), "utf-8");

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

console.log("Phase 137 — 멀티 에이전트 오케스트레이션 v1 회귀 테스트\n");

// ── 1. sidecar 코어 ──────────────────────────────────────────────────────
console.log("[1] sidecar — fan-out / fan-in 코어");
check("handleOrchestrateMessage 존재", /async function handleOrchestrateMessage\(/.test(src));
check("orchestrate_message 디스패치 case", /case "orchestrate_message":/.test(src));
check("엔진 화이트리스트 (claude/codex/gemini-cli)",
  /ORCH_VALID_ENGINES[\s\S]{0,120}new Set\(\["claude", "codex", "gemini-cli"\]\)/.test(src));
check("2개 미만 → 일반 턴 강등", /engines\.length < 2/.test(src) && /일반 턴 강등|→ 일반 턴/.test(src));
check("메인 엔진 claude 우선", /engines\.includes\("claude" as Provider\)/.test(src));
check("sub-turn id = `{id}#{engine}`", /const subId = `\$\{raw\.id\}#\$\{engine\}`;/.test(src));
check("sub-turn resume 금지 (agent_id 제거)", /agent_id: undefined,\s*\r?\n\s*_codexResumeRetried: undefined,/.test(src));
check("sub-turn 타임아웃 + tree-kill", /ORCH_SUBTURN_TIMEOUT_MS/.test(src) && /treeKill\(proc\.pid, "SIGKILL"/.test(src));
check("partial fan-in (1개 이상 성공 시 종합)", /okResults\.length === 0/.test(src));
check("종합 프롬프트 빌더", /function buildOrchSynthesisPrompt\(/.test(src) && /엔진별 의견 요약/.test(src));
check("엔진별 답변 길이 캡", /ORCH_ANSWER_MAX_CHARS/.test(src));
check("sub-turn 도구 잠금 (프롬프트 레벨)", /function wrapOrchSubTurnContent\(/.test(src) && /도구를 호출하지 말고 텍스트로만/.test(src));

// ── 2. emit 인터셉트 ─────────────────────────────────────────────────────
console.log("\n[2] sidecar — emit 인터셉트 (frontend 충돌 차단)");
check("rawEmit / emit 분리", /function rawEmit\(/.test(src) && /function emit\(/.test(src));
check("collector Map 이 emit 보다 먼저 선언 (TDZ 회피)",
  src.indexOf("const orchestrationCollectors = new Map") < src.indexOf("function rawEmit("));
check("assistant_delta → orchestrate_delta 재태깅",
  /type: "orchestrate_delta",\s*\r?\n\s*id: col\.mainId,/.test(src));
check("done → collector resolve (frontend 미전달)", /case "done": \{\s*\r?\n\s*col\.resolve\(/.test(src));
check("sub-turn 의 기타 이벤트 swallow", /default:\s*\r?\n\s*return; \/\/ sub-turn/.test(src));
check("orchestrate_status emit (started/done/error/fanout/synthesis)",
  /phase: "started"/.test(src) && /phase: "fanout"/.test(src) && /phase: "synthesis"/.test(src));

// ── 3. interrupt 연동 ────────────────────────────────────────────────────
console.log("\n[3] sidecar — interrupt 연동");
check("interrupt 시 sub-turn tree-kill + cancelled 마킹",
  /col\.mainId !== msg\.id\) continue;/.test(src) && /cancelledOrchestrations\.add\(msg\.id\);/.test(src));
check("cancelled 면 종합 skip", /cancelledOrchestrations\.delete\(raw\.id\)/.test(src));

// ── 4. Rust 브리지 ───────────────────────────────────────────────────────
console.log("\n[4] Rust — send_message 확장");
check("orchestrate_engines param", /orchestrate_engines: Option<Vec<String>>/.test(rust));
check("engine_api_keys param", /engine_api_keys: Option<serde_json::Value>/.test(rust));
check("화이트리스트 검증 + orchestrate_message 전환",
  /e == "claude" \|\| e == "codex" \|\| e == "gemini-cli"/.test(rust) &&
  /"orchestrate_message"/.test(rust));
check("2개 미만이면 user_message 유지", /if orch\.len\(\) >= 2 \{ "orchestrate_message" \} else \{ "user_message" \}/.test(rust));

// ── 5. Frontend ──────────────────────────────────────────────────────────
console.log("\n[5] Frontend — 이벤트 + opt-in UI");
check("types.ts 에 orchestrate_delta/status 이벤트",
  /type: "orchestrate_delta"; id: string; engine: string; text: string/.test(typesTs) &&
  /type: "orchestrate_status";/.test(typesTs));
check("App.tsx orchestrate_delta 케이스 (엔진별 카드)",
  /case "orchestrate_delta": \{/.test(appTsx) && /-orch-\$\{ev\.engine\}/.test(appTsx));
check("App.tsx orchestrate_status 케이스", /case "orchestrate_status": \{/.test(appTsx));
check("App.tsx send 시 opt-in 읽기 (kda_orch_enabled + 엔진 2개 이상)",
  /kda_orch_enabled/.test(appTsx) && /valid\.length >= 2/.test(appTsx));
check("App.tsx invoke 에 orchestrateEngines/engineApiKeys 전달",
  /orchestrateEngines,\s*\r?\n\s*engineApiKeys,/.test(appTsx));
check("Settings.tsx 오케스트레이션 토글 + 엔진 선택 UI",
  /멀티 엔진 오케스트레이션/.test(settingsTsx) && /toggleOrchEngine/.test(settingsTsx));
check("Settings.tsx 기본 OFF (localStorage 미존재 시 false)",
  /localStorage\.getItem\("kda_orch_enabled"\) === "1"/.test(settingsTsx));

console.log(`\n결과: ${pass}/${pass + fail} 통과`);
process.exit(fail > 0 ? 1 : 0);
