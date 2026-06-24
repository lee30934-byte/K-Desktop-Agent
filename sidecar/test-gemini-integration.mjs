// Phase 134 — Gemini CLI 통합 + Gemini REST 현행화 회귀 테스트.
// Phase 135 — 구독 OAuth 내장 로그인 (KDA 가 직접 OAuth 플로우 수행 + creds 캐시) 검사 추가.
//
// 목적:
//   1. sidecar/src/index.ts 의 Provider 타입에 "gemini-cli" 가 박혔는지
//   2. handleViaGeminiCLI 함수와 라우터 분기가 박혔는지
//   3. GEMINI_CLI 해석 헬퍼와 stream-json 이벤트 핸들러가 박혔는지
//   4. spawn 인자 (-o stream-json / --yolo / --skip-trust) + GEMINI_API_KEY env 주입
//   5. ensureGeminiCliMcpRegistered (settings.json MCP best-effort 등록)
//   6. v1 stateless 정책 — resume 안 씀 (codex orphan-thread pitfall 구조적 회피)
//   7. Settings.tsx 의 gemini-cli 카드 (noKeyRequired) + Gemini REST 카드 현행화
//      (gemini-2.5 세대 + "MCP 도구 미지원" 모순 문구 제거)
//   8. App.tsx 의 gemini-cli → gemini REST 키 폴백 배선 (3개 site)
//   9. stream-json result.stats → usage 매핑 sanity
//
// 왜 별도 테스트:
//   - 엔진 분기는 서로 독립이라 회귀 시 한쪽만 깨질 수 있음 (codex 테스트와 동일 논리).
//   - 키 폴백 (gemini-cli → keys["gemini"]) 은 3 군데 복제 코드 — 한 곳만 빠져도
//     "Resume 만 인증 실패" 같은 부분 회귀가 silent 하게 발생.

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
const appTsx = path.join(projectRoot, "src", "App.tsx");
const typesTs = path.join(projectRoot, "src", "types.ts");

for (const [label, p] of [
  ["sidecar/src/index.ts", sidecarSrc],
  ["src/components/Settings.tsx", settingsTsx],
  ["src/App.tsx", appTsx],
  ["src/types.ts", typesTs],
]) {
  if (existsSync(p)) ok(`존재: ${label}`);
  else ng(`누락: ${label}`, p);
}

// ─── 2. types.ts ─ ProviderId 에 gemini-cli ───
{
  const text = readFileSync(typesTs, "utf-8");
  if (/ProviderId\s*=[^;]*"gemini-cli"/.test(text)) {
    ok('types.ts ProviderId 에 "gemini-cli" 박힘');
  } else {
    ng('types.ts ProviderId 에 "gemini-cli" 누락');
  }
}

