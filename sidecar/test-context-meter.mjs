// 컨텍스트 미터 회귀 테스트 — Phase 12 Context Meter v2.
//
// 배경:
//   "콘텍스트 10% 에서 시작 + 100턴 진행해도 20% 안 올라감" 사고. 원인:
//     (1) sidecar 의 result.usage 가 한 turn 의 모든 model call (sub-agent / iterative tool)
//         을 누적 합산해서 1M~4M 까지 부풀음 → 화면에선 estimateConvTokens (slice(-20) 길이)
//         로 fallback 했으나, SDK 내부 누적 컨텍스트는 어차피 못 봄.
//     (2) 분모가 모델 무시하고 200K 고정 — Opus 5.7 1M ctx 가 실제론 5배 여유.
//
//   해결: sidecar 가 SSE message_start 의 usage 를 turn 동안 캡처해 (input + cache_creation
//   + cache_read) 의 최댓값을 done 이벤트의 별도 필드(maxTurnUsage)로 emit. 클라이언트는
//   분모를 모델별로 (Claude default = 1M, 그 외 = 200K) 동적 적용.
//
// 검증 대상 (sidecar/src/index.ts 의 stream_event handler 와 동기화):
//   - 단일 model call: maxTurn = 그 한 번의 (input + cc + cr)
//   - sub-agent 합산 시나리오: result.usage 는 누적 → maxTurn 은 단일 최댓값 (윈도우 점유율 정확)
//   - message_start 없는 turn (REST 등): maxTurn = 0 → 클라이언트가 estimate 로 fallback
//   - 모델별 분모: claude default → 1M, 그 외 → 200K
//   - 임계치(90%) 트리거 동작
//
// 미러 함수: simulateTurn(events) — sidecar 의 maxTurn 추적 로직을 외부에서 시뮬레이션.

// ─── 미러: stream_event 처리 + result 종합 (sidecar/src/index.ts 와 동기화) ─────
function simulateTurn(streamEvents, resultUsage = null) {
  let maxTurnInputTokens = 0;
  let maxTurnCacheCreation = 0;
  let maxTurnCacheRead = 0;
  let maxTurnContextTokens = 0;

  for (const ev of streamEvents) {
    if (ev?.type === "message_start") {
      const u = ev.message?.usage;
      if (u) {
        const inputT = u.input_tokens ?? 0;
        const cc = u.cache_creation_input_tokens ?? 0;
        const cr = u.cache_read_input_tokens ?? 0;
        const ctx = inputT + cc + cr;
        if (ctx > maxTurnContextTokens) {
          maxTurnInputTokens = inputT;
          maxTurnCacheCreation = cc;
          maxTurnCacheRead = cr;
          maxTurnContextTokens = ctx;
        }
      }
    }
  }

  const ru = resultUsage ?? {};
  const rawCtx =
    (ru.input_tokens ?? 0) +
    (ru.cache_creation_input_tokens ?? 0) +
    (ru.cache_read_input_tokens ?? 0);

  return {
    maxTurnUsage:
      maxTurnContextTokens > 0
        ? {
            input_tokens: maxTurnInputTokens,
            cache_creation_input_tokens: maxTurnCacheCreation,
            cache_read_input_tokens: maxTurnCacheRead,
            total_context_tokens: maxTurnContextTokens,
          }
        : null,
    rawCtx,
  };
}

// ─── 미러: 클라이언트의 분모 결정 (App.tsx currentModelMaxTokens 와 동기화) ──
function denominatorFor(provider, modelId) {
  if (provider === "claude" && (!modelId || modelId === "default")) return 1_000_000;
  const id = (modelId || "").toLowerCase();
  if (id.includes("1m")) return 1_000_000;
  return 200_000;
}

// ─── 미러: 표시 컨텍스트 결정 (MetricsPanel 우선순위) ────────────────────
function displayContextFor({ measured, estimated, raw }) {
  if (measured > 0) return { value: measured, source: "measured" };
  if (estimated > 0) return { value: estimated, source: "estimated" };
  return { value: raw, source: "raw" };
}

