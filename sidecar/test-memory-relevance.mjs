/**
 * Phase 149 게이트 — 메모리 관련도 회상 회귀 테스트.
 *
 * ⚠ 스코어러를 재구현하지 않는다. dist/memoryRelevance.js 의 **실제 앱 코드**를 import 한다
 *   (v0.7.20→0.7.36 에서 test-context-meter 미러가 앱과 갈라졌던 사고 재발 방지).
 *
 * 이 게이트가 공허하지 않다는 증거: [NC] 음성 대조에서 구 스코어러(v1)로 채점하면
 * 임계를 **실제로 통과하지 못해야** 한다. 통과하면 판별력이 없다는 뜻이므로 실패 처리한다.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  scorePitfalls, scorePitfallsV2, buildV2Index, buildQueryGroups,
  selectPitfallInjection, pitfallOneLiner, tokenizeForIndex,
  INJECT_FULL_K, INJECT_INDEX_K, TRIGGERED_BODY_MAX_CHARS,
} from "./dist/memoryRelevance.js";

const RECALL_MIN = 0.80;        // 실측 92.3% 기준, 코퍼스 변동 여유 12pp
const BUDGET_MAX_BYTES = 24 * 1024;
const MEMORY_DIR = path.join(os.homedir(), ".kda", "memory");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`✅ ${m}`); } else { fail++; console.log(`❌ ${m}`); } };

// ── 1. 합성 단위검사: n-gram 중복 가산 차단 ──────────────────────────
{
  const groups = buildQueryGroups("설치본에 반영됐는지");
  const hangul = groups.filter((g) => g.kind === "k");
  ok(hangul.length === 2, `한글 어절 2개가 그룹 2개로 묶인다 (실제 ${hangul.length})`);
  ok(hangul[0].toks.length > 1, "그룹 하나가 여러 n-gram 후보를 갖는다 (그중 1개만 채점)");
  // 같은 단어가 반복돼도 증거는 1개다 (중복 가산 금지)
  const enDup = buildQueryGroups("ripgrep ripgrep ripgrep").filter((g) => g.kind === "e");
  ok(enDup.length === 1, `반복된 영문 단어는 1그룹으로 합쳐진다 (실제 ${enDup.length})`);
  // 서로 다른 단어는 각각 독립 증거 ("grep" 은 4글자라 최소길이를 통과한다 — 제외 대상 아님)
  const enTwo = buildQueryGroups("ripgrep grep").filter((g) => g.kind === "e");
  ok(enTwo.length === 2, `서로 다른 영문 단어는 각각 1그룹 (실제 ${enTwo.length})`);
  // 3글자 이하는 인덱싱 제외 → 그룹 0
  const enShort = buildQueryGroups("rg ls cd").filter((g) => g.kind === "e");
  ok(enShort.length === 0, `3글자 이하 영문은 그룹이 생기지 않는다 (실제 ${enShort.length})`);
}

// ── 2. 토크나이저: 영문 토큰 경계 ─────────────────────────────────
{
  const t = tokenizeForIndex("large energy");
  ok(!t.has("e:rg"), "'large'/'energy' 가 'rg' 로 부분매치되지 않는다 (경계 매칭)");
  ok(t.has("e:large"), "'large' 는 단어로 인덱싱된다");
}

// ── 3. 실데이터 회상 + 음성 대조 ───────────────────────────────────
if (!existsSync(MEMORY_DIR)) {
  console.log(`⏭  ${MEMORY_DIR} 없음 — 실데이터 검사 skip (합성 검사만 채점)`);
} else {
  const cands = readdirSync(MEMORY_DIR)
    .filter((f) => f.startsWith("pitfall_") && f.endsWith(".md"))
    .map((f) => ({ file: f, body: readFileSync(path.join(MEMORY_DIR, f), "utf8") }));
  const golden = JSON.parse(readFileSync(new URL("./memory-golden.json", import.meta.url), "utf8"));
  const idx = buildV2Index(cands);

  const run = (scorer) => {
    let hit = 0, tot = 0, worst = 0;
    for (const g of golden.cases) {
      const q = `${g.query}\n${g.context}`;
      let covered;
      if (scorer === "v2") {
        const sel = selectPitfallInjection(cands, q, idx);
        covered = [...sel.full, ...sel.index].map((s) => s.file);
        const bb = sel.full.reduce((n, s) => {
          const b = (cands.find((c) => c.file === s.file)?.body ?? "")
            .replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
          return n + Math.min(b.length, TRIGGERED_BODY_MAX_CHARS) + 80;
        }, 0);
        const ib = sel.index.reduce((n, s) =>
          n + pitfallOneLiner(cands.find((c) => c.file === s.file)?.body ?? "").length + s.file.length + 8, 0) + 300;
        worst = Math.max(worst, bb + ib);
      } else {
        // 음성 대조: 구 v1 은 사용자 메시지만 보고, 같은 개수(FULL+INDEX)만큼 가져간다.
        covered = scorePitfalls(cands, g.query)
          .slice(0, INJECT_FULL_K + INJECT_INDEX_K).map((s) => s.file);
      }
      for (const e of g.expect) {
        if (!cands.some((c) => c.file === e)) continue;
        tot++;
        if (covered.includes(e)) hit++;
      }
    }
    return { recall: tot ? hit / tot : 0, hit, tot, worst };
  };

  const v2 = run("v2");
  const v1 = run("v1");

  console.log(`   코퍼스 ${cands.length}개 / 골든 ${golden.cases.length}케이스 ${v2.tot}항목 / FULL_K=${INJECT_FULL_K} INDEX_K=${INJECT_INDEX_K}`);
  ok(v2.recall >= RECALL_MIN,
    `recall ${(v2.recall * 100).toFixed(1)}% (${v2.hit}/${v2.tot}) >= 기준 ${(RECALL_MIN * 100).toFixed(0)}%`);
  ok(v2.worst <= BUDGET_MAX_BYTES,
    `주입 예산 최대 ${(v2.worst / 1024).toFixed(1)}KB <= ${BUDGET_MAX_BYTES / 1024}KB`);
  // [NC] 음성 대조 — 이게 통과해버리면 위 검사는 아무것도 증명하지 못한다.
  ok(v1.recall < RECALL_MIN,
    `[NC] 구 스코어러(v1)는 같은 기준에서 실패해야 한다 → v1 recall ${(v1.recall * 100).toFixed(1)}% (${v1.hit}/${v1.tot})`);
}

console.log("─".repeat(60));
console.log(`결과: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