// ─── 3. sidecar/src/index.ts ─ 라우터 + 핸들러 ───
{
  const text = readFileSync(sidecarSrc, "utf-8");

  if (/type Provider\s*=[^;]*"gemini-cli"/.test(text)) {
    ok('sidecar Provider 타입에 "gemini-cli" 박힘');
  } else {
    ng('sidecar Provider 타입에 "gemini-cli" 누락');
  }

  if (/provider\s*===\s*"gemini-cli"\s*\)\s*{[^}]*handleViaGeminiCLI/.test(text)) {
    ok("sidecar handleUserMessage 라우터에 gemini-cli 분기 박힘");
  } else {
    ng("sidecar 라우터에 gemini-cli 분기 누락");
  }

  if (/async function handleViaGeminiCLI\s*\(/.test(text)) {
    ok("handleViaGeminiCLI 함수 정의 박힘");
  } else {
    ng("handleViaGeminiCLI 함수 누락");
  }

  if (/const GEMINI_CLI\s*=/.test(text) && /resolveGeminiCli/.test(text)) {
    ok("GEMINI_CLI 해석 헬퍼 박힘");
  } else {
    ng("GEMINI_CLI 해석 헬퍼 누락");
  }

  // stream-json 이벤트 핸들러 — handleViaGeminiCLI 본문만 잘라서 검사
  const handlerStart = text.indexOf("async function handleViaGeminiCLI");
  const handlerEnd = text.indexOf("// ─── REST API 경로", handlerStart);
  const handlerBody = handlerStart >= 0 ? text.slice(handlerStart, handlerEnd > 0 ? handlerEnd : undefined) : "";
  for (const evType of ["init", "message", "tool_use", "tool_result", "result"]) {
    if (handlerBody.includes(`case "${evType}"`)) {
      ok(`Gemini stream-json 이벤트 핸들러 박힘: ${evType}`);
    } else {
      ng(`Gemini stream-json 이벤트 핸들러 누락: ${evType}`);
    }
  }

  // spawn 인자
  if (/"-o",\s*"stream-json",\s*"--yolo",\s*"--skip-trust"/.test(text)) {
    ok("gemini -o stream-json --yolo --skip-trust 인자 박힘");
  } else {
    ng("gemini spawn 핵심 인자 누락");
  }

  // GEMINI_API_KEY env 주입 (Settings 의 Gemini REST 키 재사용)
  if (/GEMINI_API_KEY:\s*msg\.api_key/.test(text)) {
    ok("GEMINI_API_KEY env 주입 (msg.api_key 재사용) 박힘");
  } else {
    ng("GEMINI_API_KEY env 주입 누락");
  }

  // MCP best-effort 등록
  if (/function ensureGeminiCliMcpRegistered/.test(text) && /\.gemini[\\/"', ]+settings\.json|"\.gemini"/.test(text)) {
    ok("ensureGeminiCliMcpRegistered (~/.gemini/settings.json) 박힘");
  } else {
    ng("ensureGeminiCliMcpRegistered 누락");
  }

  // v1 stateless — handleViaGeminiCLI 안에서 resume 플래그를 쓰면 안 됨
  if (!/--resume/.test(handlerBody) && !/"resume"/.test(handlerBody)) {
    ok("v1 stateless 정책 유지 (gemini-cli 핸들러에 resume 없음 — codex orphan pitfall 회피)");
  } else {
    ng("gemini-cli 핸들러에 resume 사용 흔적 — v1 stateless 정책 위반 (의도적 v2 면 테스트 갱신)");
  }

  // 항상 bootstrap history 재주입
  if (/compactHistoryForCodexBootstrap(Stats)?\(msg\.history\)/.test(handlerBody)) {
    ok("gemini-cli 매 turn history bootstrap 재주입 박힘");
  } else {
    ng("gemini-cli history bootstrap 누락");
  }

  // 인증 실패 (exit 41) 친절 안내
  if (/code === 41/.test(handlerBody) && /Auth method/i.test(handlerBody)) {
    ok("exit 41 인증 실패 → 친절 안내 메시지 박힘");
  } else {
    ng("exit 41 인증 안내 누락");
  }

  // defaultModelFor 분기
  if (/case "gemini-cli":\s*return\s*"default"/.test(text)) {
    ok('defaultModelFor 에 gemini-cli → "default" 박힘');
  } else {
    ng("defaultModelFor 에 gemini-cli 분기 누락");
  }
  if (/case "gemini":\s*return\s*"gemini-2\.5-flash"/.test(text)) {
    ok('defaultModelFor gemini REST 현행화 (gemini-2.5-flash) 박힘');
  } else {
    ng("defaultModelFor gemini REST 가 구세대 모델 (gemini-2.0 등) — 현행화 누락");
  }

  // idle 워치독 + keepalive (Codex 경로와 동일 구조)
  if (/emitTurnHeartbeat\(msg\.id,\s*"gemini-cli"/.test(handlerBody) && /idleWatchdog/.test(handlerBody)) {
    ok("gemini-cli idle 워치독 + turn keepalive 박힘");
  } else {
    ng("gemini-cli 워치독/keepalive 누락");
  }
}

// ─── 4. Settings.tsx ─ 카드 ───
{
  const text = readFileSync(settingsTsx, "utf-8");

  // gemini-cli 카드 (noKeyRequired)
  const cliCardIdx = text.indexOf('id: "gemini-cli"');
  if (cliCardIdx >= 0 && /noKeyRequired:\s*true/.test(text.slice(cliCardIdx, cliCardIdx + 1500))) {
    ok("Settings.tsx API_PROVIDERS 에 gemini-cli 카드 (noKeyRequired) 박힘");
  } else {
    ng("Settings.tsx gemini-cli 카드 누락 또는 noKeyRequired 미설정");
  }

  // Gemini REST 카드 현행화 — gemini 카드 구간만 잘라 검사
  const geminiCardIdx = text.indexOf('id: "gemini"');
  const geminiCardSlice = geminiCardIdx >= 0 ? text.slice(geminiCardIdx, geminiCardIdx + 1500) : "";
  if (/gemini-2\.5-flash/.test(geminiCardSlice)) {
    ok("Gemini REST 카드 모델 현행화 (gemini-2.5 세대) 박힘");
  } else {
    ng("Gemini REST 카드가 여전히 구세대 모델 목록");
  }
  if (!/gemini-1\.5/.test(geminiCardSlice) && !/gemini-2\.0-flash"/.test(geminiCardSlice)) {
    ok("Gemini REST 카드에서 구세대 모델 (1.5 / 2.0) 제거됨");
  } else {
    ng("Gemini REST 카드에 구세대 모델 잔존");
  }
  if (!/텍스트 전용 \(MCP 도구 미지원\)/.test(geminiCardSlice)) {
    ok('Gemini REST 카드의 모순 문구 ("MCP 도구 미지원") 제거됨 — 실제로는 Phase 11 G1 부터 지원');
  } else {
    ng("Gemini REST 카드에 모순 문구 잔존 (코드는 도구 지원하는데 UI 가 미지원이라 표기)");
  }
}

// ─── 5. App.tsx ─ 키 폴백 + 컨텍스트 분모 ───
{
  const text = readFileSync(appTsx, "utf-8");

  // gemini-cli → keys["gemini"] 폴백 3개 site (초기 send / buildSendSettings / Resume)
  const fallbackCount = (text.match(/provider === "gemini-cli" && !apiKey/g) ?? []).length;
  if (fallbackCount >= 3) {
    ok(`App.tsx gemini-cli → gemini REST 키 폴백 ${fallbackCount}개 site 박힘 (필요 3+)`);
  } else {
    ng(`App.tsx 키 폴백 site 부족: ${fallbackCount}개 (send/buildSendSettings/Resume 3곳 필요)`);
  }

  // 컨텍스트 분모 — gemini-cli default 모델이 200K fallback 으로 떨어지지 않게
  if (/activeProvider === "gemini-cli"/.test(text) && /Gemini CLI default/.test(text)) {
    ok("App.tsx 컨텍스트 분모에 gemini-cli default (1M) 분기 박힘");
  } else {
    ng("App.tsx gemini-cli 분모 분기 누락 — default 모델이 ⚠ 200K fallback 으로 떨어짐");
  }
}

// ─── 6. stream-json result.stats → usage 매핑 sanity ───
//
// 설치된 Gemini CLI bundle (v0.46) 에서 확인한 형식:
//   {"type":"result","status":"success","stats":{"total_tokens":5100,"input_tokens":5000,
//     "output_tokens":100,"cached":2000,"duration_ms":4200,"tool_calls":2}}
//
// sidecar 매핑 정책 (Claude 규약: input + cache_read = context):
//   net input = input_tokens - cached, cache_read = cached, total_context = input_tokens
{
  function mapGeminiStatsToUsage(stats) {
    const rawInput = Number(stats?.input_tokens ?? 0) || 0;
    const cached = Number(stats?.cached ?? 0) || 0;
    const outputTokens = Number(stats?.output_tokens ?? 0) || 0;
    const netInput = Math.max(0, rawInput - cached);
    return {
      input_tokens: netInput,
      output_tokens: outputTokens,
      cache_read_input_tokens: cached,
      total_context_tokens: rawInput,
    };
  }

  const m = mapGeminiStatsToUsage({ input_tokens: 5000, cached: 2000, output_tokens: 100 });
  if (m.total_context_tokens === 5000 && m.input_tokens === 3000 && m.cache_read_input_tokens === 2000 && m.output_tokens === 100) {
    ok("Gemini stats 매핑 sanity (input=5000, cached=2000 → total=5000, net=3000, cr=2000)");
  } else {
    ng(`Gemini stats 매핑 sanity 실패: ${JSON.stringify(m)}`);
  }

  // stats 없는 비정상 종료 — NaN 안 나오게
  const empty = mapGeminiStatsToUsage(null);
  if (empty.total_context_tokens === 0 && empty.input_tokens === 0) {
    ok("Gemini stats null 가드 (비정상 종료 시 0 처리)");
  } else {
    ng(`Gemini stats null 가드 실패: ${JSON.stringify(empty)}`);
  }
}

// ─── 7. Phase 135 — 구독 OAuth 내장 로그인 ───
//
// gemini CLI 는 login 서브커맨드가 없고 비대화형에선 OAuth 를 못 시작 (exit 41).
// → sidecar 가 CLI 의 authWithWeb 를 재현: loopback 콜백 서버 + 시스템 브라우저 +
//   토큰 교환 → ~/.gemini/oauth_creds.json (CLI 표준 캐시) 저장.
// → spawn 시 api_key 없으면 GOOGLE_GENAI_USE_GCA=true 로 구독 경로 강제.
{
  const text = readFileSync(sidecarSrc, "utf-8");
  const libRs = path.join(projectRoot, "src-tauri", "src", "lib.rs");
  const libText = existsSync(libRs) ? readFileSync(libRs, "utf-8") : "";
  const settingsText = readFileSync(settingsTsx, "utf-8");

  // sidecar — OAuth 플로우 본체
  if (/async function handleGeminiOauthLogin/.test(text)) {
    ok("sidecar handleGeminiOauthLogin (OAuth 플로우) 박힘");
  } else {
    ng("sidecar handleGeminiOauthLogin 누락");
  }
  if (/case "gemini_oauth_login":/.test(text)) {
    ok('sidecar 디스패치에 "gemini_oauth_login" 케이스 박힘');
  } else {
    ng("sidecar gemini_oauth_login 디스패치 누락");
  }
  if (/oauth_creds\.json/.test(text) && /function hasGeminiOauthCreds/.test(text)) {
    ok("CLI 표준 캐시 (~/.gemini/oauth_creds.json) 경로 + 유효성 검사 박힘");
  } else {
    ng("oauth_creds.json 경로/검사 누락");
  }
  if (/access_type:\s*"offline"/.test(text) && /prompt:\s*"consent"/.test(text)) {
    ok("OAuth URL 에 access_type=offline + prompt=consent (refresh_token 보장) 박힘");
  } else {
    ng("offline/consent 파라미터 누락 — refresh_token 미발급 위험 (1시간 후 재로그인)");
  }
  if (/\/oauth2callback/.test(text) && /127\.0\.0\.1/.test(text)) {
    ok("loopback 콜백 (127.0.0.1/oauth2callback) 박힘 — CLI authWithWeb 과 동일 패턴");
  } else {
    ng("loopback 콜백 누락");
  }
  if (/https:\/\/oauth2\.googleapis\.com\/token/.test(text)) {
    ok("토큰 교환 endpoint 박힘");
  } else {
    ng("토큰 교환 endpoint 누락");
  }
  // 시스템 브라우저 — shell 파싱 없이 (pitfall_oauth_embedded_webview + URL & 깨짐 방지)
  if (/rundll32/.test(text) && /FileProtocolHandler/.test(text)) {
    ok("시스템 기본 브라우저 오픈 (rundll32, shell 파싱 없음) 박힘");
  } else {
    ng("시스템 브라우저 오픈 경로 누락 — embedded webview 는 Google 정책에 막힘");
  }
  if (/gemini_oauth_event/.test(text)) {
    ok("gemini_oauth_event 진행 상황 emit 박힘");
  } else {
    ng("gemini_oauth_event emit 누락");
  }

  // sidecar — spawn 인증 체인
  if (/GOOGLE_GENAI_USE_GCA:\s*"true"/.test(text)) {
    ok("api_key 없을 때 GOOGLE_GENAI_USE_GCA=true 주입 (구독 OAuth 강제) 박힘");
  } else {
    ng("GOOGLE_GENAI_USE_GCA 주입 누락 — OAuth 캐시 있어도 exit 41 가능");
  }
  if (/!msg\.api_key && !oauthAvailable/.test(text) && /Google 계정으로 로그인/.test(text)) {
    ok("인증 없음 fail-fast (spawn 전 preflight) + Settings 버튼 안내 박힘");
  } else {
    ng("인증 preflight/안내 누락");
  }

  // lib.rs — Tauri 커맨드
  if (/async fn gemini_login\(/.test(libText) && /gemini_oauth_login/.test(libText)) {
    ok("lib.rs gemini_login 커맨드 (sidecar 트리거) 박힘");
  } else {
    ng("lib.rs gemini_login 커맨드 누락");
  }
  if (/async fn gemini_login_status\(/.test(libText) && /GeminiLoginStatus/.test(libText)) {
    ok("lib.rs gemini_login_status 커맨드 박힘");
  } else {
    ng("lib.rs gemini_login_status 커맨드 누락");
  }
  if (/generate_handler!\[[\s\S]*gemini_login,[\s\S]*gemini_login_status,/.test(libText)) {
    ok("generate_handler 에 gemini_login / gemini_login_status 등록됨");
  } else {
    ng("generate_handler 등록 누락 — invoke 시 command not found");
  }

  // Settings.tsx — 로그인 버튼 + 상태 poll
  if (/handleGeminiLogin/.test(settingsText) && /gemini_login_status/.test(settingsText)) {
    ok("Settings.tsx Google 로그인 버튼 핸들러 + 상태 poll 박힘");
  } else {
    ng("Settings.tsx 로그인 버튼/상태 poll 누락");
  }
  const cliBlockIdx = settingsText.indexOf('currentProvider.id === "gemini-cli"');
  if (cliBlockIdx >= 0 && /Google 계정으로 로그인/.test(settingsText.slice(cliBlockIdx, cliBlockIdx + 6000))) {
    ok("Settings.tsx gemini-cli 카드에 [Google 계정으로 로그인] 버튼 블록 박힘");
  } else {
    ng("Settings.tsx gemini-cli 로그인 버튼 블록 누락");
  }

  // exit 41 안내가 내장 로그인 버튼을 가리키는지 (구 안내: "터미널에서 gemini 실행")
  if (/Google 계정으로 로그인\] 버튼/.test(text) && !/터미널에서 `gemini` 를 한 번 실행/.test(text)) {
    ok("인증 에러 안내가 내장 로그인 버튼 기준으로 갱신됨 (터미널 수동 실행 안내 제거)");
  } else {
    ng("인증 에러 안내가 여전히 터미널 수동 로그인 기준");
  }
}

// ─── 8. dist/index.js 동기화 (release 빌드 시) ───
{
  if (existsSync(sidecarDist)) {
    const text = readFileSync(sidecarDist, "utf-8");
    if (text.includes("handleViaGeminiCLI")) {
      ok("sidecar/dist/index.js 에도 Gemini CLI 통합 박힘 (build sync)");
    } else {
      console.log("⚠ sidecar/dist/index.js 에 Gemini CLI 통합 미반영 — npm run build 필요 (현 단계 OK)");
    }
  } else {
    console.log("⚠ sidecar/dist/index.js 없음 — 첫 빌드 전 OK");
  }
}

console.log("──────────────────────────────────");
console.log(`결과: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);
console.log("정책: gemini-cli provider 분기 (v1 stateless) + REST 현행화 + 키 폴백 + stats 매핑 + 구독 OAuth 내장 로그인");
process.exit(fail === 0 ? 0 : 1);