// ─── 시나리오 빌더 ───────────────────────────────────────
const messageStart = (input, cc, cr, output = 1) => ({
  type: "message_start",
  message: {
    usage: {
      input_tokens: input,
      cache_creation_input_tokens: cc,
      cache_read_input_tokens: cr,
      output_tokens: output,
    },
  },
});

// ─── 케이스 ──────────────────────────────────────────────
const cases = [
  {
    name: "[1] 단일 model call — maxTurn 이 그 한 번의 합과 일치",
    run: () => {
      // 단일 호출: input=10K, cc=5K, cr=80K → ctx=95K
      const result = simulateTurn(
        [messageStart(10_000, 5_000, 80_000)],
        { input_tokens: 10_000, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 80_000 }
      );
      const errors = [];
      if (!result.maxTurnUsage) errors.push("maxTurnUsage 가 null");
      else {
        if (result.maxTurnUsage.total_context_tokens !== 95_000)
          errors.push(`total ${result.maxTurnUsage.total_context_tokens} != 95000`);
        if (result.rawCtx !== 95_000) errors.push(`rawCtx ${result.rawCtx} != 95000`);
      }
      return errors;
    },
  },

  {
    name: "[2] sub-agent 합산 시나리오 — result 누적 부풀음, maxTurn 은 단일 최댓값",
    run: () => {
      // 한 turn 안에 5번 model call. 각 호출의 컨텍스트는 80K-120K 사이지만 result 는 합산.
      const events = [
        messageStart(10_000, 5_000, 80_000),  // ctx=95K  (turn 1)
        messageStart(8_000, 1_000, 110_000),  // ctx=119K (turn 2 — 최댓값)
        messageStart(6_000, 0, 100_000),      // ctx=106K
        messageStart(5_000, 0, 90_000),       // ctx=95K
        messageStart(4_000, 0, 85_000),       // ctx=89K
      ];
      // result.usage 는 5번의 합산 (cache_read 를 다섯 번 누적)
      const totalRaw = {
        input_tokens: 33_000,
        cache_creation_input_tokens: 6_000,
        cache_read_input_tokens: 465_000, // 80+110+100+90+85
      };
      const result = simulateTurn(events, totalRaw);
      const errors = [];
      if (!result.maxTurnUsage) errors.push("maxTurnUsage null");
      else {
        if (result.maxTurnUsage.total_context_tokens !== 119_000)
          errors.push(`maxTurn ${result.maxTurnUsage.total_context_tokens} != 119000 (단일 최댓값)`);
        if (result.rawCtx !== 504_000)
          errors.push(`rawCtx ${result.rawCtx} != 504000 (5번 합산)`);
        // 핵심: rawCtx 가 maxTurn 의 4배 이상 부풀어야 부풀음 시나리오로 검증됨
        if (result.rawCtx / result.maxTurnUsage.total_context_tokens < 4)
          errors.push(`rawCtx/maxTurn 비율 ${result.rawCtx / result.maxTurnUsage.total_context_tokens} < 4 (부풀음 시나리오 무효)`);
      }
      return errors;
    },
  },

  {
    name: "[3] message_start 없는 turn — maxTurnUsage = null (estimate fallback 보장)",
    run: () => {
      // REST 경로 / sub-agent 없이 캐시만 쓴 turn 을 시뮬레이션 — message_start 안 옴.
      const result = simulateTurn([], { input_tokens: 1000, cache_read_input_tokens: 50_000 });
      const errors = [];
      if (result.maxTurnUsage !== null)
        errors.push("message_start 없으면 maxTurnUsage 는 null 이어야 (클라이언트 fallback)");
      if (result.rawCtx !== 51_000) errors.push(`rawCtx ${result.rawCtx} != 51000`);
      return errors;
    },
  },

  {
    name: "[4] usage 없는 message_start — 무시되어야 함",
    run: () => {
      const events = [
        { type: "message_start", message: {} },               // usage 없음
        { type: "message_start", message: { usage: null } },  // usage null
        messageStart(5_000, 0, 50_000),                       // 정상 → 55K
      ];
      const result = simulateTurn(events);
      const errors = [];
      if (!result.maxTurnUsage) errors.push("정상 message_start 가 있는데 null");
      else if (result.maxTurnUsage.total_context_tokens !== 55_000)
        errors.push(`total ${result.maxTurnUsage.total_context_tokens} != 55000`);
      return errors;
    },
  },

  {
    name: "[5] 모델별 분모 — Claude default = 1M",
    run: () => {
      const errors = [];
      const d1 = denominatorFor("claude", "default");
      if (d1 !== 1_000_000) errors.push(`claude/default → ${d1}, 기대 1M`);
      const d2 = denominatorFor("claude", "");
      if (d2 !== 1_000_000) errors.push(`claude/(empty) → ${d2}, 기대 1M`);
      const d3 = denominatorFor("claude", null);
      if (d3 !== 1_000_000) errors.push(`claude/null → ${d3}, 기대 1M`);
      return errors;
    },
  },

  {
    name: "[6] 모델별 분모 — 그 외 모델 = 200K",
    run: () => {
      const errors = [];
      const d1 = denominatorFor("openai", "gpt-4o-mini");
      if (d1 !== 200_000) errors.push(`openai/gpt-4o-mini → ${d1}, 기대 200K`);
      const d2 = denominatorFor("anthropic", "claude-sonnet-4-5");
      if (d2 !== 200_000) errors.push(`anthropic/sonnet-4.5 → ${d2}, 기대 200K`);
      const d3 = denominatorFor("gemini", "gemini-2.0-flash");
      if (d3 !== 200_000) errors.push(`gemini/2.0-flash → ${d3}, 기대 200K`);
      // 모델 ID 에 1m 시그널이 있으면 1M
      const d4 = denominatorFor("anthropic", "claude-sonnet-4-5-1m");
      if (d4 !== 1_000_000) errors.push(`anthropic/...-1m → ${d4}, 기대 1M (모델 ID 시그널)`);
      return errors;
    },
  },

  {
    name: "[7] 표시 우선순위 — measured > estimated > raw",
    run: () => {
      const errors = [];
      const a = displayContextFor({ measured: 100_000, estimated: 50_000, raw: 200_000 });
      if (a.source !== "measured" || a.value !== 100_000)
        errors.push(`measured 우선 안 됨: ${JSON.stringify(a)}`);
      const b = displayContextFor({ measured: 0, estimated: 50_000, raw: 200_000 });
      if (b.source !== "estimated" || b.value !== 50_000)
        errors.push(`estimated fallback 안 됨: ${JSON.stringify(b)}`);
      const c = displayContextFor({ measured: 0, estimated: 0, raw: 200_000 });
      if (c.source !== "raw" || c.value !== 200_000)
        errors.push(`raw 최종 fallback 안 됨: ${JSON.stringify(c)}`);
      return errors;
    },
  },

  {
    name: "[8] 임계치 트리거 — maxTurn 이 분모의 90% 이상이면 발화",
    run: () => {
      const errors = [];
      const denom = denominatorFor("claude", "default"); // 1M
      const threshold = 0.9;
      // 케이스 A: 89% 도달 — 트리거 X
      const ctxA = 890_000;
      if (ctxA / denom >= threshold) errors.push(`890K/1M (${ctxA / denom}) 이 89% 인데 트리거됨`);
      // 케이스 B: 91% 도달 — 트리거 O
      const ctxB = 910_000;
      if (ctxB / denom < threshold) errors.push(`910K/1M (${ctxB / denom}) 이 91% 인데 트리거 안 됨`);
      // 케이스 C: 200K 분모에서 180K — 90% 트리거 O
      const denomC = denominatorFor("openai", "gpt-4o");
      if (180_000 / denomC < threshold) errors.push(`180K/200K 이 90% 인데 트리거 안 됨`);
      return errors;
    },
  },

  {
    name: "[9] 사고 시나리오 재현 — 100턴 진행해도 20% 안 올라감 회귀 방지",
    run: () => {
      // 평소 turn: input 5K + cc 0 + cr 누적 (예: 100K). 분모 1M → 10.5%.
      // 100턴이 진행되면 SDK 누적으로 cr 이 점점 커짐 → 가정: 800K 까지 누적.
      // maxTurn 이 정확히 그 시점의 (input + cc + cr) 을 잡아야 80% 로 표시.
      const result = simulateTurn(
        [messageStart(5_000, 0, 800_000)], // 100턴 후 한 model call 의 컨텍스트 = 805K
        { input_tokens: 5_000, cache_read_input_tokens: 800_000 }
      );
      const errors = [];
      if (!result.maxTurnUsage) {
        errors.push("100턴 누적 시 maxTurnUsage null — 사고 회귀 가능");
      } else {
        const denom = denominatorFor("claude", "default"); // 1M
        const pct = result.maxTurnUsage.total_context_tokens / denom;
        // 80% 이상 잡혀야 함 (이전엔 estimate 가 ~10% 만 잡혀서 사고 났음)
        if (pct < 0.7)
          errors.push(`100턴 누적 시 표시 ${(pct * 100).toFixed(1)}% < 70% — 사고 재발`);
      }
      return errors;
    },
  },

  {
    name: "[10] 정책 sanity — 분모는 양수, 임계치는 0~1 범위",
    run: () => {
      const errors = [];
      const CONTEXT_THRESHOLD = 0.9;
      if (CONTEXT_THRESHOLD <= 0 || CONTEXT_THRESHOLD >= 1)
        errors.push(`THRESHOLD ${CONTEXT_THRESHOLD} 가 (0,1) 밖`);
      if (denominatorFor("claude", "default") <= 0) errors.push("claude default 분모가 0 이하");
      if (denominatorFor("openai", "anything") <= 0) errors.push("openai 분모가 0 이하");
      return errors;
    },
  },
];

