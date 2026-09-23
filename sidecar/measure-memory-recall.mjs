/**
 * Phase 149 — 메모리 회상(recall) 실측 하네스.
 *
 * 목적: "관련 함정이 실제로 주입되는가"를 **주장이 아니라 숫자로** 재기 위한 진단 도구.
 * 게이트가 아니다 (게이트는 test-memory-relevance.mjs). 이 파일은 baseline 측정 + 개선 전후 비교용.
 *
 * ⚠ 스코어러를 여기에 재구현하지 않는다. dist/memoryRelevance.js 의 **실제 앱 코드**를 import 한다.
 *    (test-context-meter 미러 드리프트 재발 방지.)
 *
 * 사용:
 *   node measure-memory-recall.mjs            # 골든셋 전체 측정
 *   node measure-memory-recall.mjs --case 3   # 특정 케이스 상세(히트 키워드까지)
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  scorePitfalls,
  scorePitfallsV2,
  buildV2Index,
  MAX_TRIGGERED_PITFALLS,
} from "./dist/memoryRelevance.js";

// --v2 로 개선 스코어러 측정, 기본은 baseline(v1)
const USE_V2 = process.argv.includes("--v2");

const MEMORY_DIR = path.join(os.homedir(), ".kda", "memory");

/**
 * 골든셋 — "이 상황에서는 이 함정 본문이 주입됐어야 한다".
 *
 * 라벨링 원칙 (사후합리화 금지):
 *   - expect 에 적은 함정은 **그 턴에서 실제로 밟았거나 밟을 뻔한 것**만 적는다.
 *   - 대부분 2026-09-23 세션에서 실제로 일어난 일에서 가져왔다 (query 는 당시 사용자 메시지 원문).
 *   - "있으면 좋은" 함정은 넣지 않는다. 넣으면 recall 이 인위적으로 낮아져 개선폭이 부풀려진다.
 */
const GOLDEN = [
  {
    id: 1,
    note: "2026-09-23 실제: 'grep -r 0건'을 '없음'의 증거로 썼다가 오보",
    query: "추천대로",
    context: "git 커밋, ripgrep 탐색, 의존성 확인 작업 중",
    expect: ["pitfall_rg_missing_explicit_path.md"],
  },
  {
    id: 2,
    note: "2026-09-23 실제: sidecar 의존성을 안 읽고 sqlite 가 있다고 단정",
    query: "kda 에 추가할만한 스킬이나 기능들을 찾아서 알려줄래 고도화 하려고",
    context: "설계 문서 작성 중 신규 의존성 제안",
    expect: [
      "pitfall_new_test_runtime_dependency_breaks_ci_gate.md",
      "pitfall_av_blocks_bundled_native_binary.md",
    ],
  },
  {
    id: 3,
    note: "커밋 시 인자 순서/스테이징 함정",
    query: "이 변경사항 커밋해줘",
    context: "git commit",
    expect: [
      "pitfall_git_commit_only_arg_order.md",
      "pitfall_git_add_preexisting_dirty_file.md",
      "pitfall_git_commit_only_untracked_requires_add.md",
    ],
  },
  {
    id: 4,
    note: "릴리즈 요청 — 태그/게이트/버전 동기화",
    query: "릴리즈 진행하자",
    context: "태그 push → Actions 서명 빌드",
    expect: [
      "pitfall_release_artifact_source_drift_vacuous_version_gate.md",
      "pitfall_release_terminal_contract_postbuild_20260910.md",
    ],
  },
  {
    id: 5,
    note: "PowerShell 로 원격 명령 — 인자 인용 함정",
    query: "5080 꺼줘",
    context: "shutdown-5080.ps1 → ssh native exe 인자 전달",
    expect: ["pitfall_powershell_native_arg_quote.md"],
  },
  {
    id: 6,
    note: "장기 작업 감시 등록",
    query: "빌드 오래 걸리니까 끝나면 이어서 해줘",
    context: "task-watch 마커 작성",
    expect: [
      "pitfall_taskwatch_marker_path_guessed_not_verified_20260922.md",
      "pitfall_taskwatch_conversationid_env_vs_savepath_mismatch.md",
    ],
  },
  {
    id: 7,
    note: "설치본 확인 — WebView2 캐시 stale",
    query: "설치본에 반영됐는지 확인해줘",
    context: "버전 표시 확인",
    expect: ["pitfall_webview2_cache_stale_after_update.md"],
  },
  {
    id: 8,
    note: "테스트가 통과했다는 보고 — 공허한 게이트 경계",
    query: "테스트 다 통과했어?",
    context: "게이트 판정",
    expect: ["pitfall_vacuous_gates_and_substring_state_checks.md"],
  },
];

