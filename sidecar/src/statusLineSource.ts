/**
 * Phase 15.5 — Claude Code statusLine helper source.
 *
 * Claude Code 가 매 update 마다 statusLine command 를 spawn 하면서 stdin 으로 JSON 을 보냄:
 *   { model: {...}, context_window: {...}, cost: {...}, rate_limits: {
 *       five_hour:  { used_percentage: 23.5, resets_at: "2026-05-07T15:00:00Z" },
 *       seven_day:  { used_percentage: 41.2, resets_at: "2026-05-12T00:00:00Z" }
 *     } }
 *
 * SSE rate_limit_event 는 reset 시간만 주고 used% 안 줌 (Anthropic 의 의도된 분리). 사용%
 * 가 박혀 있는 곳은 statusLine JSON 뿐. 그래서 우리 helper 가:
 *   1. stdin JSON 받음
 *   2. rate_limits 부분만 추출
 *   3. atomic write to %TEMP%/kda-rate-limits.json (sidecar 가 polling)
 *   4. stdout 으로 짧은 status text 반환 (Claude Code statusline 영역에 표시 — 보너스)
 *
 * 이 string 을 sidecar 가 시작 시 ~/.kda/statusline.mjs 에 dump.
 * settings.json 에 등록되면 K 가 어느 터미널에서 claude code 쓰든 자동으로 호출됨 →
 * K-Desktop-Agent UI 가 폴링해서 매번 최신 사용량 표시.
 *
 * Self-contained — 외부 의존성 없는 순수 node ESM.
 */
export const STATUSLINE_SOURCE = `#!/usr/bin/env node
// K-Desktop-Agent statusLine helper (auto-generated, do not edit by hand).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const TARGET = join(tmpdir(), "kda-rate-limits.json");
const TMP = TARGET + ".tmp." + process.pid;

let raw = "";
try { raw = readFileSync(0, "utf-8"); } catch {}

let payload = null;
try { payload = raw ? JSON.parse(raw) : null; } catch {}

const rl = payload?.rate_limits ?? null;
if (rl) {
  try {
    mkdirSync(dirname(TMP), { recursive: true });
    const out = JSON.stringify({
      receivedAt: Date.now(),
      rate_limits: rl,
      model: payload?.model ?? null,
      version: 1,
    });
    writeFileSync(TMP, out, "utf-8");
    renameSync(TMP, TARGET);
  } catch {}
}

// stdout — Claude Code statusline 영역에 표시될 짧은 텍스트.
// K-Desktop-Agent 안 쓰는 경우에도 K의 일반 claude code 에 도움.
const fh = rl?.five_hour;
const sd = rl?.seven_day;
const parts = [];
if (typeof fh?.used_percentage === "number") parts.push("5h " + fh.used_percentage.toFixed(0) + "%");
if (typeof sd?.used_percentage === "number") parts.push("7d " + sd.used_percentage.toFixed(0) + "%");
if (parts.length === 0) {
  // statusline command 는 stdout 비면 Claude Code 가 default 표시. 짧게 나마 박자.
  process.stdout.write("kda");
} else {
  process.stdout.write(parts.join(" · "));
}
`;
