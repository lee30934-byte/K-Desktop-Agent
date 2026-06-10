// Phase 136 (v0.7.9) — Hermes 기능 엔진 동등 배선 정적 회귀 테스트.
//
// 검증 대상: GPT(Codex)/Gemini CLI/REST 경로가 Claude 경로와 동일한 헤르메스
// 구성 요소(SYSTEM_PROMPT 룰, soul.md, featureGuidance, agent-flags 도구 게이트)를
// 받는지 소스 레벨에서 확인. 실행: node test-hermes-parity.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, "src", "index.ts"), "utf-8");

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

console.log("Phase 136 — Hermes 엔진 동등 배선 회귀 테스트\n");

// ── 1. 공유 헬퍼 ─────────────────────────────────────────────────────────
console.log("[1] buildEngineSystemText 헬퍼");
check("buildEngineSystemText 함수 존재", /function buildEngineSystemText\(/.test(src));
check("SYSTEM_PROMPT + soul + folder + projectProfile + featureGuidance + gatedNotice 조립",
  /return SYSTEM_PROMPT \+ soulBlock \+ folderBlock \+ projectProfileBlock \+ featureGuidance \+ gatedNotice;/.test(src));
check("compact 모드 (Codex resume 리마인더) 존재", /opts\?\.compact/.test(src) && /KDA 룰 리마인더/.test(src));
check("게이트 도구 호출 금지 블록", /\[비활성 도구 — 호출 금지\]/.test(src));
check("flagGatedDisallowed 를 게이트 목록 소스로 사용",
  /const gated = flagGatedDisallowed\(agentFlags\);/.test(src));

// ── 2. buildPromptWithHistory 의 systemText param ──────────────────────
console.log("\n[2] buildPromptWithHistory <kda_system> 블록");
check("systemText 4번째 param", /memoryContent\?: string,\r?\n\s*systemText\?: string,/.test(src));
check("<kda_system> 블록 생성", /<kda_system>/.test(src));
check("history 없을 때도 systemBlock prepend", /return systemBlock \+ memoryBlock \+ content;/.test(src));
check("history 있을 때도 systemBlock prepend", /return systemBlock \+ memoryBlock \+ lines\.join\("\\n"\);/.test(src));

// ── 3. Codex 경로 배선 ──────────────────────────────────────────────────
console.log("\n[3] Codex 경로 (handleViaCodexCLI)");
const codexBody = src.slice(src.indexOf("async function handleViaCodexCLI"), src.indexOf("async function handleViaGeminiCLI"));
check("codexAgentFlags = loadAgentFlags()", /const codexAgentFlags = loadAgentFlags\(\);/.test(codexBody));
check("codexSystemText = buildEngineSystemText(... compact + projectProfile)",
  /buildEngineSystemText\(msg\.folderSystemPrompt, codexAgentFlags, \{\s*compact: !!effectiveAgentId,\s*projectProfile: msg\.projectProfile,\s*\}\)/.test(codexBody));
check("resume 분기에도 systemText 전달",
  /buildPromptWithHistory\(baseContent, undefined, undefined, codexSystemText\)/.test(codexBody));
check("bootstrap 분기에도 systemText 전달",
  /buildPromptWithHistory\(baseContent, codexBootstrapHistory, memory\.content, codexSystemText\)/.test(codexBody));
check("로그에 systemBytes 기록", /systemBytes=\$\{Buffer\.byteLength\(codexSystemText/.test(codexBody));

// ── 4. Gemini CLI 경로 배선 ─────────────────────────────────────────────
console.log("\n[4] Gemini CLI 경로 (handleViaGeminiCLI)");
const geminiBody = src.slice(src.indexOf("async function handleViaGeminiCLI"), src.indexOf("async function handleViaRestAPI"));
check("geminiAgentFlags = loadAgentFlags()", /const geminiAgentFlags = loadAgentFlags\(\);/.test(geminiBody));
check("geminiSystemText = buildEngineSystemText(... projectProfile)",
  /const geminiSystemText = buildEngineSystemText\(msg\.folderSystemPrompt, geminiAgentFlags, \{\s*projectProfile: msg\.projectProfile,\s*\}\);/.test(geminiBody));
check("buildPromptWithHistory 에 geminiSystemText 전달",
  /buildPromptWithHistory\(\s*baseContent,\s*bootstrapHistory,\s*memory\.content,\s*geminiSystemText,\s*\)/.test(geminiBody));
check("로그에 systemBytes 기록", /systemBytes=\$\{Buffer\.byteLength\(geminiSystemText/.test(geminiBody));

// ── 5. REST 경로 배선 ───────────────────────────────────────────────────
console.log("\n[5] REST 경로 (handleViaRestAPI)");
const restBody = src.slice(src.indexOf("async function handleViaRestAPI"));
check("restAgentFlags = loadAgentFlags()", /const restAgentFlags = loadAgentFlags\(\);/.test(restBody));
check("restSystemPrompt 에 featureGuidance + projectBlock 포함",
  /SYSTEM_PROMPT_REST \+ restSoulBlock \+ restFeatureGuidance \+ restProjectBlock \+ memory\.content/.test(restBody));
check("disallowedSet 에 flagGatedDisallowed 하드 차단",
  /new Set\(\[\s*\.\.\.permFlags\.disallowed,\s*\.\.\.flagGatedDisallowed\(restAgentFlags\),\s*\]\)/.test(restBody));

// ── 6. Claude 경로 무회귀 ───────────────────────────────────────────────
console.log("\n[6] Claude 경로 무회귀");
const claudeBody = src.slice(src.indexOf("async function handleViaClaudeCLI"), src.indexOf("async function handleViaCodexCLI"));
check("Claude 의 fullSystemPrompt 조립 유지 (+ projectProfileBlock)",
  /SYSTEM_PROMPT \+ soulBlock \+ folderInstructionBlock \+ projectProfileBlock \+ askGuidance \+ manualGuidance \+ featureGuidance/.test(claudeBody));
check("Claude 의 --disallowed-tools 게이트 유지", /--disallowed-tools/.test(claudeBody));
check("Claude 경로는 buildPromptWithHistory 에 systemText 미전달 (이중 주입 방지)",
  !/buildPromptWithHistory\([^)]*SystemText\)/.test(claudeBody));

console.log(`\n결과: ${pass}/${pass + fail} 통과`);
process.exit(fail > 0 ? 1 : 0);
