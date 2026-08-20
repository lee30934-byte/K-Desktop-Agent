#!/usr/bin/env node
/**
 * Phase 147 (v0.7.25) — 메모리 주입 예산 회귀 테스트.
 *
 * 막으려는 회귀 (실제로 발생했던 것):
 *   pitfall 인덱스와 lee-profile 은 "절대 drop 되지 않는 fixed 블록"인데 길이 제한이 없었다.
 *   pitfall_*.md 가 177개까지 늘자 인덱스만 26,507자를 먹고, lee-profile(3,999자)과 합쳐
 *   32,768 cap 의 93%를 점유 → droppable 섹션 예산이 1,562자만 남았다.
 *   그 결과 Phase 142 의 "현재 메시지 관련 pitfall 본문 주입"(본문 2~16KB)이
 *   **구조적으로 단 한 번도 발동하지 못한 채** 매 턴 33~37개 섹션이 통째로 drop 됐다.
 *
 * 이 테스트는 상수를 하드코딩하지 않고 src/index.ts 에서 파싱한다 (SSOT).
 * 종료 코드: 0 = 전부 통과, 1 = 하나라도 FAIL. WARN 은 통과로 친다.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "src", "index.ts");
const src = readFileSync(SRC, "utf-8");

let pass = 0;
let fail = 0;
let warn = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  OK   ${name}${detail ? "  — " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`);
  }
}
function warnIf(name, cond, detail = "") {
  if (cond) {
    warn++;
    console.log(`  WARN ${name}${detail ? "  — " + detail : ""}`);
  } else {
    pass++;
    console.log(`  OK   ${name}${detail ? "  — " + detail : ""}`);
  }
}

/** `const NAME = 32 * 1024;` / `const NAME = 700;` 형태를 숫자로 파싱. */
function constOf(name) {
  const m = src.match(new RegExp(`\\b${name}\\s*=\\s*([0-9_]+(?:\\s*\\*\\s*[0-9_]+)*)\\s*;`));
  if (!m) return null;
  return m[1]
    .split("*")
    .map((s) => Number(s.trim().replace(/_/g, "")))
    .reduce((a, b) => a * b, 1);
}

console.log("Phase 147 메모리 주입 예산 회귀 테스트\n");
console.log("[1] 상수 존재 및 산술 불변식");

const CAP = constOf("MEMORY_CONTEXT_HARD_CAP_BYTES");
const ENTRIES_MIN = constOf("MEMORY_ENTRIES_MIN_BUDGET");
const TRIG_RESERVE = constOf("MEMORY_TRIGGERED_RESERVE_MAX");
const IDX_MAX = constOf("PITFALL_INDEX_MAX_CHARS");
const IDX_MIN = constOf("PITFALL_INDEX_MIN_CHARS");
const IDX_HDR = constOf("PITFALL_INDEX_HEADER_CHARS");
const BODY_MAX = constOf("TRIGGERED_BODY_MAX_CHARS");
const HEADER_RESERVE = constOf("HEADER_RESERVE");

for (const [n, v] of Object.entries({
  MEMORY_CONTEXT_HARD_CAP_BYTES: CAP,
  MEMORY_ENTRIES_MIN_BUDGET: ENTRIES_MIN,
  MEMORY_TRIGGERED_RESERVE_MAX: TRIG_RESERVE,
  PITFALL_INDEX_MAX_CHARS: IDX_MAX,
  PITFALL_INDEX_MIN_CHARS: IDX_MIN,
  PITFALL_INDEX_HEADER_CHARS: IDX_HDR,
  TRIGGERED_BODY_MAX_CHARS: BODY_MAX,
  HEADER_RESERVE: HEADER_RESERVE,
})) {
  check(`상수 ${n} 파싱`, typeof v === "number" && v > 0, String(v));
}

