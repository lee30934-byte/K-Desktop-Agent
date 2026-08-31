#!/usr/bin/env node
/**
 * Phase 145 — 대화창 오염(응답이 다른 대화창에 저장됨) 상주 탐지기.
 *
 * 코드는 고쳤지만(sidecar 스탬프 + 폴백 제거 + 워치독 clear 제거), "정말 안 새는가" 는
 * 코드가 아니라 **저장된 결과**로 확인해야 한다. 이 스크립트가 그 확인 수단이다.
 *
 * ── 탐지 원리 ────────────────────────────────────────────────────────────
 * 하나의 turn 은 하나의 대화에만 속해야 한다. KDA 는 turn id 를 messages.id 의
 * prefix 로 쓴다 (assistant = `{turnId}`, tool = `{turnId}-tool-{toolId}`,
 * 오케스트레이션 카드 = `{turnId}-orch-{engine}`). 따라서 같은 turn 에서 나온
 * 행들이 **서로 다른 conversation_id** 에 흩어져 있으면 그건 라우팅 사고다.
 *
 * 정상 동작에서는 이런 분할이 나올 수 없다 — 오탐이 거의 없는 강한 신호.
 *
 * ── 사용법 ───────────────────────────────────────────────────────────────
 *   node scripts/detect-conv-contamination.mjs                 # 최근 14일
 *   node scripts/detect-conv-contamination.mjs --days 90
 *   node scripts/detect-conv-contamination.mjs --all
 *   node scripts/detect-conv-contamination.mjs --db <경로>
 *   node scripts/detect-conv-contamination.mjs --json          # 기계 판독용
 *
 * 종료 코드: 0 = 오염 없음, 3 = 오염 검출, 1 = 실행 실패.
 * → 릴리스 게이트/스케줄에 그대로 물릴 수 있다.
 *
 * ── 안전 ─────────────────────────────────────────────────────────────────
 * **읽기 전용.** 원본 DB 를 열지 않고 임시 사본을 떠서 조회한다 (KDA 가 켜져 있어도
 * 안전, 잠금·손상 위험 없음). 어떤 경우에도 수정/삭제하지 않는다.
 * 이미 오염된 과거 행의 복구는 이 스크립트의 일이 아니다 — 사람이 판단할 문제다.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// node:sqlite (Node 22+ 내장). 외부 sqlite3 CLI 설치를 요구하지 않는다 —
// 이 PC 엔 sqlite3.exe 가 없어서 CLI 판이 즉시 실패했다(2026-08-31 실측).
process.removeAllListeners("warning"); // ExperimentalWarning 소음 제거
let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  console.error("오류: node:sqlite 사용 불가 (Node 22+ 필요). node -v 확인.");
  process.exit(1);
}

const argv = process.argv.slice(2);
function argOf(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const asJson = argv.includes("--json");
const scanAll = argv.includes("--all");
const days = Number(argOf("--days", "14"));
const dbPath = argOf("--db", path.join(os.homedir(), ".kda", "conversations.db"));

function die(msg) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(`오류: ${msg}`);
  process.exit(1);
}

if (!existsSync(dbPath)) die(`DB 없음: ${dbPath}`);

// 읽기 전용 보장: 사본에서만 조회.
//
// ★ 사본은 반드시 `VACUUM INTO` 로 뜬다. conversations.db 는 WAL 모드라
//   `.db` 만 파일복사하면 아직 체크포인트되지 않은 -wal 의 최신 행이 통째로 빠진다.
//   2026-08-31 실측: 오염 214행을 실제로 복구한 직후에도 이 스캐너는 계속 13건을
//   보고했다(사본이 복구 전 상태였음). 최신 오염을 놓치는 방향으로도 똑같이 틀린다.
//   VACUUM INTO 는 원본에 쓰지 않으므로 읽기 전용 보장은 그대로 유지된다.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "kda-convscan-"));
const roDb = path.join(tmpDir, "ro.db");
try {
  const src = new DatabaseSync(dbPath, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${roDb.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
} catch (e) {
  // VACUUM INTO 가 막힌 환경(락 경합 등)에서는 파일복사로 폴백하되,
  // WAL 이 남아 있으면 결과가 낡을 수 있음을 알린다.
  try {
    rmSync(roDb, { force: true });
    copyFileSync(dbPath, roDb);
    if (!asJson && existsSync(`${dbPath}-wal`)) {
      console.error(`경고: VACUUM INTO 실패(${e}) — 파일복사로 폴백. -wal 미반영으로 결과가 낡을 수 있음.`);
    }
  } catch (e2) {
    rmSync(tmpDir, { recursive: true, force: true });
    die(`DB 사본 생성 실패: ${e2}`);
  }
}

const sinceMs = scanAll ? 0 : Date.now() - days * 24 * 60 * 60 * 1000;

// turn id = messages.id 에서 `-tool-…` / `-orch-…` 접미사를 벗긴 값.
// 그 turn 에 걸린 서로 다른 conversation_id 가 2개 이상이면 오염.
const SQL = `
WITH t AS (
  SELECT
    CASE
      WHEN instr(id, '-tool-') > 0 THEN substr(id, 1, instr(id, '-tool-') - 1)
      WHEN instr(id, '-orch-') > 0 THEN substr(id, 1, instr(id, '-orch-') - 1)
      ELSE id
    END AS turn_id,
    conversation_id,
    timestamp,
    role
  FROM messages
  WHERE timestamp >= ${sinceMs}
)
SELECT turn_id AS turnId,
       COUNT(DISTINCT conversation_id) AS convCount,
       COUNT(*) AS rowCount,
       MIN(timestamp) AS firstTs,
       MAX(timestamp) AS lastTs,
       group_concat(DISTINCT conversation_id) AS convList
FROM t
GROUP BY turn_id
HAVING convCount > 1
ORDER BY lastTs DESC;
`;

let raw;
try {
  const db = new DatabaseSync(roDb, { readOnly: true });
  raw = db.prepare(SQL).all();
  db.close();
} catch (e) {
  rmSync(tmpDir, { recursive: true, force: true });
  die(`조회 실패: ${e}`);
}
rmSync(tmpDir, { recursive: true, force: true });

const rows = raw.map((r) => ({
  turnId: String(r.turnId),
  convCount: Number(r.convCount),
  rowCount: Number(r.rowCount),
  firstTs: Number(r.firstTs),
  lastTs: Number(r.lastTs),
  spanMin: Math.round((Number(r.lastTs) - Number(r.firstTs)) / 60000),
  conversations: String(r.convList || "").split(","),
}));

const scope = scanAll ? "전체 기간" : `최근 ${days}일`;

if (asJson) {
  console.log(JSON.stringify({
    ok: true, db: dbPath, scope, contaminated: rows.length, turns: rows,
  }, null, 2));
} else {
  console.log(`대화창 오염 스캔 — ${scope}`);
  console.log(`DB: ${dbPath} (읽기 전용 사본 조회)\n`);
  if (rows.length === 0) {
    console.log("✅ 한 turn 의 메시지가 두 대화에 걸친 사례 없음.");
  } else {
    console.log(`❌ 오염 turn ${rows.length}건:\n`);
    for (const r of rows) {
      const when = new Date(r.lastTs).toLocaleString("sv-SE");
      console.log(`  turn ${r.turnId}`);
      console.log(`    시각 ${when} / 턴 길이 약 ${r.spanMin}분 / 행 ${r.rowCount}개`);
      console.log(`    대화 ${r.convCount}개: ${r.conversations.join(" , ")}`);
      // 12분(STREAM_FORCE_UNLOCK_MS)을 넘긴 턴은 Phase 145 이전의 워치독 경로가 원인.
      if (r.spanMin >= 12) console.log(`    ↳ 12분 초과 — Phase 145 이전 워치독 clear 경로의 전형`);
      console.log("");
    }
    console.log("복구(행 재귀속)는 자동으로 하지 않습니다 — K 의 판단이 필요합니다.");
  }
}

process.exit(rows.length > 0 ? 3 : 0);
