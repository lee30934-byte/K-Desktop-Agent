// Phase 144 (v0.7.20) — W1/W3 대화별 provider **행위** 테스트 (정적 검사 아님).
//
// 이 파일은 test-conversation-provider.mjs 가 `node --experimental-strip-types` 로 spawn 한다.
// (파일명이 test-*.mjs 가 아닌 이유: release-gate 의 회귀테스트 glob 이 이 파일을 플래그 없이
//  직접 실행해 TS import 에서 죽는 걸 막기 위함.)
//
// 핵심 원칙 (작업지시서 5절): 전역 provider 를 **대화별 값과 반대로** 세팅한 상태에서
// 통과해야 유효한 테스트다. 둘이 우연히 같으면 no-op 테스트가 된다.
import { resolveProviderSettings, providerLabel } from "../src/providerResolve.ts";

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

// localStorage 흉내 (전역 설정 역할)
function store(map) {
  return { getItem: (k) => (k in map ? map[k] : null) };
}

const KEYS = JSON.stringify({ codex: "sk-codex-XXX", gemini: "gm-XXX", openai: "sk-oai-XXX" });

console.log("W1/W3 — 대화별 provider 행위 테스트\n");

// ── ① 전역=claude, 대화=codex (정반대) → 대화가 이긴다 ────────────────────
{
  const global = store({
    kda_active_provider: "claude",
    kda_active_model: "claude-fable-5",
    kda_api_keys: KEYS,
  });
  const r = resolveProviderSettings({ provider: "codex", model: null }, global);
  check("① 전역 claude / 대화 codex → codex 로 실행", r.provider === "codex", `got ${r.provider}`);
  check("① source=conversation", r.source === "conversation", `got ${r.source}`);
  check(
    "① 전역 model(claude-fable-5) 을 codex 대화에 물려주지 않음",
    r.model === undefined,
    `got ${r.model}`,
  );
  check("① apiKey 는 확정 provider(codex) 기준", r.apiKey === "sk-codex-XXX", `got ${r.apiKey}`);
}

// ── ② 전역=codex, 대화=claude (정반대) → 대화가 이긴다 ────────────────────
{
  const global = store({
    kda_active_provider: "codex",
    kda_active_model: "gpt-5.6",
    kda_api_keys: KEYS,
  });
  const r = resolveProviderSettings({ provider: "claude", model: null }, global);
  check("② 전역 codex / 대화 claude → claude 로 실행", r.provider === "claude", `got ${r.provider}`);
  check("② claude 는 Max 구독 — apiKey 없음", r.apiKey === undefined, `got ${r.apiKey}`);
  check("② 전역 model(gpt-5.6) 미상속", r.model === undefined, `got ${r.model}`);
}

// ── ③ 미지정(NULL) 대화 = 기존 동작 100% 보존 ─────────────────────────────
{
  const global = store({
    kda_active_provider: "codex",
    kda_active_model: "gpt-5.6",
    kda_api_keys: KEYS,
  });
  const r = resolveProviderSettings({ provider: null, model: null }, global);
  check("③ pin 없음 → 전역 provider 폴백", r.provider === "codex", `got ${r.provider}`);
  check("③ pin 없음 → 전역 model 그대로", r.model === "gpt-5.6", `got ${r.model}`);
  check("③ source=global", r.source === "global", `got ${r.source}`);
  const r2 = resolveProviderSettings(null, global);
  check("③ pin 객체 자체가 null 이어도 동일", r2.provider === "codex" && r2.model === "gpt-5.6");
  const rEmpty = resolveProviderSettings({ provider: "  ", model: "" }, global);
  check("③ 공백 문자열 pin 은 미지정 취급", rEmpty.provider === "codex" && rEmpty.source === "global");
}

// ── ④ 전역 미설정 → claude (하드코딩 기본값 보존) ─────────────────────────
{
  const r = resolveProviderSettings(null, store({}));
  check("④ 전역 미설정 → claude", r.provider === "claude", `got ${r.provider}`);
  check("④ model undefined", r.model === undefined);
  check("④ apiKey undefined", r.apiKey === undefined);
}

// ── ⑤ pin provider == 전역 provider → 전역 model 상속 ─────────────────────
{
  const global = store({ kda_active_provider: "codex", kda_active_model: "gpt-5.6", kda_api_keys: KEYS });
  const r = resolveProviderSettings({ provider: "codex", model: null }, global);
  check("⑤ 같은 엔진이면 전역 model 상속", r.model === "gpt-5.6", `got ${r.model}`);
}

// ── ⑥ pin.model 이 있으면 최우선 ──────────────────────────────────────────
{
  const global = store({ kda_active_provider: "claude", kda_active_model: "claude-fable-5", kda_api_keys: KEYS });
  const r = resolveProviderSettings({ provider: "codex", model: "gpt-5.6-codex" }, global);
  check("⑥ pin.model 우선", r.model === "gpt-5.6-codex", `got ${r.model}`);
}

// ── ⑦ gemini-cli 는 gemini 키 재사용 (기존 로직 보존) ─────────────────────
{
  const global = store({ kda_active_provider: "claude", kda_api_keys: KEYS });
  const r = resolveProviderSettings({ provider: "gemini-cli", model: null }, global);
  check("⑦ gemini-cli → gemini 키 재사용", r.apiKey === "gm-XXX", `got ${r.apiKey}`);
}

// ── ⑧ 손상된 kda_api_keys JSON 이어도 turn 을 죽이지 않음 ─────────────────
{
  const global = store({ kda_active_provider: "claude", kda_api_keys: "{not json" });
  const r = resolveProviderSettings({ provider: "codex", model: null }, global);
  check("⑧ 키 JSON 파손 → provider 는 유지, apiKey 만 undefined",
    r.provider === "codex" && r.apiKey === undefined);
}

// ── ⑨ UI 라벨 — 미지정은 "전역 따름" 으로 보인다 (폴백 가시성) ────────────
{
  check("⑨ null → 전역 따름", providerLabel(null) === "전역 따름", providerLabel(null));
  check("⑨ codex → Codex", providerLabel("codex") === "Codex");
  check("⑨ gemini-cli → Gemini CLI", providerLabel("gemini-cli") === "Gemini CLI");
}

// 주의: 문구에 "결과: N/M 통과" 를 쓰면 release-gate 가 부모의 최종 집계 대신 이 줄을
// 먼저 집어간다(정규식 첫 매치). 그래서 일부러 다른 라벨을 쓴다.
console.log(`\nBEHAVIOR-SUMMARY: ${pass}/${pass + fail} assertions ok`);
process.exit(fail === 0 ? 0 : 1);
