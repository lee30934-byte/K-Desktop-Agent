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
import { fileURLToPath, pathToFileURL } from "node:url";

// ⚠ 이 테스트는 **빌드 산출물(dist)** 에 의존한다 — 소스 정적 검사가 아니다.
//   앱이 실제로 쓰는 구현을 그대로 import 해야 미러 드리프트가 안 생기기 때문이다.
//   그런데 CI 의 fast 게이트는 `Build sidecar` **이전**에 돌아서 dist 가 없다.
//   정적 import 로 두면 ERR_MODULE_NOT_FOUND 로 죽어 게이트 전체가 FAIL 한다
//   (2026-09-23 v0.7.37 빌드 실패 실측 원인).
//   → test-conv-routing.mjs 와 같은 규약: dist 없으면 **SKIP(exit 0)**, 빌드 뒤
//     post-build 게이트가 같은 파일을 다시 돌려 실측한다.
//   조건은 `--fast` 가 아니라 **dist 존재 여부**다. CI 는 두 게이트 호출 모두 --fast 라,
//   --fast 로 거르면 이 테스트가 CI 에서 영영 안 돌아 공허한 게이트가 된다.
const DIST = fileURLToPath(new URL("./dist/memoryRelevance.js", import.meta.url));
if (!existsSync(DIST)) {
  console.log("⏭️  전체 SKIP — sidecar/dist/memoryRelevance.js 없음 (npm run build 선행 필요)");
  console.log(`      ${DIST}`);
  console.log("      빌드 후 post-build 게이트에서 실측된다 (release.yml: Release gate (post-build)).");
  console.log("결과: 0 통과 / 0 실패 (총 0, 전체 SKIP — dist 의존)");
  process.exit(0);
}
const {
  scorePitfalls, scorePitfallsV2, buildV2Index, buildQueryGroups,
  selectPitfallInjection, pitfallOneLiner, tokenizeForIndex,
  INJECT_FULL_K, INJECT_INDEX_K, TRIGGERED_BODY_MAX_CHARS, buildWorkContextQuery,
} = await import(pathToFileURL(DIST).href);

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
  // 서로 다른 단어는 각각 독립 증거
  const enTwo = buildQueryGroups("ripgrep grep").filter((g) => g.kind === "e");
  ok(enTwo.length === 2, `서로 다른 영문 단어는 각각 1그룹 (실제 ${enTwo.length})`);
  // ★ 3글자 명령어가 살아남아야 한다 — 최소길이 4 시절 'git'/'npm' 이 통째로 탈락해
  //   작업문맥을 붙여도 git 함정이 안 뜨던 결함(2026-09-23 실측, 순위 56위)의 회귀 방지.
  const enCmd = buildQueryGroups("git npm ssh").filter((g) => g.kind === "e");
  ok(enCmd.length === 3, `3글자 명령어 git/npm/ssh 가 전부 인덱싱된다 (실제 ${enCmd.length}/3)`);
  ok(tokenizeForIndex("git commit").has("e:git"), "'git' 이 문서 인덱스에도 들어간다");
  // 2글자 이하는 여전히 제외 (최소길이 3)
  const enShort = buildQueryGroups("ls cd mv").filter((g) => g.kind === "e");
  ok(enShort.length === 0, `2글자 영문은 그룹이 생기지 않는다 (실제 ${enShort.length})`);
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

// ── 4. 작업 문맥 배선 (Phase 149 ②) ────────────────────────────────
// K 의 메시지는 "추천대로"/"진행해"처럼 내용어가 0개인 경우가 잦다.
// 그런 턴에 직전 도구 호출이 질의에 합쳐지는지, 그리고 그게 **실제로 회상을 늘리는지** 잰다.
{
  const hist = [
    { role: "user", content: "추천대로" },
    { role: "tool", toolName: "Bash", toolInput: { command: "git add CHANGELOG.md && git commit -F-", description: "Commit" } },
    { role: "tool", toolName: "Bash", toolInput: { command: "npm run build" } },
  ];
  const wc = buildWorkContextQuery(hist);
  ok(wc.includes("git commit"), "도구 인자(command)가 작업문맥에 들어간다");
  ok(!wc.includes("추천대로"), "사용자 메시지는 작업문맥에 중복 포함되지 않는다");
  ok(buildWorkContextQuery(undefined) === "", "히스토리 없으면 빈 문자열 (하위호환)");
  // 도구 출력은 IDF 를 오염시키므로 제외해야 한다
  const wc2 = buildWorkContextQuery([
    { role: "tool", toolName: "Bash", toolInput: { command: "ls" }, toolOutput: "ZZUNIQUEOUTPUT" },
  ]);
  ok(!wc2.includes("ZZUNIQUEOUTPUT"), "도구 출력은 작업문맥에서 제외된다");

  if (existsSync(MEMORY_DIR)) {
    const cands = readdirSync(MEMORY_DIR)
      .filter((f) => f.startsWith("pitfall_") && f.endsWith(".md"))
      .map((f) => ({ file: f, body: readFileSync(path.join(MEMORY_DIR, f), "utf8") }));
    const idx = buildV2Index(cands);
    const want = [
      "pitfall_git_commit_only_arg_order.md",
      "pitfall_git_add_preexisting_dirty_file.md",
      "pitfall_git_commit_only_untracked_requires_add.md",
    ].filter((w) => cands.some((c) => c.file === w));
    const cover = (q) => {
      const s = selectPitfallInjection(cands, q, idx);
      const cov = [...s.full, ...s.index].map((x) => x.file);
      return want.filter((w) => cov.includes(w)).length;
    };
    const withCtx = cover(`추천대로\n${wc}`);
    const noCtx = cover("추천대로");
    ok(withCtx >= want.length,
      `내용어 없는 메시지라도 작업문맥이 있으면 git 함정 ${want.length}건이 전부 노출 (실제 ${withCtx}/${want.length})`);
    // [NC] 문맥이 없으면 못 찾아야 한다 — 같으면 이 배선은 아무것도 안 한 것이다.
    ok(noCtx < withCtx,
      `[NC] 작업문맥 없이는 덜 찾아야 한다 → 문맥없음 ${noCtx} < 문맥있음 ${withCtx}`);
  }
}

console.log("─".repeat(60));
console.log(`결과: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
