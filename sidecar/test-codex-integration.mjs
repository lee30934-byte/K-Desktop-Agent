// Phase 15 — Codex 통합 회귀 테스트.
//
// 목적:
//   1. sidecar/src/index.ts 의 Provider 타입에 "codex" 가 박혔는지
//   2. handleViaCodexCLI 함수와 라우터 분기가 박혔는지
//   3. CODEX_CLI 해석 헬퍼와 codex JSONL 이벤트 핸들러가 박혔는지
//   4. Settings.tsx API_PROVIDERS 에 codex 항목과 외부 webview 페이지가 박혔는지
//   5. types.ts 의 ProviderId 에 codex 가 박혔는지
//   6. Rust lib.rs 에 Phase 15 커맨드 4개 (open_external_webview, codex_login,
//      codex_login_status, codex_register_mcp) 가 invoke handler 에 등록됐는지
//   7. Codex JSONL 이벤트 형식 매핑 sanity (turn.completed.usage → maxTurnUsage)
//
// 왜 별도 테스트:
//   - Codex 와 Claude 분기는 서로 거의 독립적이라 회귀 시 한쪽만 깨질 수 있음.
//   - K 가 codex 를 채팅에 쓰지 않더라도 sidecar 가 코드상 분기를 잃으면 다음 빌드가 자동으로 망가짐.
//   - 외부 webview 와 인증은 Tauri 측 구현이 코드에 그대로 박혀있어야 동작 — 한 군데 누락 즉시 끊김.

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sidecarRoot = __dirname;
const projectRoot = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log(`✅ ${msg}`); }
function ng(msg, detail) {
  fail++;
  console.log(`❌ ${msg}`);
  if (detail) console.log(`   ${detail}`);
}

// ─── 1. 파일 존재 확인 ─────────────────────────────────────────
const sidecarSrc = path.join(sidecarRoot, "src", "index.ts");
const sidecarDist = path.join(sidecarRoot, "dist", "index.js");
const settingsTsx = path.join(projectRoot, "src", "components", "Settings.tsx");
const typesTs = path.join(projectRoot, "src", "types.ts");
const libRs = path.join(projectRoot, "src-tauri", "src", "lib.rs");

for (const [label, p] of [
  ["sidecar/src/index.ts", sidecarSrc],
  ["src/components/Settings.tsx", settingsTsx],
  ["src/types.ts", typesTs],
  ["src-tauri/src/lib.rs", libRs],
]) {
  if (existsSync(p)) ok(`존재: ${label}`);
  else ng(`누락: ${label}`, p);
}

// ─── 2. types.ts ─ ProviderId 에 codex ───
{
  const text = readFileSync(typesTs, "utf-8");
  if (/ProviderId\s*=[^;]*"codex"/.test(text)) {
    ok("types.ts ProviderId 에 \"codex\" 박힘");
  } else {
    ng("types.ts ProviderId 에 \"codex\" 누락");
  }
}

// ─── 3. sidecar/src/index.ts ─ 라우터 + 핸들러 ───
{
  const text = readFileSync(sidecarSrc, "utf-8");

  // Provider 타입에 codex
  if (/type Provider\s*=[^;]*"codex"/.test(text)) {
    ok("sidecar Provider 타입에 \"codex\" 박힘");
  } else {
    ng("sidecar Provider 타입에 \"codex\" 누락");
  }

  // 라우터 분기
  if (/provider\s*===\s*"codex"\s*\)\s*{[^}]*handleViaCodexCLI/.test(text)) {
    ok("sidecar handleUserMessage 라우터에 codex 분기 박힘");
  } else {
    ng("sidecar 라우터에 codex 분기 누락");
  }

  // 핸들러 본체
  if (/async function handleViaCodexCLI\s*\(/.test(text)) {
    ok("handleViaCodexCLI 함수 정의 박힘");
  } else {
    ng("handleViaCodexCLI 함수 누락");
  }

  // CODEX_CLI 해석
  if (/const CODEX_CLI\s*=/.test(text) && /resolveCodexCli/.test(text)) {
    ok("CODEX_CLI 해석 헬퍼 박힘");
  } else {
    ng("CODEX_CLI 해석 헬퍼 누락");
  }

  // 핵심 JSONL 이벤트 핸들러
  for (const evType of ["thread.started", "turn.started", "item.completed", "turn.completed"]) {
    if (text.includes(`"${evType}"`)) {
      ok(`Codex JSONL 이벤트 핸들러 박힘: ${evType}`);
    } else {
      ng(`Codex JSONL 이벤트 핸들러 누락: ${evType}`);
    }
  }

  // codex exec --json 인자
  if (text.includes("--json") && text.includes("--skip-git-repo-check")) {
    ok("codex exec --json --skip-git-repo-check 인자 박힘");
  } else {
    ng("codex exec 핵심 인자 누락");
  }

  // defaultModelFor 분기
  if (/case "codex":\s*return/.test(text)) {
    ok("defaultModelFor 에 codex 분기 박힘");
  } else {
    ng("defaultModelFor 에 codex 분기 누락");
  }
}