function loadCandidates() {
  if (!existsSync(MEMORY_DIR)) {
    console.error(`메모리 디렉터리 없음: ${MEMORY_DIR}`);
    process.exit(2);
  }
  const files = readdirSync(MEMORY_DIR).filter(
    (f) => f.startsWith("pitfall_") && f.endsWith(".md"),
  );
  return files.map((f) => ({
    file: f,
    body: readFileSync(path.join(MEMORY_DIR, f), "utf8"),
  }));
}

let V2INDEX = null;
function score(candidates, query) {
  if (!USE_V2) return scorePitfalls(candidates, query);
  if (!V2INDEX) V2INDEX = buildV2Index(candidates);
  // 쿼리에 문맥(진행 중 작업) 신호를 합친다 — Phase 149 의 핵심 변경점 중 하나.
  return scorePitfallsV2(candidates, query, V2INDEX);
}

function measure(candidates, g) {
  const scored = score(candidates, USE_V2 ? `${g.query}\n${g.context}` : g.query);
  const topK = scored.slice(0, MAX_TRIGGERED_PITFALLS).map((s) => s.file);
  const present = g.expect.filter((e) => candidates.some((c) => c.file === e));
  const missingFromDisk = g.expect.filter((e) => !candidates.some((c) => c.file === e));
  const hit = present.filter((e) => topK.includes(e));
  return {
    scoredCount: scored.length,
    topK,
    present,
    missingFromDisk,
    hit,
    recall: present.length === 0 ? null : hit.length / present.length,
    ranks: Object.fromEntries(
      present.map((e) => {
        const i = scored.findIndex((s) => s.file === e);
        return [e, i < 0 ? null : i + 1];
      }),
    ),
  };
}

const candidates = loadCandidates();
const caseArg = process.argv.indexOf("--case");
const only = caseArg >= 0 ? Number(process.argv[caseArg + 1]) : null;

console.log(`메모리: ${MEMORY_DIR}`);
console.log(`pitfall 파일: ${candidates.length}개 / top-K = ${MAX_TRIGGERED_PITFALLS}`);
console.log("─".repeat(70));

let totalPresent = 0;
let totalHit = 0;
const rows = [];

for (const g of GOLDEN) {
  if (only !== null && g.id !== only) continue;
  const m = measure(candidates, g);
  totalPresent += m.present.length;
  totalHit += m.hit.length;
  rows.push({ g, m });

  const pct = m.recall === null ? "n/a" : `${(m.recall * 100).toFixed(0)}%`;
  console.log(
    `[${g.id}] recall ${String(pct).padStart(4)}  (${m.hit.length}/${m.present.length})  후보 ${String(m.scoredCount).padStart(3)}개 득점  | ${g.note}`,
  );
  if (m.missingFromDisk.length) {
    console.log(`     ⚠ 디스크에 없는 기대파일(라벨 오류): ${m.missingFromDisk.join(", ")}`);
  }
  for (const [f, r] of Object.entries(m.ranks)) {
    const mark = r !== null && r <= MAX_TRIGGERED_PITFALLS ? "✅" : "❌";
    console.log(`     ${mark} ${f} → 순위 ${r === null ? "미득점" : r}`);
  }
  if (only !== null) {
    console.log(`\n  top-${MAX_TRIGGERED_PITFALLS} 실제 선택:`);
    const scored = score(candidates, USE_V2 ? `${g.query}
${g.context}` : g.query).slice(0, MAX_TRIGGERED_PITFALLS);
    for (const s of scored) {
      console.log(
        `    ${String(s.score).padStart(2)}점  ${s.file}\n         hits: exp=[${s.hits.explicit}] der=[${s.hits.derived}] kor=[${s.hits.korean}]`,
      );
    }
  }
}

console.log("─".repeat(70));
const overall = totalPresent === 0 ? 0 : totalHit / totalPresent;
console.log(
  `종합 recall@top${MAX_TRIGGERED_PITFALLS} = ${(overall * 100).toFixed(1)}%  (${totalHit}/${totalPresent})`,
);