// ─── 실행 ────────────────────────────────────────────────
let pass = 0,
  fail = 0;

for (const c of cases) {
  let errors;
  try {
    errors = c.run();
  } catch (e) {
    errors = [`예외: ${e instanceof Error ? e.stack || e.message : String(e)}`];
  }
  if (errors.length === 0) {
    pass++;
    console.log(`✅ ${c.name}`);
  } else {
    fail++;
    console.log(`❌ ${c.name}`);
    for (const e of errors) console.log(`     - ${e}`);
  }
}

// ─── 2026-05-06 보강: --include-partial-messages 옵션이 args 에 박혔는지 정적 검사 ──
// Claude CLI 2.1.122 기준 이 옵션 없으면 stream-json 모드에서도 message_start 가 안 옴 →
// maxTurnUsage 가 항상 0 으로 박혀서 컨텍스트 % 가 100턴 가도 안 올라가는 회귀.
import { readFileSync as _readFileSync } from "node:fs";
import * as _path from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";
const _here = _path.dirname(_fileURLToPath(import.meta.url));
const _sidecarSrc = _readFileSync(_path.join(_here, "src", "index.ts"), "utf-8");
const _distPath = _path.join(_here, "dist", "index.js");
function _check(label, src, pattern) {
  if (pattern.test(src)) {
    console.log(`✅ ${label}`);
    pass++;
  } else {
    console.log(`❌ ${label}`);
    fail++;
  }
}
_check("sidecar/src/index.ts 에 --include-partial-messages 옵션 박힘",
       _sidecarSrc, /--include-partial-messages/);
try {
  const _distSrc = _readFileSync(_distPath, "utf-8");
  _check("dist/index.js 에도 --include-partial-messages 박힘 (build sync)",
         _distSrc, /--include-partial-messages/);
} catch {
  console.log(`⚠️  dist/index.js 없음 — npm run build 필요 (skip)`);
}

console.log("──────────────────────────────────");
console.log(`결과: ${pass} 통과 / ${fail} 실패 (총 ${cases.length + 2})`);
console.log("정책: maxTurnUsage = max over message_starts of (input + cc + cr)");
console.log("       분모: claude/default → 1M, 기타 → 200K (모델 ID '1m' 시그널은 1M)");
console.log("       Claude CLI 인자: --include-partial-messages 필수 (stream_event 활성화)");
process.exit(fail === 0 ? 0 : 1);