// ─── 4. Settings.tsx ─ API_PROVIDERS + 외부 webview ───
{
  const text = readFileSync(settingsTsx, "utf-8");

  // API_PROVIDERS 에 codex 카드
  if (/id:\s*"codex"/.test(text) && /noKeyRequired:\s*true/.test(text.split("id: \"codex\"")[1] ?? "")) {
    ok("Settings.tsx API_PROVIDERS 에 codex 카드 (noKeyRequired) 박힘");
  } else {
    ng("Settings.tsx codex 카드 누락 또는 noKeyRequired 미설정");
  }

  // EXTERNAL_USAGE_PAGES — Claude Max 구독자는 claude.ai/settings 가 정답
  // (console.anthropic.com 은 API 키 사용자 대시보드라 Max 구독자에겐 무관)
  if (/EXTERNAL_USAGE_PAGES/.test(text) && /claude\.ai\/settings/.test(text)) {
    ok("Settings.tsx EXTERNAL_USAGE_PAGES 박힘 (claude.ai 계정 포함)");
  } else {
    ng("Settings.tsx EXTERNAL_USAGE_PAGES 누락 또는 잘못된 Anthropic URL (Max 구독자는 claude.ai/settings)");
  }

  // codex login 핸들러
  if (/handleCodexLogin/.test(text) && /invoke\("codex_login"\)/.test(text)) {
    ok("Settings.tsx handleCodexLogin → invoke(\"codex_login\") 박힘");
  } else {
    ng("Settings.tsx handleCodexLogin 누락");
  }

  // codex MCP 등록 핸들러
  if (/handleCodexRegisterMcp/.test(text) && /invoke<string>\("codex_register_mcp"\)/.test(text)) {
    ok("Settings.tsx handleCodexRegisterMcp → invoke(\"codex_register_mcp\") 박힘");
  } else {
    ng("Settings.tsx handleCodexRegisterMcp 누락");
  }

  // 외부 webview 핸들러
  if (/openExternalUsage/.test(text) && /invoke\("open_external_webview"/.test(text)) {
    ok("Settings.tsx openExternalUsage → invoke(\"open_external_webview\") 박힘");
  } else {
    ng("Settings.tsx openExternalUsage 누락");
  }
}

// ─── 5. lib.rs ─ Phase 15 커맨드 등록 ───
{
  const text = readFileSync(libRs, "utf-8");
  for (const cmd of ["open_external_webview", "codex_login", "codex_login_status", "codex_register_mcp", "codex_fetch_usage"]) {
    // tauri::command 부착
    const fnPattern = new RegExp(`async fn ${cmd}\\b`);
    if (fnPattern.test(text)) {
      ok(`lib.rs Phase 15 command 정의: ${cmd}`);
    } else {
      ng(`lib.rs Phase 15 command 누락: ${cmd}`);
    }
    // invoke handler 등록 (generate_handler! 안)
    if (text.includes(`            ${cmd},`) || text.includes(`${cmd},\n`)) {
      ok(`lib.rs invoke handler 등록: ${cmd}`);
    } else {
      ng(`lib.rs invoke handler 등록 누락: ${cmd}`);
    }
  }
}

// ─── 6. Codex JSONL 이벤트 형식 sanity (실제 codex exec 결과 기반) ───
//
// 2026-05-06 K 환경에서 실측한 형식:
//   {"type":"thread.started","thread_id":"<uuid>"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello"}}
//   {"type":"turn.completed","usage":{"input_tokens":26642,"cached_input_tokens":8576,
//                                      "output_tokens":5,"reasoning_output_tokens":0}}
//
// sidecar 의 매핑 정책:
//   maxTurnContextTokens = u.input_tokens (전체 컨텍스트 — Codex 의 input_tokens 는
//                                          cached + new 합산값으로 보임)
//   cache_read = u.cached_input_tokens
//   input (new) = input_tokens - cached_input_tokens
{
  function mapCodexUsageToMaxTurn(u) {
    const inp = (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0);
    const cr = u.cached_input_tokens ?? 0;
    return {
      input_tokens: Math.max(0, inp),
      cache_read_input_tokens: cr,
      cache_creation_input_tokens: 0,
      total_context_tokens: u.input_tokens ?? 0,
    };
  }

  const sample = { input_tokens: 26642, cached_input_tokens: 8576, output_tokens: 5 };
  const m = mapCodexUsageToMaxTurn(sample);
  if (m.total_context_tokens === 26642 && m.cache_read_input_tokens === 8576 && m.input_tokens === 18066) {
    ok("Codex usage 매핑 sanity (input=26642, cached=8576 → total_ctx=26642, new=18066, cr=8576)");
  } else {
    ng(`Codex usage 매핑 sanity 실패: ${JSON.stringify(m)}`);
  }

  // 분모 sanity — Codex (ChatGPT) 는 200K 분모. 1M 는 Claude default.
  // sidecar 가 maxTurnUsage 만 emit; 분모 결정은 클라이언트 (App.tsx).
  // 이 테스트는 매핑 자체만 검증.
}

// ─── 6.5. Phase 15.5 — Rate Limit Dashboard 박힘 검증 ───
{
  const libRsText = readFileSync(libRs, "utf-8");
  const sidecarSrc = path.join(projectRoot, "sidecar", "src", "index.ts");
  const appTsx = path.join(projectRoot, "src", "App.tsx");
  const metricsTsx = path.join(projectRoot, "src", "components", "MetricsPanel.tsx");

  if (libRsText.includes("backend-api/codex/usage")) {
    ok("lib.rs Phase 15.5: codex usage endpoint URL 박힘");
  } else {
    ng("lib.rs Phase 15.5: codex usage endpoint URL 누락");
  }

  if (existsSync(sidecarSrc)) {
    const t = readFileSync(sidecarSrc, "utf-8");
    if (t.includes('case "rate_limit_event"') && t.includes('type: "rate_limit"')) {
      ok("sidecar Phase 15.5: rate_limit_event → frontend emit 박힘");
    } else {
      ng("sidecar Phase 15.5: rate_limit 핸들러/emit 누락");
    }
    // statusLine install + polling
    if (t.includes("installStatusLine") && t.includes("startRateLimitPolling")) {
      ok("sidecar Phase 15.5: statusLine install + polling 박힘");
    } else {
      ng("sidecar Phase 15.5: statusLine install/polling 누락");
    }
    // ccusage path (non-interactive 환경에서 정확한 데이터)
    if (
      t.includes("pollCcusageOnce") &&
      t.includes("ccusage@latest") &&
      t.includes("blocks") &&
      t.includes("weekly")
    ) {
      ok("sidecar Phase 15.5: ccusage polling (blocks --active + weekly) 박힘");
    } else {
      ng("sidecar Phase 15.5: ccusage polling 누락");
    }
    if (t.includes("STATUSLINE_SOURCE")) {
      ok("sidecar Phase 15.5: STATUSLINE_SOURCE import 박힘");
    } else {
      ng("sidecar Phase 15.5: STATUSLINE_SOURCE import 누락");
    }
  }
  // statusLineSource.ts 자체
  const slSrc = path.join(projectRoot, "sidecar", "src", "statusLineSource.ts");
  if (existsSync(slSrc)) {
    const t = readFileSync(slSrc, "utf-8");
    if (t.includes("rate_limits") && t.includes("kda-rate-limits.json") && t.includes("five_hour")) {
      ok("statusLineSource.ts Phase 15.5: helper script source 박힘");
    } else {
      ng("statusLineSource.ts Phase 15.5: helper 내용 누락");
    }
  } else {
    ng("statusLineSource.ts 파일 없음");
  }

  // typesTs 는 위에서 이미 잡혀있음 (path.join projectRoot)
  {
    const t = readFileSync(typesTs, "utf-8");
    if (t.includes("RateLimitInfo") && t.includes("RateLimitWindow")) {
      ok("types.ts Phase 15.5: RateLimitInfo + RateLimitWindow 정의 박힘");
    } else {
      ng("types.ts Phase 15.5: 타입 누락");
    }
  }

  if (existsSync(appTsx)) {
    const t = readFileSync(appTsx, "utf-8");
    if (t.includes("normalizeRateLimit") && t.includes("codex_fetch_usage")) {
      ok("App.tsx Phase 15.5: normalize + Codex polling 박힘");
    } else {
      ng("App.tsx Phase 15.5: normalize/polling 누락");
    }
  }

  if (existsSync(metricsTsx)) {
    const t = readFileSync(metricsTsx, "utf-8");
    if (t.includes("RateLimitCard") && t.includes("formatRemaining")) {
      ok("MetricsPanel Phase 15.5: RateLimitCard UI 박힘");
    } else {
      ng("MetricsPanel Phase 15.5: 카드 UI 누락");
    }
  }
}

// ─── 7. dist/index.js 동기화 (release 빌드 시) ───
{
  if (existsSync(sidecarDist)) {
    const text = readFileSync(sidecarDist, "utf-8");
    if (text.includes("handleViaCodexCLI") || text.includes("codex exec")) {
      ok("sidecar/dist/index.js 에도 Codex 통합 박힘 (build sync)");
    } else {
      // dist 가 오래된 거라 codex 가 없는 경우 — 빌드 안 한 상태. 경고로만.
      console.log("⚠ sidecar/dist/index.js 에 Codex 통합 미반영 — npm run build 필요 (현 단계 OK)");
    }
  } else {
    console.log("⚠ sidecar/dist/index.js 없음 — 첫 빌드 전 OK");
  }
}

console.log("──────────────────────────────────");
console.log(`결과: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);
console.log("정책: codex provider 분기 + 외부 webview + Codex login/MCP 등록 + JSONL usage 매핑");
process.exit(fail === 0 ? 0 : 1);