if ([CAP, ENTRIES_MIN, TRIG_RESERVE, IDX_MAX, IDX_MIN, IDX_HDR, BODY_MAX, HEADER_RESERVE].some((v) => !v)) {
  console.log("\n상수 파싱 실패 — 이후 검사 중단");
  process.exit(1);
}

// 인덱스가 최대치를 먹어도 entries 최소 예산이 남아야 한다.
check(
  "인덱스 최대치 + entries 최소예산 + 헤더 <= cap",
  IDX_MAX + IDX_HDR + ENTRIES_MIN + HEADER_RESERVE <= CAP,
  `${IDX_MAX}+${IDX_HDR}+${ENTRIES_MIN}+${HEADER_RESERVE}=${IDX_MAX + IDX_HDR + ENTRIES_MIN + HEADER_RESERVE} <= ${CAP}`,
);
// entries 예산을 다 떼줘도 인덱스에 최소 몫은 남아야 한다 (음수 예산 방지).
check(
  "entries 최소예산 확보 후에도 인덱스 최소치 확보 가능",
  CAP - HEADER_RESERVE - ENTRIES_MIN - IDX_HDR >= IDX_MIN,
  `가용 ${CAP - HEADER_RESERVE - ENTRIES_MIN - IDX_HDR} >= ${IDX_MIN}`,
);
// TRIGGERED 예약은 entries 예산 안에 들어와야 한다 (다른 우선순위를 전부 굶기면 안 됨).
check("TRIGGERED 예약 <= entries 최소예산", TRIG_RESERVE <= ENTRIES_MIN, `${TRIG_RESERVE} <= ${ENTRIES_MIN}`);
// 잘린 본문 하나가 예약 전체를 먹지 않아야 8개 중 여러 개가 들어온다.
check("triggered 본문 상한 < TRIGGERED 예약", BODY_MAX < TRIG_RESERVE, `${BODY_MAX} < ${TRIG_RESERVE}`);

console.log("\n[2] 구조 — 4개 수정이 코드에 살아 있는가");

// 주의: parseMemoryFrontmatter 에도 slice(0, 200) 이 있으나 그쪽은 droppable 한 조건부
// 메모리 stub 용이라 fixed 블록 예산과 무관하다. 검사는 extractPitfallSummary 본문으로 한정한다.
const summaryFnStart = src.indexOf("function extractPitfallSummary(");
const summaryFnBody =
  summaryFnStart >= 0 ? src.slice(summaryFnStart, src.indexOf("\n}", summaryFnStart)) : "";
check(
  "① pitfall 요약 desc 트림이 가변 단계 (200자 고정 아님)",
  /const PITFALL_SUMMARY_DESC_STEPS = \[110,/.test(src) &&
    summaryFnBody.length > 0 &&
    !/slice\(0, 200\)/.test(summaryFnBody) &&
    /r\.desc\.slice\(0, limit\)/.test(summaryFnBody),
);
check(
  "② extractPitfallSummary 가 budget 인자를 받는다",
  /function extractPitfallSummary\(\s*memoryDir: string,\s*budget: number/.test(src),
);
check(
  "② 호출부가 파생 예산을 넘긴다 (인자 없는 호출 금지)",
  /extractPitfallSummary\(dir, pitfallIndexBudget\)/.test(src) && !/extractPitfallSummary\(dir\)/.test(src),
);
check(
  "② 예산이 MEMORY_ENTRIES_MIN_BUDGET 에서 파생된다",
  /pitfallIndexBudget = Math\.max\([\s\S]*?MEMORY_ENTRIES_MIN_BUDGET/.test(src),
);
check(
  "② 축약 시 slug 목록은 보존 (desc 만 버림)",
  /lines = raw\.map\(\(r\) => `- \*\*\[\$\{r\.slug\}\]\*\*`\)/.test(src),
);
check(
  "③ greedy 루프가 TRIGGERED 몫을 선점한다",
  /triggeredReserve/.test(src) &&
    /const reserve = isTriggered \? 0 : triggeredReserve;/.test(src) &&
    /used \+ cost \+ HEADER_RESERVE \+ reserve > MEMORY_CONTEXT_HARD_CAP_BYTES/.test(src),
);
check(
  "③ 드롭된 triggered 항목도 예약에서 차감 (과다 예약 방지)",
  /if \(isTriggered\) triggeredReserve = Math\.max\(0, triggeredReserve - cost\);[\s\S]{0,120}?const reserve =/.test(src),
);
check(
  "④ triggered 본문이 상한에서 잘리고 원문 read 안내가 붙는다",
  /stripped\.length > TRIGGERED_BODY_MAX_CHARS/.test(src) && /를 직접 read 하세요\.\]`/.test(src),
);

console.log("\n[3] 실제 데이터 — 현재 memory/ 로 예산이 성립하는가");

const memDir =
  process.env.KDA_MEMORY_DIR ?? path.join(os.homedir(), ".kda", "memory");

if (!existsSync(memDir)) {
  console.log(`  SKIP memory dir 없음: ${memDir}`);
} else {
  const files = readdirSync(memDir)
    .filter((f) => f.startsWith("pitfall_") && f.endsWith(".md"))
    .sort();

  // src/index.ts 의 렌더 규칙과 동일 (desc 첫 줄, STEPS[0] 자로 트림)
  const STEP0 = Number((src.match(/PITFALL_SUMMARY_DESC_STEPS = \[(\d+)/) ?? [])[1] ?? 110);
  let noDesc = 0;
  const lines = files.map((f) => {
    const body = readFileSync(path.join(memDir, f), "utf-8");
    const m = body.match(/^description:\s*(.+?)(?:\r?\n|$)/m);
    const slug = f.replace(/^pitfall_/, "").replace(/\.md$/, "");
    if (!m) {
      noDesc++;
      return `- **[${slug}]** (자세한 내용은 memory 의 ${f} 참조)`;
    }
    return `- **[${slug}]** ${m[1].trim().slice(0, STEP0)}`;
  });
  const idxLen = lines.join("\n").length;

  const leePath = path.join(path.dirname(memDir), "lee-profile.md");
  const leeLen = existsSync(leePath) ? readFileSync(leePath, "utf-8").length + 250 : 0;

  console.log(`  pitfall 파일 ${files.length}개, 인덱스 ${idxLen}자, lee-profile 블록 ${leeLen}자`);

  const derivedBudget = Math.max(IDX_MIN, Math.min(IDX_MAX, CAP - HEADER_RESERVE - leeLen - ENTRIES_MIN - IDX_HDR));
  const fixedLen = leeLen + Math.min(idxLen, derivedBudget) + IDX_HDR;
  const entriesBudget = CAP - HEADER_RESERVE - fixedLen;

  check(
    "fixed 블록 이후 entries 예산이 최소치 이상",
    entriesBudget >= ENTRIES_MIN,
    `entries 예산 ${entriesBudget} >= ${ENTRIES_MIN}`,
  );
  check(
    "triggered 본문 1개 이상이 실제로 들어갈 공간이 있다",
    entriesBudget >= BODY_MAX,
    `${entriesBudget} >= ${BODY_MAX}`,
  );
  warnIf(
    "인덱스가 무손실(트림 없이) 예산에 들어감",
    idxLen > derivedBudget,
    `인덱스 ${idxLen} vs 예산 ${derivedBudget}${idxLen > derivedBudget ? " → desc 자동 축약 발동 (동작은 정상, memory/ 정리 권장)" : ""}`,
  );
  warnIf(
    "description 누락 파일 없음",
    noDesc > 0,
    `누락 ${noDesc}개${noDesc > 0 ? " → 인덱스 한 줄이 회피책 대신 안내문으로 낭비됨" : ""}`,
  );
}

console.log(`\nResult: ${pass}/${pass + fail} passed, ${warn} warn`);
process.exit(fail > 0 ? 1 : 0);
